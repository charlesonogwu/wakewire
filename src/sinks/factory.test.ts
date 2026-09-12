import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../config.js";
import { createAdapter } from "./factory.js";

const connector = vi.hoisted(() => ({
  generation: 0,
  refresh: vi.fn<() => Promise<boolean>>(),
  calls: [] as string[],
}));

vi.mock("./desktop-registration.js", () => ({
  refreshDesktopRegistration: connector.refresh,
}));

vi.mock("./desktop-mcp.js", () => ({
  DesktopMcpClient: class {
    private readonly generation = connector.generation++;

    async call(name: string) {
      connector.calls.push(name);
      if (name === "read_thread" && this.generation === 0) {
        return {
          isError: true,
          content: [{ type: "text", text: "stale Desktop connector" }],
        };
      }
      if (name === "read_thread") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                thread: {
                  id: "thread-1",
                  kind: "codex",
                  hostId: "local",
                  cwd: currentCwd,
                  status: { type: "idle" },
                },
              }),
            },
          ],
        };
      }
      return {
        isError: true,
        content: [{ type: "text", text: "write acknowledgement lost" }],
      };
    }

    close() {}
  },
}));

let currentCwd = "";
const dirs: string[] = [];

afterEach(() => {
  connector.generation = 0;
  connector.calls.length = 0;
  connector.refresh.mockReset();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-factory-"));
  dirs.push(dir);
  currentCwd = dir;
  const registrationFile = path.join(dir, "desktop-registration.json");
  fs.writeFileSync(
    registrationFile,
    JSON.stringify({
      threadId: "thread-1",
      cwd: dir,
      stateFile: path.join(dir, "receipts.db"),
      inheritPermissions: true,
      serverPath: path.join(dir, "server.mjs"),
      serverSha256: "a".repeat(64),
      pipePath: "synthetic-pipe",
    }),
  );
  vi.stubEnv("WAKEWIRE_DESKTOP_REGISTRATION", registrationFile);
  connector.refresh.mockResolvedValue(true);
  const config: DaemonConfig = {
    adapter: "codex-desktop",
    codexPath: undefined,
    model: undefined,
    appServerConnection: "auto",
    appServerListen: undefined,
    ratePerMinute: 10,
    apiPort: 0,
    apiToken: "test-token",
  };
  const adapter = createAdapter(config, pino({ level: "silent" }));
  return { adapter };
}

it("refreshes a resolved MCP read error through the adapter created by the factory", async () => {
  const { adapter } = fixture();
  try {
    await expect(adapter.probe()).resolves.toBe(true);
    expect(connector.refresh).toHaveBeenCalledTimes(1);
    expect(connector.calls).toEqual(["read_thread", "read_thread"]);
  } finally {
    adapter.close?.();
    vi.unstubAllEnvs();
  }
});

it("does not refresh or retry a write through the adapter created by the factory", async () => {
  connector.generation = 1;
  const { adapter } = fixture();
  try {
    await expect(
      adapter.deliverToThread("thread-1", "hello", {
        sandbox: "workspace-write",
        deliveryId: "delivery-1",
      }),
    ).rejects.toThrow(/uncertain/i);
    expect(connector.refresh).not.toHaveBeenCalled();
    expect(connector.calls).toEqual(["read_thread", "send_message_to_thread"]);
  } finally {
    adapter.close?.();
    vi.unstubAllEnvs();
  }
});
