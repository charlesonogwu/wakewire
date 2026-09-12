import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDesktopAdapter, type DesktopToolClient } from "../sinks/codex-desktop.js";
import { RefreshingDesktopMcpClient } from "../sinks/desktop-refreshing-client.js";
import { CoordinationAdapter } from "./adapter.js";
import { GithubSnapshotClient } from "./github.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("CoordinationAdapter close", () => {
  it("awaits Desktop refresh, generation close, and receipt cleanup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-coordination-close-"));
    directories.push(directory);
    const refreshStarted = deferred<void>();
    const refreshGate = deferred<boolean>();
    const generationCloseGate = deferred<void>();
    const stale: DesktopToolClient = {
      call: vi.fn().mockRejectedValue(new Error("stale connector")),
      close: vi.fn(() => generationCloseGate.promise),
    };
    const refreshing = new RefreshingDesktopMcpClient(path.join(directory, "registration.json"), {
      refresh: () => {
        refreshStarted.resolve();
        return refreshGate.promise;
      },
      readRegistration: () => ({}),
      makeClient: () => stale,
    });
    const desktop = new CodexDesktopAdapter(
      {
        threadId: "thread-1",
        cwd: directory,
        stateFile: path.join(directory, "receipts.db"),
        inheritPermissions: true,
      },
      refreshing,
    );
    const snapshots = new GithubSnapshotClient("example/project", async () => {
      throw new Error("unexpected snapshot request");
    });
    const adapter = new CoordinationAdapter(
      {
        expectedRepository: "example/project",
        localAgent: "codex",
        trustedAuthorIds: { codex: ["101"], hermes: ["202"] },
        waitingLabel: "waiting:owner",
      },
      snapshots,
      desktop,
    );
    const pendingRead = refreshing.call("read_thread", { threadId: "thread-1", hostId: "local" });
    const handledRead = pendingRead.catch((error: unknown) => error);

    try {
      await refreshStarted.promise;
      let closeFinished = false;
      const closing = Promise.resolve(adapter.close()).then(() => {
        closeFinished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(closeFinished).toBe(false);
      refreshGate.resolve(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(closeFinished).toBe(false);
      generationCloseGate.resolve();

      await closing;
      expect(await handledRead).toMatchObject({ message: expect.stringMatching(/closed/i) });
      expect(stale.close).toHaveBeenCalledTimes(1);
      expect(() => fs.rmSync(directory, { recursive: true })).not.toThrow();
      directories.pop();
    } finally {
      refreshGate.resolve(true);
      generationCloseGate.resolve();
      await desktop.close();
      await handledRead;
    }
  });
});
