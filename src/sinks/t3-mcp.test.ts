import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { DeliveryQueue } from "../core/queue.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { T3McpClient } from "./t3-mcp.js";
import { T3ThreadAdapter } from "./t3-thread.js";
import { PermanentError, UnreachableError } from "./types.js";

const mock = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  call: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({})),
  transports: [] as Record<string, unknown>[],
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = mock.connect;
    close = mock.close;
    callTool = mock.call;
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(options: Record<string, unknown>) {
      mock.transports.push(options);
    }
  },
}));
const dirs: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  mock.call.mockReset();
  vi.unstubAllEnvs();
  mock.transports.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wakewire-t3-mcp-"));
  dirs.push(dir);
  const serverPath = path.join(dir, "server.js");
  writeFileSync(serverPath, "bridge");
  const config = {
    threadId: "primary",
    projectId: "project",
    environmentId: "env",
    cwd: dir,
    inheritPermissions: true as const,
    stateFile: path.join(dir, "receipts.db"),
    fallbackTargets: [
      { threadId: "fallback", projectId: "backup-project", environmentId: "env-2", cwd: dir },
    ],
    serverPath,
    serverSha256: createHash("sha256").update("bridge").digest("hex"),
  };
  const logger = pino({ level: "silent" });
  const error = vi.spyOn(logger, "error");
  return { config, logger, error, client: new T3McpClient(config, logger) };
}
it("starts with a mismatched pin, holds calls, and recovers when the registered hash matches", async () => {
  const { config, logger, error } = fixture();
  const client = new T3McpClient(
    { ...config, serverSha256: createHash("sha256").update("updated").digest("hex") },
    logger,
  );
  await expect(client.call("get_thread", { threadId: "primary" })).rejects.toBeInstanceOf(
    UnreachableError,
  );
  expect(error).toHaveBeenCalledWith(
    expect.any(Object),
    expect.stringContaining("re-register T3 bridge"),
  );
  expect(mock.connect).not.toHaveBeenCalled();
  writeFileSync(config.serverPath, "updated");
  await client.call("get_thread", { threadId: "primary" });
  expect(mock.call).toHaveBeenCalledTimes(1);
});
it("holds a missing or changed bridge instead of failing permanently", async () => {
  const { config, client } = fixture();
  writeFileSync(config.serverPath, "changed");
  await expect(client.call("get_thread", { threadId: "primary" })).rejects.toBeInstanceOf(
    UnreachableError,
  );
  rmSync(config.serverPath);
  await expect(client.call("get_thread", { threadId: "primary" })).rejects.toBeInstanceOf(
    UnreachableError,
  );
  expect(mock.connect).not.toHaveBeenCalled();
});
it("rejects structurally invalid registration", () => {
  const { config, logger } = fixture();
  expect(() => new T3McpClient({ ...config, serverPath: "relative" }, logger)).toThrow(
    PermanentError,
  );
  expect(() => new T3McpClient({ ...config, serverSha256: "bad" }, logger)).toThrow(PermanentError);
});
it("keeps a mismatched-pin delivery held across restart and sends once after re-registration", async () => {
  const { config, logger } = fixture();
  const { serverPath, serverSha256, ...target } = config;
  const adapter = new T3ThreadAdapter(
    target,
    new T3McpClient({ ...config, serverSha256: "0".repeat(64) }, logger),
    logger,
  );
  const db = openDatabase(":memory:");
  const stores = createStores(db);
  let recovered: T3ThreadAdapter | undefined;
  try {
    expect(await adapter.probe()).toBe(false);
    const route = stores.routes.create({
      name: "pin-test",
      source: "github",
      match: { repo: "example/repo", events: ["push"] },
      target: { type: "thread", threadId: "primary" },
      sandbox: "workspace-write",
      enabled: true,
    });
    let now = new Date();
    const queue = new DeliveryQueue(stores, adapter, logger, { autoWake: false, now: () => now });
    queue.enqueueEvent(route, {
      source: "github",
      kind: "push",
      deliveryId: "pin-event",
      occurredAt: now.toISOString(),
      summary: "test",
      payload: { repo: "example/repo" },
    });
    await queue.tick();
    expect(stores.deliveries.list({ status: "held" })).toHaveLength(1);
    expect(stores.deliveries.list({ status: "failed" })).toHaveLength(0);
    expect(mock.call).not.toHaveBeenCalled();
    await adapter.close();
    const packed = (value: unknown) => ({
      content: [{ type: "text", text: JSON.stringify(value) }],
    });
    mock.call.mockImplementation(async (raw) => {
      const call = raw as { name: string };
      if (call.name === "get_thread")
        return packed({
          threadId: "primary",
          environmentId: "env",
          attention: "idle",
          session: { status: "ready" },
        });
      if (call.name === "list_projects")
        return packed({
          projects: [{ projectId: "project", environmentId: "env", workspaceRoot: target.cwd }],
        });
      if (call.name === "list_threads")
        return packed({ threads: [{ threadId: "primary", environmentId: "env" }] });
      return packed({
        sent: true,
        verified: true,
        threadId: "primary",
        environmentId: "env",
        deliveryMode: "after-current",
      });
    });
    recovered = new T3ThreadAdapter(
      target,
      new T3McpClient({ ...target, serverPath, serverSha256 }, logger),
      logger,
    );
    const restartedQueue = new DeliveryQueue(stores, recovered, logger, {
      autoWake: false,
      now: () => now,
    });
    now = new Date(now.getTime() + 2000);
    await restartedQueue.tick();
    await restartedQueue.tick();
    expect(stores.deliveries.list({ status: "delivered" })).toHaveLength(1);
    expect(
      mock.call.mock.calls.filter(([raw]) => (raw as { name: string }).name === "send_message"),
    ).toHaveLength(1);
  } finally {
    await adapter.close();
    await recovered?.close();
    db.close();
  }
});
it("holds a pin failure immediately before submission without leaving an uncertain fence", async () => {
  const { config, client, logger } = fixture();
  const { serverPath, serverSha256: _serverSha256, ...target } = config;
  const adapter = new T3ThreadAdapter(target, client, logger);
  const packed = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  let changePin = true;
  mock.call.mockImplementation(async (raw) => {
    const call = raw as { name: string };
    if (call.name === "get_thread")
      return packed({
        threadId: "primary",
        environmentId: "env",
        attention: "idle",
        session: { status: "ready" },
      });
    if (call.name === "list_projects")
      return packed({
        projects: [{ projectId: "project", environmentId: "env", workspaceRoot: target.cwd }],
      });
    if (call.name === "list_threads") {
      if (changePin) writeFileSync(serverPath, "changed");
      return packed({ threads: [{ threadId: "primary", environmentId: "env" }] });
    }
    return packed({
      sent: true,
      verified: true,
      threadId: "primary",
      environmentId: "env",
      deliveryMode: "after-current",
    });
  });
  try {
    const options = { sandbox: "workspace-write" as const, deliveryId: "pin-race" };
    await expect(adapter.deliverToThread("primary", "hello", options)).rejects.toBeInstanceOf(
      UnreachableError,
    );
    expect(
      mock.call.mock.calls.some(([raw]) => (raw as { name: string }).name === "send_message"),
    ).toBe(false);
    changePin = false;
    writeFileSync(serverPath, "bridge");
    await expect(adapter.deliverToThread("primary", "hello", options)).resolves.toEqual({
      threadId: "primary",
    });
    expect(
      mock.call.mock.calls.filter(([raw]) => (raw as { name: string }).name === "send_message"),
    ).toHaveLength(1);
  } finally {
    await adapter.close();
  }
});
it.each([
  ["stop_thread", { threadId: "primary" }],
  ["get_thread", { threadId: "other" }],
  ["list_threads", { projectId: "other" }],
  ["send_message", { threadId: "primary", deliveryMode: "immediate" }],
  [
    "send_message",
    { threadId: "primary", deliveryMode: "after-current", runtimeMode: "full-access" },
  ],
])("rejects out-of-scope %s arguments", async (name, args) => {
  const { client } = fixture();
  await expect(client.call(name, args)).rejects.toBeInstanceOf(PermanentError);
  expect(mock.connect).not.toHaveBeenCalled();
});
it("allows registered fallback delivery, sanitizes the environment, and closes MCP", async () => {
  vi.stubEnv("SECRET_TEST_TOKEN", "do-not-forward");
  vi.stubEnv("T3_TOKEN", "do-not-forward");
  const { config, client } = fixture();
  await client.call("send_message", {
    threadId: "fallback",
    message: "hello",
    deliveryMode: "after-current",
  });
  expect(mock.transports[0]).toMatchObject({
    command: process.execPath,
    args: [config.serverPath],
    stderr: "ignore",
  });
  expect(mock.transports[0]?.env).not.toHaveProperty("SECRET_TEST_TOKEN");
  expect(mock.transports[0]?.env).not.toHaveProperty("T3_TOKEN");
  expect(mock.close).toHaveBeenCalledTimes(1);
  await client.close();
  await expect(client.call("get_thread", { threadId: "primary" })).rejects.toBeInstanceOf(
    PermanentError,
  );
});
