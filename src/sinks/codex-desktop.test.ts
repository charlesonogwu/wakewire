import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexDesktopAdapter, type DesktopToolClient } from "./codex-desktop.js";

const dirs: string[] = [];
const adapters: CodexDesktopAdapter[] = [];
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(status = "idle", stateFile?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wakewire-desktop-"));
  dirs.push(dir);
  const sent: Record<string, unknown>[] = [];
  const config = {
    threadId: "test-thread",
    cwd: dir,
    stateFile: stateFile ?? path.join(dir, "receipts.db"),
    inheritPermissions: true,
  };
  const client: DesktopToolClient = {
    async call(name, args) {
      if (name === "read_thread")
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                schemaVersion: 1,
                thread: {
                  id: "test-thread",
                  kind: "codex",
                  hostId: "local",
                  cwd: config.cwd,
                  status: { type: status, activeFlags: [] },
                },
                page: {},
                turns: [],
              }),
            },
          ],
          isError: false,
        };
      sent.push(args);
      return {
        content: [{ type: "text", text: JSON.stringify({ threadId: "test-thread" }) }],
        isError: false,
      };
    },
    close() {},
  };
  const adapter = new CodexDesktopAdapter(config, client);
  adapters.push(adapter);
  return { adapter, client, config, sent };
}
const opts = { sandbox: "workspace-write" as const, deliveryId: "event-one" };
describe("Desktop owner delivery", () => {
  it("does not report a different workspace as a valid probe", async () => {
    const f = fixture();
    const read = f.client.call.bind(f.client);
    f.client.call = async (name, args) => {
      const r = await read(name, args);
      if (name !== "read_thread") return r;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              thread: {
                id: "test-thread",
                kind: "codex",
                hostId: "local",
                cwd: path.join(f.config.cwd, "other"),
                status: { type: "idle" },
              },
            }),
          },
        ],
        isError: false,
      };
    };
    expect(await f.adapter.probe()).toBe(false);
  });
  it("waits for active Desktop without submitting a message", async () => {
    const f = fixture("active");
    await expect(f.adapter.deliverToThread("test-thread", "hello", opts)).rejects.toThrow(/busy/i);
    expect(f.sent).toHaveLength(0);
  });
  it("holds unknown status rather than assuming idle", async () => {
    const f = fixture("new-status");
    await expect(f.adapter.deliverToThread("test-thread", "hello", opts)).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
  });
  it("rejects a different target before any message", async () => {
    const f = fixture();
    await expect(f.adapter.deliverToThread("other", "hello", opts)).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
  });
  it("does not silently weaken a read-only route", async () => {
    const f = fixture();
    await expect(
      f.adapter.deliverToThread("test-thread", "hello", { ...opts, sandbox: "read-only" }),
    ).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
  });
  it("submits once via Desktop and persists receipt across adapter restarts", async () => {
    const f = fixture();
    expect(await f.adapter.deliverToThread("test-thread", "hello", opts)).toEqual({
      threadId: "test-thread",
    });
    await f.adapter.close();
    const second = new CodexDesktopAdapter(f.config, f.client);
    adapters.push(second);
    await second.deliverToThread("test-thread", "hello", opts);
    expect(f.sent).toEqual([{ threadId: "test-thread", prompt: "hello", hostId: "local" }]);
  });
  it("fences a lost response durably and never resends", async () => {
    const f = fixture();
    const real = f.client.call.bind(f.client);
    f.client.call = async (name, args) => {
      const r = await real(name, args);
      if (name === "send_message_to_thread") throw new Error("lost response");
      return r;
    };
    await expect(f.adapter.deliverToThread("test-thread", "hello", opts)).rejects.toThrow(
      /uncertain/i,
    );
    await f.adapter.close();
    const second = new CodexDesktopAdapter(f.config, f.client);
    adapters.push(second);
    await expect(second.deliverToThread("test-thread", "hello", opts)).rejects.toThrow(
      /uncertain/i,
    );
    expect(f.sent).toHaveLength(1);
  });
  it("rejects reused delivery IDs with different content", async () => {
    const f = fixture();
    await f.adapter.deliverToThread("test-thread", "hello", opts);
    await expect(f.adapter.deliverToThread("test-thread", "different", opts)).rejects.toThrow();
    expect(f.sent).toHaveLength(1);
  });
  it("claims atomically across two adapters sharing the receipt file", async () => {
    const f = fixture();
    const second = new CodexDesktopAdapter(f.config, f.client);
    adapters.push(second);
    await Promise.allSettled([
      f.adapter.deliverToThread("test-thread", "hello", opts),
      second.deliverToThread("test-thread", "hello", opts),
    ]);
    expect(f.sent).toHaveLength(1);
  });
  it("rejects a mismatched workspace before submission", async () => {
    const f = fixture();
    f.config.cwd = path.join(f.config.cwd, "different");
    const read = f.client.call.bind(f.client);
    f.client.call = async (name, args) => {
      const r = await read(name, args);
      if (name !== "read_thread") return r;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              thread: {
                id: "test-thread",
                kind: "codex",
                hostId: "local",
                cwd: path.dirname(f.config.cwd),
                status: { type: "idle" },
              },
            }),
          },
        ],
        isError: false,
      };
    };
    await expect(f.adapter.deliverToThread("test-thread", "hello", opts)).rejects.toThrow(
      /workspace/i,
    );
    expect(f.sent).toHaveLength(0);
  });
  it("treats a wrong-thread acknowledgement as uncertain and never resends", async () => {
    const f = fixture();
    const read = f.client.call.bind(f.client);
    f.client.call = async (name, args) => {
      const r = await read(name, args);
      return name === "read_thread"
        ? r
        : { content: [{ type: "text", text: '{"threadId":"wrong"}' }], isError: false };
    };
    await expect(f.adapter.deliverToThread("test-thread", "hello", opts)).rejects.toThrow(
      /uncertain/i,
    );
    await expect(f.adapter.deliverToThread("test-thread", "hello", opts)).rejects.toThrow(
      /uncertain/i,
    );
    expect(f.sent).toHaveLength(1);
  });
});
