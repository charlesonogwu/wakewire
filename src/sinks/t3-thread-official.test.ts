import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { T3ExpiryMonitor } from "./t3-expiry.js";
import { T3AuthRequiredError } from "./t3-official-mcp.js";
import { T3ThreadAdapter, type T3ToolClient, t3ClientRequestId } from "./t3-thread.js";
import { BusyError, PermanentError, UnreachableError } from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const opts = { sandbox: "workspace-write" as const, deliveryId: "delivery-one" };
const dirs: string[] = [];
const adapters: T3ThreadAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const packed = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

/** Fake of T3 Code's own MCP shapes behind the logical calls. */
function fixture(options: { expiresAt?: string | null; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(path.join(os.tmpdir(), "wakewire-t3-official-"));
  if (!options.dir) dirs.push(dir);
  const primary = { threadId: "primary", environmentId: "local", projectId: "project-1", cwd: dir };
  const fallback = {
    threadId: "orchestrator",
    environmentId: "local",
    projectId: "project-1",
    cwd: dir,
  };
  const threads = new Map(
    [primary, fallback].map((t) => [
      t.threadId,
      {
        threadId: t.threadId,
        projectId: t.projectId,
        status: "idle",
        archived: false,
        settled: false,
        pendingRequestCount: 0,
        itemCount: 10,
      },
    ]),
  );
  const items: { type: string; text: string }[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let sendFailure: Error | null = null;
  let readFailure: Error | null = null;
  const client: T3ToolClient = {
    dialect: "official",
    ...(options.expiresAt !== undefined ? { tokenExpiresAt: () => options.expiresAt ?? null } : {}),
    async call(name, args) {
      calls.push({ name, args });
      if (readFailure) throw readFailure;
      if (name === "get_thread")
        return packed({
          thread: threads.get(String(args.threadId)),
          items: args.limit === 1 ? [] : items,
          nextPosition: null,
          hasMore: false,
        });
      if (name === "list_projects")
        return packed({ projects: [{ id: "project-1", workspaceRoot: dir }], nextCursor: null });
      if (name === "list_threads")
        return packed({
          threads: [...threads.values()]
            .filter((t) => t.settled === args.settled)
            .map((t) => ({ threadId: t.threadId })),
        });
      if (name === "send_message") {
        if (sendFailure) throw sendFailure;
        items.push({ type: "user_message", text: String(args.message) });
        return packed({ threadId: args.threadId, accepted: true });
      }
      throw new Error("Unexpected tool");
    },
    close: vi.fn(),
  };
  const logger = pino({ level: "silent" });
  const warn = vi.spyOn(logger, "warn");
  const adapter = new T3ThreadAdapter(
    {
      ...primary,
      fallbackTargets: [fallback],
      stateFile: path.join(dir, "receipts.db"),
      inheritPermissions: true,
    },
    client,
    logger,
  );
  adapters.push(adapter);
  return {
    adapter,
    calls,
    threads,
    items,
    warn,
    dir,
    sends: () => calls.filter((c) => c.name === "send_message"),
    failSend: (error: Error | null) => {
      sendFailure = error;
    },
    failReads: (error: Error | null) => {
      readFailure = error;
    },
  };
}
const hashOf = (prompt: string) =>
  createHash("sha256")
    .update(JSON.stringify(["primary", prompt]))
    .digest("hex");

describe("T3ThreadAdapter over T3 Code's MCP", () => {
  it("verifies via thread read, project list and thread list, then queues the send", async () => {
    const t3 = fixture();
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).resolves.toEqual({
      threadId: "primary",
    });
    expect(t3.calls.map((c) => c.name)).toEqual([
      "get_thread",
      "list_projects",
      "list_threads",
      "send_message",
    ]);
    expect(t3.calls[0]?.args).toEqual({
      threadId: "primary",
      view: "messages",
      limit: 1,
      maxCharsPerItem: 1,
    });
    expect(t3.calls[2]?.args).toEqual({ projectId: "project-1", limit: 100, settled: false });
    expect(t3.sends()[0]?.args).toEqual({
      threadId: "primary",
      message: `[wakewire-delivery:"delivery-one"]\n\nwake`,
      mode: "queue",
      clientRequestId: t3ClientRequestId("delivery-one", hashOf("wake")),
    });
    // A delivered receipt is never sent again.
    await t3.adapter.deliverToThread("primary", "wake", opts);
    expect(t3.sends()).toHaveLength(1);
  });

  it("derives a stable clientRequestId per delivery", () => {
    const a = t3ClientRequestId("delivery-one", hashOf("wake"));
    expect(t3ClientRequestId("delivery-one", hashOf("wake"))).toBe(a);
    expect(t3ClientRequestId("delivery-two", hashOf("wake"))).not.toBe(a);
    expect(t3ClientRequestId("delivery-one", hashOf("other"))).not.toBe(a);
    expect(a).toMatch(/^wakewire-[a-f0-9]{48}$/);
  });

  it("looks a settled thread up in T3's settled list", async () => {
    const t3 = fixture();
    const primary = t3.threads.get("primary");
    if (primary) primary.settled = true;
    await t3.adapter.deliverToThread("primary", "wake", opts);
    expect(t3.calls[2]?.args).toMatchObject({ settled: true });
  });

  it("rejects project, workspace and archived mismatches permanently", async () => {
    const t3 = fixture();
    const primary = t3.threads.get("primary");
    if (primary) primary.archived = true;
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
    const other = fixture();
    const thread = other.threads.get("primary");
    if (thread) thread.projectId = "elsewhere";
    await expect(other.adapter.deliverToThread("primary", "wake", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect([...t3.sends(), ...other.sends()]).toHaveLength(0);
  });

  it("holds for human requests and falls back only on a failed thread", async () => {
    const t3 = fixture();
    const primary = t3.threads.get("primary");
    if (!primary) throw new Error("fixture");
    primary.pendingRequestCount = 1;
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).rejects.toBeInstanceOf(
      BusyError,
    );
    primary.pendingRequestCount = 0;
    primary.status = "starting";
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).rejects.toBeInstanceOf(
      BusyError,
    );
    primary.status = "failed";
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).resolves.toEqual({
      threadId: "orchestrator",
    });
    expect(t3.sends()[0]?.args.threadId).toBe("orchestrator");
  });

  it("queues behind a running thread", async () => {
    const t3 = fixture();
    const primary = t3.threads.get("primary");
    if (primary) primary.status = "running";
    await t3.adapter.deliverToThread("primary", "wake", opts);
    expect(t3.sends()[0]?.args.mode).toBe("queue");
  });

  it("holds a delivery on 401 and retries it with the same clientRequestId", async () => {
    const t3 = fixture();
    t3.failSend(new T3AuthRequiredError("T3 rejected stored access"));
    const error = await t3.adapter.deliverToThread("primary", "wake", opts).catch((e) => e);
    expect(error).toBeInstanceOf(UnreachableError);
    expect(error).not.toBeInstanceOf(PermanentError);
    t3.failSend(null);
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).resolves.toEqual({
      threadId: "primary",
    });
    const ids = t3.sends().map((c) => c.args.clientRequestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("holds when the token is rejected during verification", async () => {
    const t3 = fixture();
    t3.failReads(new T3AuthRequiredError("expired"));
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).rejects.toBeInstanceOf(
      T3AuthRequiredError,
    );
    await expect(t3.adapter.probe()).resolves.toBe(false);
  });

  it("reconciles an ambiguous send from the projected marker without resending", async () => {
    const t3 = fixture();
    const primary = t3.threads.get("primary");
    if (primary) primary.itemCount = 1500;
    t3.items.push({ type: "user_message", text: `[wakewire-delivery:"delivery-one"]\n\nwake` });
    t3.failSend(new Error("socket hang up"));
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).resolves.toEqual({
      threadId: "primary",
    });
    const scan = t3.calls.filter((c) => c.name === "get_thread" && c.args.limit === 50);
    expect(scan[0]?.args).toMatchObject({ afterPosition: 499, view: "messages" });
  });

  it("refuses to resend an ambiguous send without a marker", async () => {
    const t3 = fixture();
    t3.failSend(new Error("socket hang up"));
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).rejects.toThrow(
      /Uncertain T3 delivery/,
    );
    t3.failSend(null);
    await expect(t3.adapter.deliverToThread("primary", "wake", opts)).rejects.toThrow(/Uncertain/);
    expect(t3.sends()).toHaveLength(1);
  });
});

