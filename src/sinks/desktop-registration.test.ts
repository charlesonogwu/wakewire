import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  type DesktopConnectorCandidate,
  type DesktopRegistration,
  newestConnectorServers,
  refreshDesktopRegistration,
  selectDesktopConnector,
  writeFileAtomically,
} from "./desktop-registration.js";

const registration: DesktopRegistration = {
  threadId: "thread-1",
  cwd: "C:\\workspace",
  stateFile: "C:\\state\\receipts.db",
  inheritPermissions: true,
  serverPath: "C:\\old\\server.mjs",
  serverSha256: "a".repeat(64),
  pipePath: "\\\\.\\pipe\\old",
};

const first: DesktopConnectorCandidate = {
  serverPath: "C:\\cache\\0.1.4\\server.mjs",
  serverSha256: "b".repeat(64),
  pipePath: "\\\\.\\pipe\\current",
};

describe("selectDesktopConnector", () => {
  it("returns the sole connector that can verify the registered task", async () => {
    const probe = vi.fn(async (candidate: DesktopConnectorCandidate) => candidate === first);

    await expect(
      selectDesktopConnector(registration, [first, { ...first, pipePath: "other" }], probe),
    ).resolves.toEqual(first);
  });

  it("fails closed when no connector can verify the task", async () => {
    await expect(selectDesktopConnector(registration, [first], async () => false)).rejects.toThrow(
      "No Codex Desktop connector matches",
    );
  });

  it("fails closed when more than one connector verifies the task", async () => {
    await expect(
      selectDesktopConnector(
        registration,
        [first, { ...first, pipePath: "other" }],
        async () => true,
      ),
    ).rejects.toThrow("Multiple Codex Desktop connectors match");
  });
});

describe("newestConnectorServers", () => {
  it.each([
    ["Windows", "C:\\cache\\0.1.3\\server.mjs", "C:\\cache\\0.1.4\\server.mjs"],
    ["Linux and macOS", "/cache/0.1.3/server.mjs", "/cache/0.1.4/server.mjs"],
  ])(
    "uses only the newest installed connector version for %s paths",
    (_platform, oldPath, newPath) => {
      expect(newestConnectorServers([oldPath, newPath])).toEqual([newPath]);
    },
  );

  it.each(["0.1", "0.1.4.2", "0.1.x", "01.2.3", "1e3.2.3", "9007199254740992.1.1", ""])(
    "rejects invalid connector version %s before sorting",
    (version) => {
      expect(() =>
        newestConnectorServers([
          "C:\\cache\\0.1.4\\server.mjs",
          `C:\\cache\\${version}\\server.mjs`,
        ]),
      ).toThrow(/invalid connector version/i);
    },
  );
});

