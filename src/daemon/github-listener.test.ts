import { createHmac } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { settingKeys } from "../config.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import { Daemon } from "./daemon.js";

// Only external agent execution and the OS keychain are replaced. HTTP,
// HMAC validation, source wiring and SQLite persistence are the real code.
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
  createSecretStore: async () => ({ backend: "keychain", get: () => "synthetic-secret" }),
}));

it("serves only signed ingress on the separate port and closes it on shutdown", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-listener-"));
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  vi.stubEnv("WAKEWIRE_HOME", home);
  vi.stubEnv("WAKEWIRE_GITHUB_INGRESS_PORT", String(port));
  vi.stubEnv("WAKEWIRE_GITHUB_SOURCE_ID", "github-synthetic");
  const db = openDatabase();
  const stores = createStores(db);
  stores.settings.set(settingKeys.adapter, "codex-sdk");
  stores.sources.upsert({ id: "github-synthetic", kind: "github", config: { mode: "listen" } });
  db.close();
  const daemon = new Daemon(pino({ level: "silent" }));
  try {
    const state = await daemon.start();
    expect(state.port).not.toBe(port);
    const body = JSON.stringify({ zen: "synthetic" });
    const response = await fetch(`http://127.0.0.1:${port}/github`, {
      method: "POST",
      body,
      headers: {
        "x-github-event": "ping",
        "x-github-delivery": "synthetic",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "synthetic-secret").update(body).digest("hex")}`,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "pong" });
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${state.port}/api/health`)).status).toBe(401);
  } finally {
    await daemon.stop();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  }
  await expect(fetch(`http://127.0.0.1:${port}/github`)).rejects.toThrow();
});