describe("T3 access expiry", () => {
  it("warns once and sends ONE notice to the orchestrator per expiry", async () => {
    const expiresAt = new Date(Date.now() + 3 * DAY).toISOString();
    const t3 = fixture({ expiresAt });
    await t3.adapter.checkExpiry();
    await t3.adapter.checkExpiry();
    await t3.adapter.deliverToThread("primary", "wake", opts);
    await t3.adapter.checkExpiry();
    const warnings = t3.warn.mock.calls.filter((c) => String(c[1]).includes("T3 access expires"));
    expect(warnings).toHaveLength(1);
    const notices = t3.sends().filter((c) => String(c.args.message).includes("expires on"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.args).toMatchObject({
      threadId: "orchestrator",
      mode: "queue",
      clientRequestId: `wakewire-t3-expiry-${expiresAt}`,
    });
    expect(String(notices[0]?.args.message)).toContain("wakewire t3 login");
    expect(String(notices[0]?.args.message)).toContain(expiresAt.slice(0, 10));
    // A restart shares the receipt database and must not repeat the notice.
    await t3.adapter.close();
    adapters.splice(adapters.indexOf(t3.adapter), 1);
    const again = fixture({ expiresAt, dir: t3.dir });
    await again.adapter.checkExpiry();
    expect(again.sends()).toHaveLength(0);
  });

  it("stays quiet with more than five days left and never notifies after expiry", async () => {
    const quiet = fixture({ expiresAt: new Date(Date.now() + 6 * DAY).toISOString() });
    await quiet.adapter.checkExpiry();
    expect(quiet.warn).not.toHaveBeenCalled();
    const expired = fixture({ expiresAt: new Date(Date.now() - DAY).toISOString() });
    await expired.adapter.checkExpiry();
    expect(expired.warn.mock.calls.some((c) => String(c[1]).includes("expired"))).toBe(true);
    expect(expired.sends()).toHaveLength(0);
  });

  it("warns once per day and retries a notice that failed", async () => {
    const db = new Database(":memory:");
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const expiresAt = "2026-11-01T00:00:00.000Z";
    let now = Date.parse("2026-10-28T09:00:00.000Z");
    const notify = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const monitor = new T3ExpiryMonitor(db, {
      expiresAt: () => expiresAt,
      notify,
      logger,
      now: () => now,
    });
    await monitor.check();
    await monitor.check();
    now += 2 * 60 * 60 * 1000;
    await monitor.check();
    const daily = () => warn.mock.calls.filter((c) => String(c[1]).includes("expires on"));
    expect(daily()).toHaveLength(1);
    now += DAY;
    await monitor.check();
    await monitor.check();
    expect(daily()).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]?.[1]).toBe(notify.mock.calls[1]?.[1]);
    db.close();
  });
});
