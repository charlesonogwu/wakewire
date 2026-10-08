import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryQueue } from "../core/queue.js";
import { type ApiContext, createApi } from "../daemon/api.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { T3ConfigSchema, T3ThreadAdapter, type T3ToolClient } from "./t3-thread.js";
import { BusyError, PermanentError, UnreachableError } from "./types.js";

const opts = { sandbox: "workspace-write" as const, deliveryId: "delivery-one" };
const dirs: string[] = [];
const adapters: T3ThreadAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const packed = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wakewire-t3-"));
  dirs.push(dir);
  const primary = { threadId: "primary", environmentId: "env-1", projectId: "project-1", cwd: dir };
  const fallback = {
    threadId: "fallback",
    environmentId: "env-2",
    projectId: "project-2",
    cwd: dir,
  };
  const config = {
    ...primary,
    fallbackTargets: [fallback],
    stateFile: path.join(dir, "receipts.db"),
    inheritPermissions: true as const,
  };
  const states = new Map(
    [primary, fallback].map((target) => [
      target.threadId,
      {
        threadId: target.threadId,
        environmentId: target.environmentId,
        attention: "idle",
        session: { status: "ready" },
        latestTurn: { state: "completed" },
      },
    ]),
  );
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: T3ToolClient = {
    async call(name, args) {
      calls.push({ name, args });
      if (name === "get_thread") return packed(states.get(String(args.threadId)));
      if (name === "list_projects")
        return packed({
          projects: [primary, fallback].map((t) => ({ ...t, workspaceRoot: t.cwd })),
        });
      if (name === "list_threads")
        return packed({
          threads: [primary, fallback].filter((t) => t.projectId === args.projectId),
        });
      if (name === "send_message")
        return packed({
          sent: true,
          verified: true,
          threadId: args.threadId,
          environmentId: states.get(String(args.threadId))?.environmentId,
          deliveryMode: "after-current",
        });
      throw new Error("Unexpected tool");
    },
    close: vi.fn(),
  };
  const logger = pino({ level: "silent" });
  const error = vi.spyOn(logger, "error");
  const info = vi.spyOn(logger, "info");
  const adapter = new T3ThreadAdapter(config, client, logger);
  adapters.push(adapter);
  const primaryState = states.get(primary.threadId);
  const fallbackState = states.get(fallback.threadId);
  if (!primaryState || !fallbackState) throw new Error("Missing fixture state");
  return {
    adapter,
    config,
    client,
    primary,
    fallback,
    primaryState,
    fallbackState,
    calls,
    logger,
    error,
    info,
  };
}
describe("ported T3 owner delivery", () => {
  it.each(["sent", "sending"])("preserves deployed three-column %s receipts", async (state) => {
    const f = fixture();
    const stateFile = path.join(f.primary.cwd, "legacy.db");
    const db = new Database(stateFile);
    db.exec("CREATE TABLE t3_receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL)");
    db.prepare("INSERT INTO t3_receipts VALUES (?,?,?)").run(
      opts.deliveryId,
      createHash("sha256")
        .update(JSON.stringify(["primary", "hello"]))
        .digest("hex"),
      state,
    );
    db.close();
    const migrated = new T3ThreadAdapter({ ...f.config, stateFile }, f.client, f.logger);
    adapters.push(migrated);
    const delivery = migrated.deliverToThread("primary", "hello", opts);
    if (state === "sent") await expect(delivery).resolves.toEqual({ threadId: "primary" });
    else await expect(delivery).rejects.toBeInstanceOf(PermanentError);
    expect(f.calls).toHaveLength(0);
  });
  it("verifies identities and sends a marked after-current message", async () => {
    const f = fixture();
    expect(await f.adapter.probe()).toBe(true);
    await expect(f.adapter.deliverToThread("primary", "hello", opts)).resolves.toEqual({
      threadId: "primary",
    });
    expect(f.calls.find((c) => c.name === "send_message")?.args).toEqual({
      threadId: "primary",
      message: '[wakewire-delivery:"delivery-one"]\n\nhello',
      deliveryMode: "after-current",
    });
    expect(f.info).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "primary" }),
      expect.any(String),
    );
    expect(f.adapter.supportsNewThreads).toBe(false);
    await expect(f.adapter.startThread()).rejects.toBeInstanceOf(PermanentError);
  });
  it("queues to a running primary as the compiled implementation does", async () => {
    const f = fixture();
    f.primaryState.session.status = "running";
    f.primaryState.attention = "working";
    await expect(f.adapter.deliverToThread("primary", "hello", opts)).resolves.toEqual({
      threadId: "primary",
    });
  });
  it.each(["needs-approval", "needs-input", "plan-ready"])(
    "holds %s without bypassing to fallback",
    async (attention) => {
      const f = fixture();
      f.primaryState.attention = attention;
      await expect(f.adapter.deliverToThread("primary", "hello", opts)).rejects.toBeInstanceOf(
        BusyError,
      );
      expect(f.calls.some((c) => c.name === "send_message")).toBe(false);
    },
  );
  it("holds starting session states", async () => {
    const f = fixture();
    f.primaryState.session.status = "starting";
    await expect(f.adapter.deliverToThread("primary", "hello", opts)).rejects.toBeInstanceOf(
      BusyError,
    );
  });
  it.each(["session", "provider"])(
    "falls back after %s failure and verifies fallback identity",
    async (failure) => {
      const f = fixture();
      if (failure === "session") f.primaryState.session.status = "error";
      else f.primaryState.latestTurn.state = "error";
      await expect(f.adapter.deliverToThread("primary", "hello", opts)).resolves.toEqual({
        threadId: "fallback",
      });
      expect(f.calls).toContainEqual({
        name: "list_threads",
        args: { projectId: "project-2", limit: 100 },
      });
      expect(f.info).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "fallback" }),
        expect.any(String),
      );
    },
  );
  it("holds when every target has a provider error", async () => {
    const f = fixture();
    f.primaryState.attention = "error";
    f.fallbackState.attention = "error";
    await expect(f.adapter.deliverToThread("primary", "hello", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );
  });
  it.each(["thread", "environment", "project", "cwd", "fallback"])(
    "rejects %s identity mismatch before any write",
    async (mismatch) => {
      const f = fixture();
      const read = f.client.call.bind(f.client);
      f.client.call = async (name, args) => {
        if (mismatch === "thread" && name === "get_thread")
          return packed({ ...f.primaryState, threadId: "wrong" });
        if (mismatch === "environment" && name === "get_thread")
          return packed({ ...f.primaryState, environmentId: "wrong" });
        if (mismatch === "project" && name === "list_threads") return packed({ threads: [] });
        if (mismatch === "cwd" && name === "list_projects")
          return packed({
            projects: [
              {
                projectId: "project-1",
                environmentId: "env-1",
                workspaceRoot: path.join(f.primary.cwd, "wrong"),
              },
            ],
          });
        if (mismatch === "fallback") {
          f.primaryState.session.status = "error";
          if (name === "get_thread" && args.threadId === "fallback")
            return packed({ ...f.fallbackState, environmentId: "wrong" });
        }
        return read(name, args);
      };
      await expect(f.adapter.deliverToThread("primary", "hello", opts)).rejects.toBeInstanceOf(
        PermanentError,
      );
      expect(f.calls.some((c) => c.name === "send_message")).toBe(false);
    },
  );
  it("retries an unreachable bridge without creating a receipt", async () => {
    const f = fixture();
    const read = f.client.call;
    f.client.call = async () => {
      throw new Error("offline secret-token");
    };
    expect(await f.adapter.probe()).toBe(false);
    await expect(f.adapter.deliverToThread("primary", "hello", opts)).rejects.toBeInstanceOf(
      UnreachableError,
    );
    f.client.call = read;
    await expect(f.adapter.deliverToThread("primary", "hello", opts)).resolves.toEqual({
      threadId: "primary",
    });
  });
  it("classifies an explicit unknown-thread tool error as permanent", async () => {
    const f = fixture();
    f.client.call = async () => ({
      isError: true,
      content: [
        {
          type: "text",
          text: "Error: No thread with id primary exists in any reachable T3 environment.",
        },
      ],
    });
    await expect(f.adapter.deliverToThread("primary", "hello", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
  it.each(["lost response", "unverified", "wrong target"])(
    "fences %s durably, logs uncertainty and never resends",
    async (failure) => {
      const f = fixture();
      const read = f.client.call.bind(f.client);
      f.client.call = async (name, args) => {
        const result = await read(name, args);
        if (name !== "send_message") return result;
        if (failure === "lost response") throw new Error("secret-token");
        return packed({
          sent: true,
          verified: failure !== "unverified",
          threadId: failure === "unverified" ? "primary" : "wrong",
          environmentId: "env-1",
          deliveryMode: "after-current",
        });
      };
      await expect(f.adapter.deliverToThread("primary", "hello", opts)).rejects.toThrow(
        /Uncertain T3 delivery/,
      );
      await f.adapter.close();
      const restarted = new T3ThreadAdapter(f.config, f.client, f.logger);
      adapters.push(restarted);
      await expect(restarted.deliverToThread("primary", "hello", opts)).rejects.toBeInstanceOf(
        PermanentError,
      );
      expect(f.calls.filter((c) => c.name === "send_message")).toHaveLength(1);
      expect(f.error).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: "delivery-one",
          threadId: "primary",
          status: "uncertain",
        }),
        expect.any(String),
      );
      expect(JSON.stringify(f.error.mock.calls)).not.toContain("secret-token");
    },
  );
  it("returns the persisted fallback target after restart and primary recovery", async () => {
    const f = fixture();
    f.primaryState.attention = "error";
    await f.adapter.deliverToThread("primary", "hello", opts);
    await f.adapter.close();
    const restarted = new T3ThreadAdapter(f.config, f.client, f.logger);
    adapters.push(restarted);
    f.primaryState.attention = "idle";
    await expect(restarted.deliverToThread("primary", "hello", opts)).resolves.toEqual({
      threadId: "fallback",
    });
    expect(f.calls.filter((c) => c.name === "send_message")).toHaveLength(1);
    await expect(restarted.deliverToThread("primary", "changed", opts)).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
  it("claims only one receipt across concurrent owners", async () => {
    const f = fixture();
    const second = new T3ThreadAdapter(f.config, f.client, f.logger);
    adapters.push(second);
    await Promise.allSettled([
      f.adapter.deliverToThread("primary", "hello", opts),
      second.deliverToThread("primary", "hello", opts),
    ]);
    expect(f.calls.filter((c) => c.name === "send_message")).toHaveLength(1);
  });
  it("reports failed status through the API and continues later queue items after uncertainty", async () => {
    const f = fixture();
    const read = f.client.call.bind(f.client);
    let writes = 0;
    f.client.call = async (name, args) => {
      const result = await read(name, args);
      if (name === "send_message" && ++writes === 1) throw new Error("lost response");
      return result;
    };
    const db = openDatabase(":memory:");
    const stores = createStores(db);
    try {
      const route = stores.routes.create({
        name: "test",
        source: "github",
        match: { repo: "example/repo", events: ["push"] },
        target: { type: "thread", threadId: "primary" },
        sandbox: "workspace-write",
        enabled: true,
      });
      const queue = new DeliveryQueue(stores, f.adapter, f.logger, { autoWake: false });
      for (const deliveryId of ["one", "two"])
        queue.enqueueEvent(route, {
          source: "github",
          kind: "push",
          deliveryId,
          occurredAt: new Date().toISOString(),
          summary: deliveryId,
          payload: { repo: "example/repo" },
        });
      await queue.tick();
      await queue.tick();
      expect(stores.deliveries.list({ status: "failed" })).toHaveLength(1);
      expect(stores.deliveries.list({ status: "delivered" })).toHaveLength(1);
      expect(queue.queueDepth()).toBe(0);
      const app = createApi({ stores, config: { apiToken: "test" } } as unknown as ApiContext);
      const response = await app.request("/api/deliveries?status=failed", {
        headers: { authorization: "Bearer test" },
      });
      expect(await response.json()).toMatchObject({
        deliveries: [{ status: "failed", error: expect.stringContaining("Uncertain T3 delivery") }],
      });
    } finally {
      db.close();
    }
  });
  it("rejects invalid, duplicate or overbroad registration", () => {
    const f = fixture();
    for (const extra of [
      { cwd: "relative" },
      { stateFile: "relative" },
      { inheritPermissions: false },
      { fallbackTargets: [f.primary] },
      { token: "forbidden" },
    ])
      expect(T3ConfigSchema.safeParse({ ...f.config, ...extra }).success).toBe(false);
  });
});
