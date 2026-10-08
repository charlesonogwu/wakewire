import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { T3McpClient } from "./t3-mcp.js";
import { PermanentError } from "./types.js";

const mock = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  call: vi.fn(async () => ({})),
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
  return { config, client: new T3McpClient(config) };
}
it("pins the bridge hash on construction and before every call", async () => {
  const { config, client } = fixture();
  expect(() => new T3McpClient({ ...config, serverSha256: "0".repeat(64) })).toThrow(
    PermanentError,
  );
  writeFileSync(config.serverPath, "changed");
  await expect(client.call("get_thread", { threadId: "primary" })).rejects.toBeInstanceOf(
    PermanentError,
  );
  expect(mock.connect).not.toHaveBeenCalled();
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
