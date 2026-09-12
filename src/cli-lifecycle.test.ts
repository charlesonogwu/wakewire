import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const children: number[] = [];
const homes: string[] = [];

afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("daemon lifecycle commands", () => {
  it.each([
    ["start", ["start", "--detach"]],
    ["stop", ["stop"]],
  ])("%s does not remove state replaced during identity inspection", async (_name, command) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-cli-lifecycle-"));
    homes.push(home);
    const stateFile = path.join(home, "daemon.json");
    const replacement = {
      pid: process.pid,
      port: 1,
      token: "replacement-token",
      instanceId: "replacement",
      startedAt: "2026-09-12T00:00:01.000Z",
      version: "0.1.0",
    };
    const server = http.createServer((_request, response) => {
      fs.writeFileSync(stateFile, JSON.stringify(replacement));
      fs.writeFileSync(
        path.join(home, "daemon.lock"),
        JSON.stringify({ pid: process.pid, instanceId: replacement.instanceId }),
      );
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ service: "wakewire", instanceId: "foreign", pid: process.pid }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not listen");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        ...replacement,
        port: address.port,
        token: "old-token",
        instanceId: "inspected",
        startedAt: "2026-09-12T00:00:00.000Z",
      }),
    );

    try {
      const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
      await expect(
        execFileAsync(process.execPath, [tsx, "src/cli.ts", ...command], {
          cwd: path.resolve("."),
          env: { ...process.env, WAKEWIRE_HOME: home },
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual(replacement);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("stop never terminates an unrelated process that reused a stale daemon pid", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("test process did not start");
    children.push(child.pid);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-cli-lifecycle-"));
    homes.push(home);
    fs.writeFileSync(
      path.join(home, "daemon.json"),
      JSON.stringify({
        pid: child.pid,
        port: 9,
        token: "stale-token",
        startedAt: "2026-09-12T00:00:00.000Z",
        version: "0.1.0",
      }),
    );

    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
    const execution = execFileAsync(process.execPath, [tsx, "src/cli.ts", "stop"], {
      cwd: path.resolve("."),
      env: { ...process.env, WAKEWIRE_HOME: home },
    });

    await expect(execution).rejects.toMatchObject({
      stderr: expect.stringContaining("cannot verify daemon identity"),
    });
    expect(fs.existsSync(path.join(home, "daemon.json"))).toBe(true);
    expect(() => process.kill(child.pid as number, 0)).not.toThrow();
  });

  it("start refuses to launch a duplicate when a live daemon identity cannot be verified", async () => {
    const server = http.createServer(() => {
      // Deliberately never answer: a temporary API stall is not proof the daemon died.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not listen");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-cli-lifecycle-"));
    homes.push(home);
    fs.writeFileSync(
      path.join(home, "daemon.json"),
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        token: "must-not-be-sent",
        instanceId: "instance-1",
        startedAt: "2026-09-12T00:00:00.000Z",
        version: "0.1.0",
      }),
    );

    try {
      const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
      await expect(
        execFileAsync(process.execPath, [tsx, "src/cli.ts", "start", "--detach"], {
          cwd: path.resolve("."),
          env: { ...process.env, WAKEWIRE_HOME: home },
          timeout: 5_000,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(fs.existsSync(path.join(home, "daemon.json"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("start keeps its identity deadline active through a stalled response body", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"service":"wakewire"');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not listen");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-cli-lifecycle-"));
    homes.push(home);
    fs.writeFileSync(
      path.join(home, "daemon.json"),
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        token: "must-not-be-sent",
        instanceId: "instance-1",
        startedAt: "2026-09-12T00:00:00.000Z",
        version: "0.1.0",
      }),
    );

    try {
      const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
      await expect(
        execFileAsync(process.execPath, [tsx, "src/cli.ts", "start", "--detach"], {
          cwd: path.resolve("."),
          env: { ...process.env, WAKEWIRE_HOME: home },
          timeout: 4_000,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("cannot verify daemon identity"),
      });
      expect(fs.existsSync(path.join(home, "daemon.json"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("stop bounds a stalled management response without probing deep health", async () => {
    let healthRequests = 0;
    let shutdownRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.url === "/api/identity") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ service: "wakewire", instanceId: "instance-1", pid: process.pid }),
        );
        return;
      }
      if (request.url === "/api/health") {
        healthRequests += 1;
      } else if (request.url === "/api/shutdown") {
        shutdownRequests += 1;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not listen");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-cli-lifecycle-"));
    homes.push(home);
    fs.writeFileSync(
      path.join(home, "daemon.json"),
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        token: "test-token",
        instanceId: "instance-1",
        startedAt: "2026-09-12T00:00:00.000Z",
        version: "0.1.0",
      }),
    );

    try {
      const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
      await expect(
        execFileAsync(process.execPath, [tsx, "src/cli.ts", "stop"], {
          cwd: path.resolve("."),
          env: { ...process.env, WAKEWIRE_HOME: home },
          timeout: 4_000,
        }),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("outcome is uncertain"),
      });
      expect(healthRequests).toBe(0);
      expect(shutdownRequests).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("stop requests shutdown for the verified instance without signaling its pid", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("test process did not start");
    children.push(child.pid);
    let shutdownBody: unknown;
    let healthRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.url === "/api/identity") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ service: "wakewire", instanceId: "instance-1", pid: child.pid }),
        );
        return;
      }
      if (request.url === "/api/health") {
        healthRequests += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "ok", instanceId: "instance-1", pid: child.pid }));
        return;
      }
      if (request.url === "/api/shutdown") {
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          raw += chunk;
        });
        request.on("end", () => {
          shutdownBody = JSON.parse(raw);
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not listen");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-cli-lifecycle-"));
    homes.push(home);
    fs.writeFileSync(
      path.join(home, "daemon.json"),
      JSON.stringify({
        pid: child.pid,
        port: address.port,
        token: "test-token",
        instanceId: "instance-1",
        startedAt: "2026-09-12T00:00:00.000Z",
        version: "0.1.0",
      }),
    );

    try {
      const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
      await expect(
        execFileAsync(process.execPath, [tsx, "src/cli.ts", "stop"], {
          cwd: path.resolve("."),
          env: { ...process.env, WAKEWIRE_HOME: home },
        }),
      ).resolves.toMatchObject({ stdout: expect.stringContaining("shutdown requested") });
      expect(shutdownBody).toEqual({ instanceId: "instance-1" });
      expect(healthRequests).toBe(0);
      expect(() => process.kill(child.pid as number, 0)).not.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
