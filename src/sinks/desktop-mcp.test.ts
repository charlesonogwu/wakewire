import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DesktopMcpClient } from "./desktop-mcp.js";

const dirs: string[] = [];
it("retries initialization after a transient connector failure", async () => {
  const r = registration();
  const counter = path.join(path.dirname(r.serverPath), "attempts");
  const code = `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, 'x'); throw new Error('temporary');`;
  writeFileSync(r.serverPath, code);
  r.serverSha256 = createHash("sha256").update(code).digest("hex");
  const c = new DesktopMcpClient(r);
  for (let i = 0; i < 2; i++)
    await expect(
      c.call("read_thread", { threadId: "registered-thread", hostId: "local" }),
    ).rejects.toThrow();
  c.close();
  expect(readFileSync(counter, "utf8")).toBe("xx");
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function registration() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desktop-connector-"));
  dirs.push(dir);
  const serverPath = path.join(dir, "server.mjs");
  writeFileSync(serverPath, "throw new Error('must not execute');");
  return {
    serverPath,
    serverSha256: createHash("sha256").update("throw new Error('must not execute');").digest("hex"),
    threadId: "registered-thread",
    pipePath: "synthetic-pipe",
  };
}
it("rejects a changed connector before execution", () => {
  const r = registration();
  writeFileSync(r.serverPath, "different");
  expect(() => new DesktopMcpClient(r)).toThrow(/changed/i);
});
it("rejects out-of-scope tools and targets without executing the connector", async () => {
  const c = new DesktopMcpClient(registration());
  await expect(
    c.call("delete_thread", { threadId: "registered-thread", hostId: "local" }),
  ).rejects.toThrow(/scope/);
  await expect(
    c.call("send_message_to_thread", { threadId: "other", hostId: "local" }),
  ).rejects.toThrow(/scope/);
  await expect(
    c.call("read_thread", { threadId: "registered-thread", hostId: "remote" }),
  ).rejects.toThrow(/scope/);
  c.close();
});
