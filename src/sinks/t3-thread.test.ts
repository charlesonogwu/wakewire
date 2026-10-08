import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type T3Client, T3RegistrationSchema, T3ThreadAdapter } from "./t3-thread.js";
import { PermanentError, UnreachableError } from "./types.js";

const primary = "11111111-1111-4111-8111-111111111111";
const fallback = "22222222-2222-4222-8222-222222222222";
const opts = { sandbox: "workspace-write" as const, deliveryId: "delivery-one" };
const dirs: string[] = [];
const adapters: T3ThreadAdapter[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wakewire-t3-"));
  dirs.push(dir);
  const config = {
    threadIds: [primary, fallback],
    bridgePath: path.join(dir, "bridge.js"),
    stateFile: path.join(dir, "receipts.db"),
    inheritPermissions: true as const,
  };
  const threads = new Map(
    [primary, fallback].map((id) => [
      id,
      {
        id,
        session: { status: "idle" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        messages: [] as { id: string; role: string; text: string }[],
      },
    ]),
  );
  const accepted = new Set<string>();
  const client: T3Client = {
    probe: vi.fn(async () => ({})),
    environmentStatuses: vi.fn(async () => ({ environments: [{ reachable: true }] })),
    thread: vi.fn(async (id) => {
      const thread = threads.get(id);
      if (!thread)
        throw new Error(`No thread with id ${id} exists in any reachable T3 environment.`);
      return { thread, page: { hasMore: false } };
    }),
    dispatch: vi.fn(async (command) => {
      if (!accepted.has(command.commandId)) {
        accepted.add(command.commandId);
        threads.get(command.threadId)?.messages.push({
          id: command.message.messageId,
          role: "user",
          text: command.message.text,
        });
      }
      return { sequence: 1 };
    }),
  };
  const logger = pino({ level: "silent" });
  const info = vi.spyOn(logger, "info");
  const adapter = new T3ThreadAdapter(config, client, logger);
  adapters.push(adapter);
  const primaryThread = threads.get(primary);
  if (!primaryThread) throw new Error("Missing fixture primary");
  return { adapter, config, client, threads, primaryThread, accepted, info, logger };
}

describe("T3 thread delivery", () => {
  it("projects a marked message with inherited modes and no new thread support", async () => {
    const f = fixture();
    expect(f.adapter.supportsNewThreads).toBe(false);
    await expect(f.adapter.startThread()).rejects.toBeInstanceOf(PermanentError);
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).resolves.toEqual({
      threadId: primary,
    });
    expect(f.client.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: primary,
        deliveryMode: "after-current",
        runtimeMode: "approval-required",
        interactionMode: "plan",
        message: expect.objectContaining({ text: expect.stringContaining("delivery-one") }),
      }),
    );
    expect(f.info).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: primary }),
      expect.any(String),
    );
  });
  it("queues to a busy primary rather than using the fallback", async () => {
    const f = fixture();
    f.primaryThread.session.status = "running";
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).resolves.toEqual({
      threadId: primary,
    });
  });
  it("uses the first usable fallback when the primary session errored", async () => {
    const f = fixture();
    f.primaryThread.session.status = "error";
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).resolves.toEqual({
      threadId: fallback,
    });
  });
  it("holds when all sessions are errored", async () => {
    const f = fixture();
    for (const thread of f.threads.values()) thread.session.status = "error";
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );
    expect(f.client.dispatch).not.toHaveBeenCalled();
  });
  it("retries unreachable T3 and probes reachability without delivering", async () => {
    const f = fixture();
    vi.mocked(f.client.thread).mockRejectedValue(new Error("offline secret-token"));
    vi.mocked(f.client.probe).mockRejectedValue(new Error("offline secret-token"));
    expect(await f.adapter.probe()).toBe(false);
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).rejects.toThrow(
      /^Cannot reach T3/,
    );
    expect(f.client.dispatch).not.toHaveBeenCalled();
  });
  it("classifies unknown thread as permanent only with complete environment discovery", async () => {
    const f = fixture();
    f.threads.delete(primary);
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
    vi.mocked(f.client.environmentStatuses).mockResolvedValue({
      environments: [{ reachable: false }],
    });
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );
  });
  it("reconciles a lost response across restart, without sending to a recovered primary", async () => {
    const f = fixture();
    f.primaryThread.session.status = "error";
    const dispatch = f.client.dispatch;
    f.client.dispatch = vi.fn(async (command) => {
      await dispatch(command);
      throw new Error("lost response");
    });
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );
    await f.adapter.close();
    f.primaryThread.session.status = "idle";
    const restarted = new T3ThreadAdapter(f.config, f.client, f.logger);
    adapters.push(restarted);
    await expect(restarted.deliverToThread(primary, "hello", opts)).resolves.toEqual({
      threadId: fallback,
    });
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
  });
  it("retries the same durable command if dispatch failed before acceptance", async () => {
    const f = fixture();
    const dispatch = f.client.dispatch;
    f.client.dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockImplementation(dispatch);
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );
    await f.adapter.deliverToThread(primary, "hello", opts);
    const calls = vi.mocked(f.client.dispatch).mock.calls;
    expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
    expect(f.accepted.size).toBe(1);
  });
  it("finds the marker on an older page before retrying", async () => {
    const f = fixture();
    const dispatch = f.client.dispatch;
    f.client.dispatch = vi.fn(async (command) => {
      await dispatch(command);
      throw new Error("lost response");
    });
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );
    const thread = f.primaryThread;
    vi.mocked(f.client.thread).mockImplementation(async (_id, page) =>
      page?.beforeCursor
        ? { thread, page: { hasMore: false } }
        : { thread: { ...thread, messages: [] }, page: { hasMore: true, beforeCursor: "older" } },
    );
    await f.adapter.deliverToThread(primary, "hello", opts);
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
  });
  it("rejects changed content and unregistered routes", async () => {
    const f = fixture();
    await f.adapter.deliverToThread(primary, "hello", opts);
    await expect(f.adapter.deliverToThread(primary, "changed", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
    await expect(f.adapter.deliverToThread(fallback, "hello", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
    await expect(
      f.adapter.deliverToThread(primary, "hello", { ...opts, sandbox: "read-only" }),
    ).rejects.toBeInstanceOf(PermanentError);
  });
  it("waits for projection and retries an accepted but still unprojected command without duplication", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const dispatch = f.client.dispatch;
    f.client.dispatch = vi.fn(async (command) => {
      await dispatch(command);
      return { sequence: 1 };
    });
    const read = f.client.thread;
    let visible = false;
    f.client.thread = vi.fn(async (id, options) => {
      const snapshot = (await read(id, options)) as {
        thread: { messages: unknown[] };
        page: { hasMore: boolean };
      };
      return visible ? snapshot : { ...snapshot, thread: { ...snapshot.thread, messages: [] } };
    });
    const pending = expect(
      f.adapter.deliverToThread(primary, "hello", opts),
    ).rejects.toBeInstanceOf(UnreachableError);
    await vi.runAllTimersAsync();
    await pending;
    const retry = f.adapter.deliverToThread(primary, "hello", opts);
    // Let the duplicate command be replayed while projection is still lagging.
    await vi.advanceTimersByTimeAsync(250);
    visible = true;
    await vi.runAllTimersAsync();
    await expect(retry).resolves.toEqual({ threadId: primary });
    expect(f.accepted.size).toBe(1);
    expect(f.client.dispatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.client.dispatch).mock.calls[0]).toEqual(
      vi.mocked(f.client.dispatch).mock.calls[1],
    );
  });
  it("concurrent owners use a single durable command", async () => {
    const f = fixture();
    const second = new T3ThreadAdapter(f.config, f.client, f.logger);
    adapters.push(second);
    await Promise.all([
      f.adapter.deliverToThread(primary, "hello", opts),
      second.deliverToThread(primary, "hello", opts),
    ]);
    expect(f.accepted.size).toBe(1);
    expect(f.primaryThread.messages).toHaveLength(1);
  });
  it("does not confuse an assistant-quoted marker with a projected user message", async () => {
    const f = fixture();
    f.primaryThread.messages.push({
      id: "assistant",
      role: "assistant",
      text: '[wakewire-delivery:"delivery-one"]\n\nhello',
    });
    await f.adapter.deliverToThread(primary, "hello", opts);
    expect(f.client.dispatch).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched read identity and malformed pagination", async () => {
    const f = fixture();
    const thread = f.primaryThread;
    vi.mocked(f.client.thread).mockResolvedValue({ thread: { ...thread, id: fallback } });
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
    vi.mocked(f.client.thread).mockResolvedValue({ thread, page: { hasMore: true } });
    await expect(f.adapter.deliverToThread(primary, "hello", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );
    expect(f.client.dispatch).not.toHaveBeenCalled();
  });
  it("rejects invalid registration, duplicate targets, extra keys and relative paths", () => {
    const f = fixture();
    expect(T3RegistrationSchema.safeParse(f.config).success).toBe(true);
    for (const invalid of [
      { threadIds: [] },
      { threadIds: [primary, primary] },
      { threadIds: ["unknown"] },
      { bridgePath: "relative.js" },
      { stateFile: "relative.db" },
      { inheritPermissions: false },
      { token: "forbidden" },
    ]) {
      expect(T3RegistrationSchema.safeParse({ ...f.config, ...invalid }).success).toBe(false);
    }
  });
});
