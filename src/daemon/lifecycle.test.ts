import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { settingKeys } from "../config.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { Daemon } from "./daemon.js";

vi.mock("../sinks/factory.js", () => ({
  createAdapter: () => ({
    name: "test",
    probe: async () => true,
    deliverToThread: async () => {
      throw new Error("Unexpected agent invocation");
    },
    startThread: async () => {
      throw new Error("Unexpected agent invocation");
    },
  }),
}));
vi.mock("../secrets/store.js", async (original) => ({
  ...(await original<typeof import("../secrets/store.js")>()),
  createSecretStore: async () => ({ backend: "keychain", get: () => undefined }),
}));

const homes: string[] = [];
const daemons: Daemon[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const daemon of daemons.splice(0)) await daemon.stop();
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function fixture(): { daemon: Daemon; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-daemon-lifecycle-"));
  homes.push(home);
  vi.stubEnv("WAKEWIRE_HOME", home);
  const db = openDatabase();
  const stores = createStores(db);
  stores.settings.set(settingKeys.adapter, "codex-sdk");
  db.close();
  const daemon = new Daemon(pino({ level: "silent" }));
  daemons.push(daemon);
  return { daemon, home };
}

it("allows only one daemon instance to own a wakewire home", async () => {
  const { daemon: first } = fixture();
  await first.start();
  const second = new Daemon(pino({ level: "silent" }));
  daemons.push(second);

  await expect(second.start()).rejects.toThrow(/already owns|ownership/i);
});

it("shuts down only when the authenticated request names this instance", async () => {
  const { daemon } = fixture();
  const state = await daemon.start();
  const headers = {
    authorization: `Bearer ${state.token}`,
    "content-type": "application/json",
  };

  const wrong = await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
    method: "POST",
    headers,
    body: JSON.stringify({ instanceId: "replacement-instance" }),
  });
  expect(wrong.status).toBe(409);
  expect(
    (
      await fetch(`http://127.0.0.1:${state.port}/api/health`, {
        headers: { authorization: `Bearer ${state.token}` },
      })
    ).status,
  ).toBe(200);

  const accepted = await fetch(`http://127.0.0.1:${state.port}/api/shutdown`, {
    method: "POST",
    headers,
    body: JSON.stringify({ instanceId: state.instanceId }),
  });
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ ok: true });
  await expect(daemon.waitUntilStopped()).resolves.toBeUndefined();
  await expect(fetch(`http://127.0.0.1:${state.port}/api/identity`)).rejects.toThrow();
});

it("does not remove state published by a replacement instance", async () => {
  const { daemon, home } = fixture();
  const state = await daemon.start();
  const replacement = { ...state, instanceId: "replacement-instance" };
  fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify(replacement));

  await daemon.stop();

  expect(JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"))).toEqual(replacement);
});

it("leaves the previous complete state in place when atomic publication fails", async () => {
  const { daemon, home } = fixture();
  const stateFile = path.join(home, "daemon.json");
  fs.writeFileSync(stateFile, '{"previous":true}\n');
  const renameSync = fs.renameSync.bind(fs);
  const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (path.resolve(String(destination)) === path.resolve(stateFile)) {
      throw new Error("simulated publish failure");
    }
    return renameSync(source, destination);
  });

  await expect(daemon.start()).rejects.toThrow("simulated publish failure");
  expect(fs.readFileSync(stateFile, "utf8")).toBe('{"previous":true}\n');
  expect(fs.readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  rename.mockRestore();
});
