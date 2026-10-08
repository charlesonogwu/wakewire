import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { AdapterNameSchema, type DaemonConfig } from "../config.js";
import { CoordinationAdapter } from "../coordination/adapter.js";
import { CoordinationCompletionMonitor } from "../coordination/completion.js";
import { createAdapter } from "./factory.js";
import { T3ThreadAdapter } from "./t3-thread.js";
import type { AgentAdapter } from "./types.js";

const dirs: string[] = [];
const adapters: AgentAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close?.();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const config: DaemonConfig = {
  adapter: "t3-thread",
  codexPath: undefined,
  musePath: undefined,
  museYolo: false,
  model: undefined,
  appServerConnection: "auto",
  appServerListen: undefined,
  ratePerMinute: 10,
  apiPort: 0,
  apiToken: "test",
};
function registration(coordination?: object) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wakewire-t3-factory-"));
  dirs.push(dir);
  const file = path.join(dir, "registration.json");
  writeFileSync(
    file,
    JSON.stringify({
      threadIds: ["11111111-1111-4111-8111-111111111111"],
      bridgePath: path.join(dir, "bridge.js"),
      stateFile: path.join(dir, "receipts.db"),
      inheritPermissions: true,
      ...(coordination ? { coordination } : {}),
    }),
  );
  vi.stubEnv("WAKEWIRE_T3_REGISTRATION", file);
}
it("recognizes t3-thread and requires explicit registration", () => {
  expect(AdapterNameSchema.parse("t3-thread")).toBe("t3-thread");
  vi.stubEnv("WAKEWIRE_T3_REGISTRATION", "");
  expect(() => createAdapter(config, pino({ level: "silent" }))).toThrow(/registration/);
});
it("creates the T3 sink without loading credentials at factory time", () => {
  registration();
  const adapter = createAdapter(config, pino({ level: "silent" }));
  adapters.push(adapter);
  expect(adapter).toBeInstanceOf(T3ThreadAdapter);
});
it("wraps T3 in the existing coordination filter and completion monitor", async () => {
  registration({
    expectedRepository: "example/repo",
    localAgent: "codex",
    trustedAuthorIds: { codex: ["1"], hermes: ["2"] },
    waitingLabel: "waiting:review",
  });
  const start = vi
    .spyOn(CoordinationCompletionMonitor.prototype, "start")
    .mockImplementation(() => {});
  const close = vi.spyOn(CoordinationCompletionMonitor.prototype, "close");
  const adapter = createAdapter(config, pino({ level: "silent" }));
  expect(adapter).toBeInstanceOf(CoordinationAdapter);
  expect(adapter.name).toBe("t3-thread-coordination");
  expect(start).toHaveBeenCalledTimes(1);
  await expect(
    adapter.deliverToThread("irrelevant", "ignored", {
      sandbox: "workspace-write",
      deliveryId: "one",
    }),
  ).rejects.toThrow(/GitHub event/);
  await adapter.close?.();
  expect(close).toHaveBeenCalledTimes(1);
});
