import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireExclusiveOwnership,
  type ExclusiveOwner,
  pidIsAlive,
  releaseExclusiveOwnership,
} from "./exclusive-ownership.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function acquireWithLiveness(
  file: string,
  owner: ExclusiveOwner,
  isAlive: (pid: number) => boolean,
): number {
  return acquireExclusiveOwnership(file, owner, isAlive);
}

describe("exclusive ownership stale takeover", () => {
  it("recovers when successive processes crash while owning the lock and takeover gate", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-takeover-process-"));
    directories.push(directory);
    const file = path.join(directory, "daemon.lock");
    const script = path.join(directory, "crash-owner.mts");
    fs.writeFileSync(
      script,
      `import { acquireExclusiveOwnership } from ${JSON.stringify(pathToFileURL(path.resolve("src/exclusive-ownership.ts")).href)};
const [file, role] = process.argv.slice(2);
acquireExclusiveOwnership(role === "primary" ? file : file + ".takeover", {
  pid: process.pid,
  instanceId: role,
});
`,
    );
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
    await execFileAsync(process.execPath, [tsx, script, file, "primary"]);
    await execFileAsync(process.execPath, [tsx, script, file, "takeover"]);
    const owner = { pid: process.pid, instanceId: "successor" };

    const handle = acquireExclusiveOwnership(file, owner);
    try {
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(owner);
      expect(fs.existsSync(`${file}.takeover`)).toBe(false);
    } finally {
      releaseExclusiveOwnership(file, handle, owner);
    }
  });

  it("recovers after successive owners crash while holding takeover gates", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-takeover-crash-"));
    directories.push(directory);
    const file = path.join(directory, "daemon.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: 101, instanceId: "primary-crash" }));
    fs.writeFileSync(
      `${file}.takeover`,
      JSON.stringify({ pid: 102, instanceId: "first-takeover-crash" }),
    );
    fs.writeFileSync(
      `${file}.takeover.takeover`,
      JSON.stringify({ pid: 103, instanceId: "second-takeover-crash" }),
    );
    const owner = { pid: 999, instanceId: "successor" };

    const handle = acquireWithLiveness(file, owner, (pid) => pid === owner.pid);
    try {
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(owner);
      expect(fs.existsSync(`${file}.takeover`)).toBe(false);
      expect(fs.existsSync(`${file}.takeover.takeover`)).toBe(false);
    } finally {
      releaseExclusiveOwnership(file, handle, owner);
    }
  });

  it("does not displace a live takeover owner", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-takeover-live-"));
    directories.push(directory);
    const file = path.join(directory, "daemon.lock");
    const gateOwner = { pid: 202, instanceId: "live-takeover" };
    fs.writeFileSync(file, JSON.stringify({ pid: 201, instanceId: "primary-crash" }));
    fs.writeFileSync(`${file}.takeover`, JSON.stringify(gateOwner));

    expect(() =>
      acquireWithLiveness(file, { pid: 203, instanceId: "contender" }, (pid) => pid === 202),
    ).toThrow(/already owns|takeover/i);
    expect(JSON.parse(fs.readFileSync(`${file}.takeover`, "utf8"))).toEqual(gateOwner);
  });
});

describe("pid liveness", () => {
  it("treats EPERM as alive and only ESRCH as dead", () => {
    const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const missing = Object.assign(new Error("no such process"), { code: "ESRCH" });

    expect(
      pidIsAlive(101, () => {
        throw denied;
      }),
    ).toBe(true);
    expect(
      pidIsAlive(102, () => {
        throw missing;
      }),
    ).toBe(false);
  });
});