describe("refreshDesktopRegistration", () => {
  it("waits for a cross-process refresh before reading and replacing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-registration-"));
    const file = path.join(dir, "desktop-registration.json");
    const lockFile = `${file}.refresh.lock`;
    const locked = path.join(dir, "locked");
    const release = path.join(dir, "release");
    const script = path.join(dir, "holder.mts");
    fs.writeFileSync(file, JSON.stringify(registration));
    fs.writeFileSync(
      script,
      `import fs from "node:fs";
import { withExclusiveFileLock } from ${JSON.stringify(pathToFileURL(path.resolve("src/exclusive-ownership.ts")).href)};
const [file, lockFile, locked, release] = process.argv.slice(2);
await withExclusiveFileLock(lockFile, async () => {
  fs.writeFileSync(locked, "ready");
  while (!fs.existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 5));
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...current, coordination: { newer: true } }));
});
`,
    );
    const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
    const child = spawn(process.execPath, [tsx, script, file, lockFile, locked, release], {
      stdio: "inherit",
    });
    const childExit = new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child ${code}`))));
    });
    let probeCount = 0;
    try {
      await vi.waitFor(() => expect(fs.existsSync(locked)).toBe(true));
      const refresh = refreshDesktopRegistration(file, {
        candidates: () => [first],
        probe: async () => {
          probeCount += 1;
          return true;
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(probeCount).toBe(0);
      fs.writeFileSync(release, "go");
      await expect(refresh).resolves.toBe(true);
      await childExit;
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
        coordination: { newer: true },
        serverPath: first.serverPath,
      });
    } finally {
      fs.writeFileSync(release, "go");
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes overlapping refreshes for the same registration", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-registration-"));
    const file = path.join(dir, "desktop-registration.json");
    fs.writeFileSync(file, JSON.stringify(registration));
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstProbe = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let probeCount = 0;
    const dependencies = {
      candidates: () => [first],
      probe: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        probeCount += 1;
        if (probeCount === 1) await firstProbe;
        active -= 1;
        return true;
      },
    };
    let firstRefresh: Promise<boolean> | undefined;
    let secondRefresh: Promise<boolean> | undefined;
    try {
      firstRefresh = refreshDesktopRegistration(file, dependencies);
      await vi.waitFor(() => expect(probeCount).toBe(1));
      secondRefresh = refreshDesktopRegistration(file, dependencies);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(maximumActive).toBe(1);
      releaseFirst();

      await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([true, false]);
      expect(maximumActive).toBe(1);
    } finally {
      releaseFirst();
      await Promise.allSettled([firstRefresh, secondRefresh].filter(Boolean));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects an intervening registration change before replacement", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-registration-"));
    const file = path.join(dir, "desktop-registration.json");
    const original = `${JSON.stringify(registration, null, 2)}\n`;
    const intervening = `${JSON.stringify({ ...registration, pipePath: "external-change" }, null, 2)}\n`;
    fs.writeFileSync(file, original);
    try {
      await expect(
        refreshDesktopRegistration(file, {
          candidates: () => [first],
          probe: async () => {
            fs.writeFileSync(file, intervening);
            return true;
          },
        }),
      ).rejects.toThrow(/changed during refresh/i);
      expect(fs.readFileSync(file, "utf8")).toBe(intervening);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeFileAtomically", () => {
  it("replaces an existing registration with the complete new document", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-registration-"));
    const file = path.join(dir, "desktop-registration.json");
    fs.writeFileSync(file, "original\n");
    try {
      writeFileAtomically(file, "replacement\n");
      expect(fs.readFileSync(file, "utf8")).toBe("replacement\n");
      expect(fs.readdirSync(dir)).toEqual(["desktop-registration.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the original registration when replacement fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-registration-"));
    const file = path.join(dir, "desktop-registration.json");
    fs.writeFileSync(file, "original\n");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated replace failure");
    });
    try {
      expect(() => writeFileAtomically(file, "replacement\n")).toThrow("simulated replace failure");
      expect(fs.readFileSync(file, "utf8")).toBe("original\n");
      expect(fs.readdirSync(dir)).toEqual(["desktop-registration.json"]);
    } finally {
      rename.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes its temporary file when writing fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-registration-"));
    const file = path.join(dir, "desktop-registration.json");
    fs.writeFileSync(file, "original\n");
    const writeFileSync = fs.writeFileSync.bind(fs);
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((target, ...args) => {
      if (typeof target === "number") throw new Error("simulated write failure");
      return Reflect.apply(writeFileSync, fs, [target, ...args] as Parameters<
        typeof fs.writeFileSync
      >);
    });
    try {
      expect(() => writeFileAtomically(file, "replacement\n")).toThrow("simulated write failure");
      expect(fs.readFileSync(file, "utf8")).toBe("original\n");
      expect(fs.readdirSync(dir)).toEqual(["desktop-registration.json"]);
    } finally {
      write.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes its temporary file when fsync fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-registration-"));
    const file = path.join(dir, "desktop-registration.json");
    fs.writeFileSync(file, "original\n");
    const fsync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("simulated fsync failure");
    });
    try {
      expect(() => writeFileAtomically(file, "replacement\n")).toThrow("simulated fsync failure");
      expect(fs.readFileSync(file, "utf8")).toBe("original\n");
      expect(fs.readdirSync(dir)).toEqual(["desktop-registration.json"]);
    } finally {
      fsync.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
