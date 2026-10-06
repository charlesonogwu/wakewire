import { generateKeyPairSync, sign } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrations.js";
import { buildArtifactEnvelope } from "./artifact.js";
import { canonicalJson } from "./crypto.js";
import { executeRelease, type RuntimeCallbacks } from "./executor.js";
import type { GenesisAdapterRecord } from "./genesis.js";
import { openDeployJournal } from "./journal.js";
import type { EngineeringOwnerRecord } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function signed<T extends object>(body: T): T & { signature: string } {
  return {
    ...body,
    signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url"),
  };
}

function readyJournal() {
  const db = new DatabaseConstructor(":memory:");
  migrate(db);
  const journal = openDeployJournal(db);
  const initial: EngineeringOwnerRecord = signed({
    repositoryId: "repo-a",
    owner: "legacy" as const,
    phase: "stable" as const,
    generation: 1,
    deploymentActivationEnabled: false,
    updatedAt: "2026-10-06T00:00:00.000Z",
  });
  journal.seedOwner(initial);
  journal.beginDrain("repo-a", 1);
  const next: EngineeringOwnerRecord = signed({
    repositoryId: "repo-a",
    owner: "omarchy" as const,
    phase: "stable" as const,
    generation: 2,
    deploymentActivationEnabled: true,
    updatedAt: "2026-10-06T00:00:00.000Z",
  });
  const genesis: GenesisAdapterRecord = signed({
    repositoryId: "repo-a",
    adapterVersion: "1",
    adapterDigest: "d".repeat(64),
    mergeSha: "a".repeat(40),
    treeHash: "b".repeat(40),
    mergeEventId: "adapter-merge",
    targetGeneration: 2,
  });
  journal.completeOwnerChange({
    repositoryId: "repo-a",
    expectedGeneration: 1,
    next,
    genesis,
    publicKey,
    rollback: false,
  });
  return { db, journal };
}

function callbacks(log: string[], overrides: Partial<RuntimeCallbacks> = {}): RuntimeCallbacks {
  return {
    busy: () => {
      log.push("busy");
      return false;
    },
    lease: () => {
      log.push("lease");
      return { release: () => log.push("release-lease") };
    },
    idle: () => {
      log.push("idle");
      return true;
    },
    orderingOk: () => {
      log.push("order");
      return true;
    },
    write: () => log.push("write"),
    restore: () => log.push("restore"),
    previous: () => new Map(),
    ...overrides,
  };
}

function envelope(bytes = Buffer.from("print(1)\n"), repositoryId = "repo-a") {
  return buildArtifactEnvelope({
    repositoryId,
    mergeSha: "c".repeat(40),
    treeHash: "b".repeat(40),
    adapterVersion: "1",
    architecture: "x64",
    runtimeVersions: { python: "3.11" },
    compatibility: "reversible",
    files: [{ path: "src/app.py", mode: 0o100644, bytes }],
    expectedArchitecture: "x64",
    expectedRuntimeVersions: { python: "3.11" },
    adapterIntroducedByMerge: null,
    signingKey: privateKey,
  });
}

describe("executeRelease", () => {
  it("checks busy before taking a lease and restores a partial write", () => {
    const { journal } = readyJournal();
    const log: string[] = [];
    const busy = executeRelease({
      envelope: envelope(),
      bytes: new Map([["src/app.py", Buffer.from("print(1)\n")]]),
      publicKey,
      expected: {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      },
      journal,
      intentId: null,
      adapterRollback: "files",
      callbacks: callbacks(log, { busy: () => true }),
      token: 1,
      receiptId: "r-busy",
      replay: false,
    });
    expect(busy.status).toBe("pending");
    expect(log).toEqual([]);
    expect(journal.tryAcquire(1)).toBe("acquired");
    journal.release(1);
    const order: string[] = [];
    const previous = new Map([["src/app.py", Buffer.from("previous")]]);
    let restored: ReadonlyMap<string, Buffer> | undefined;
    const acquire = journal.tryAcquire.bind(journal);
    journal.tryAcquire = (token: number) => {
      const result = acquire(token);
      if (result === "acquired") order.push("lock");
      return result;
    };
    executeRelease({
      envelope: envelope(),
      bytes: new Map([["src/app.py", Buffer.from("print(1)\n")]]),
      publicKey,
      expected: {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      },
      journal,
      intentId: null,
      adapterRollback: "files",
      callbacks: callbacks(order, {
        previous: () => previous,
        restore: (manifest) => {
          order.push("restore");
          restored = manifest;
        },
        write: () => {
          order.push("write");
          throw new Error("partial");
        },
      }),
      token: 2,
      receiptId: "r-partial",
      replay: false,
    });
    expect(order.indexOf("busy")).toBeLessThan(order.indexOf("lease"));
    expect(order.indexOf("lease")).toBeLessThan(order.indexOf("idle"));
    expect(order.indexOf("idle")).toBeLessThan(order.indexOf("lock"));
    expect(order.indexOf("lock")).toBeLessThan(order.indexOf("order"));
    expect(restored).toBe(previous);
  });

  it("emits nothing-to-deploy without writing and fences an unsafe rollback", () => {
    const { journal } = readyJournal();
    const empty = buildArtifactEnvelope({
      repositoryId: "repo-a",
      mergeSha: "c".repeat(40),
      treeHash: "b".repeat(40),
      adapterVersion: "1",
      architecture: "x64",
      runtimeVersions: { python: "3.11" },
      compatibility: "reversible",
      files: [{ path: "docs/readme.md", mode: 0o100644, bytes: Buffer.from("# doc\n") }],
      expectedArchitecture: "x64",
      expectedRuntimeVersions: { python: "3.11" },
      adapterIntroducedByMerge: null,
      signingKey: privateKey,
    });
    const log: string[] = [];
    const result = executeRelease({
      envelope: empty,
      bytes: new Map(),
      publicKey,
      expected: {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      },
      journal,
      intentId: null,
      adapterRollback: "files",
      callbacks: callbacks(log),
      token: 4,
      receiptId: "r-empty",
      replay: false,
    });
    expect(result.status).toBe("nothing-to-deploy");
    expect(log).not.toContain("write");
    expect(journal.pause("repo-a")).toBeNull();
    expect(journal.pendingReceipts()).not.toContain("r-empty");
    const fenced = executeRelease({
      envelope: envelope(),
      bytes: new Map([["src/app.py", Buffer.from("print(1)\n")]]),
      publicKey,
      expected: {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      },
      journal,
      intentId: null,
      adapterRollback: "unsafe",
      callbacks: callbacks([], {
        write: () => {
          throw new Error("no");
        },
      }),
      token: 5,
      receiptId: "r-fence",
      replay: false,
    });
    expect(fenced.status).toBe("fenced");
    expect(journal.tryAcquire(6)).toBe("fenced");
  });

  it("does not write again when the receipt is already acknowledged", () => {
    const { journal } = readyJournal();
    const bytes = new Map([["src/app.py", Buffer.from("print(1)\n")]]);
    const request = {
      envelope: envelope(),
      bytes,
      publicKey,
      expected: {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      },
      journal,
      intentId: null,
      adapterRollback: "files" as const,
      token: 7,
      receiptId: "r-once",
      replay: false,
    };
    let writes = 0;
    executeRelease({
      ...request,
      callbacks: callbacks([], {
        write: () => {
          writes += 1;
        },
      }),
    });
    executeRelease({
      ...request,
      replay: true,
      token: 8,
      callbacks: callbacks([], {
        write: () => {
          writes += 1;
        },
      }),
    });
    expect(writes).toBe(1);
    expect(journal.tryAcquire(9)).toBe("acquired");
    journal.release(9);
    journal.enqueueReceipt("r-pending", null, "deployed");
    let replayWrites = 0;
    const replayed = executeRelease({
      ...request,
      receiptId: "r-pending",
      replay: true,
      token: 10,
      callbacks: callbacks([], {
        write: () => {
          replayWrites += 1;
        },
      }),
    });
    expect(replayed.status).toBe("deployed");
    expect(replayWrites).toBe(0);
    expect(journal.pendingReceipts()).not.toContain("r-pending");
  });

  it("releases the lock when verification fails before any write", () => {
    const { journal } = readyJournal();
    const forged = { ...envelope(), signature: "not-a-signature" };
    expect(() =>
      executeRelease({
        envelope: forged,
        bytes: new Map([["src/app.py", Buffer.from("print(1)\n")]]),
        publicKey,
        expected: {
          architecture: "x64",
          runtimeVersions: { python: "3.11" },
          repositoryId: "repo-a",
        },
        journal,
        intentId: null,
        adapterRollback: "files",
        callbacks: callbacks([]),
        token: 3,
        receiptId: "r-bad",
        replay: false,
      }),
    ).toThrow(/signature/);
    expect(journal.tryAcquire(4)).toBe("acquired");
  });

  it("keeps another repository pending while this activation holds the lock", () => {
    const { journal } = readyJournal();
    adopt(journal, "repo-b");
    let other: { status: string } | undefined;
    const otherLog: string[] = [];
    executeRelease({
      envelope: envelope(),
      bytes: new Map([["src/app.py", Buffer.from("print(1)\n")]]),
      publicKey,
      expected: {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      },
      journal,
      intentId: null,
      adapterRollback: "files",
      callbacks: callbacks([], {
        write: () => {
          other = executeRelease({
            envelope: envelope(Buffer.from("print(2)\n"), "repo-b"),
            bytes: new Map([["src/app.py", Buffer.from("print(2)\n")]]),
            publicKey,
            expected: {
              architecture: "x64",
              runtimeVersions: { python: "3.11" },
              repositoryId: "repo-b",
            },
            journal,
            intentId: null,
            adapterRollback: "files",
            callbacks: callbacks(otherLog),
            token: 12,
            receiptId: "r-other",
            replay: false,
          });
        },
      }),
      token: 11,
      receiptId: "r-holder",
      replay: false,
    });
    expect(other?.status).toBe("pending");
    expect(otherLog).not.toContain("write");
    expect(journal.pause("repo-b")).toBeNull();
    expect(otherLog.indexOf("busy")).toBeLessThan(otherLog.indexOf("lease"));
    expect(otherLog.indexOf("lease")).toBeLessThan(otherLog.indexOf("idle"));
  });

  it("returns fenced for a later attempt after unsafe rollback", () => {
    const { journal } = readyJournal();
    executeRelease({
      envelope: envelope(),
      bytes: new Map([["src/app.py", Buffer.from("print(1)\n")]]),
      publicKey,
      expected: {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      },
      journal,
      intentId: null,
      adapterRollback: "unsafe",
      callbacks: callbacks([], {
        write: () => {
          throw new Error("no");
        },
      }),
      token: 5,
      receiptId: "r-fence-later",
      replay: false,
    });
    let writes = 0;
    const later = executeRelease({
      envelope: envelope(),
      bytes: new Map([["src/app.py", Buffer.from("print(1)\n")]]),
      publicKey,
      expected: {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      },
      journal,
      intentId: null,
      adapterRollback: "files",
      callbacks: callbacks([], {
        write: () => {
          writes += 1;
        },
      }),
      token: 6,
      receiptId: "r-after-fence",
      replay: false,
    });
    expect(later.status).toBe("fenced");
    expect(writes).toBe(0);
  });

  it("does not report a missing replay receipt as an acknowledged deployment", () => {
    const { journal } = readyJournal();
    let writes = 0;
    const result = executeRelease({
      envelope: envelope(),
      bytes: new Map([["src/app.py", Buffer.from("print(1)\n")]]),
      publicKey,
      expected: {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      },
      journal,
      intentId: null,
      adapterRollback: "files",
      callbacks: callbacks([], {
        write: () => {
          writes += 1;
        },
      }),
      token: 7,
      receiptId: "missing",
      replay: true,
    });
    expect({ status: result.status, writes }).not.toEqual({ status: "deployed", writes: 0 });
  });
});

function adopt(journal: ReturnType<typeof readyJournal>["journal"], repositoryId: string) {
  journal.seedOwner(
    signed({
      repositoryId,
      owner: "legacy" as const,
      phase: "stable" as const,
      generation: 1,
      deploymentActivationEnabled: false,
      updatedAt: "2026-10-06T00:00:00.000Z",
    }),
  );
  journal.beginDrain(repositoryId, 1);
  journal.completeOwnerChange({
    repositoryId,
    expectedGeneration: 1,
    next: signed({
      repositoryId,
      owner: "omarchy" as const,
      phase: "stable" as const,
      generation: 2,
      deploymentActivationEnabled: true,
      updatedAt: "2026-10-06T00:00:00.000Z",
    }),
    genesis: signed({
      repositoryId,
      adapterVersion: "1",
      adapterDigest: "d".repeat(64),
      mergeSha: "a".repeat(40),
      treeHash: "b".repeat(40),
      mergeEventId: `adapter-${repositoryId}`,
      targetGeneration: 2,
    }),
    publicKey,
    rollback: false,
  });
}
