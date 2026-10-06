import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrations.js";
import type { RuntimeAdapter } from "./adapter.js";
import { buildArtifactEnvelope } from "./artifact.js";
import { createBroker, createGuardedTransport } from "./broker.js";
import { advanceCandidate, blankCandidate } from "./candidate.js";
import { canonicalJson } from "./crypto.js";
import { executeRelease, type RuntimeCallbacks } from "./executor.js";
import type { GenesisAdapterRecord } from "./genesis.js";
import { type DeployJournal, openDeployJournal } from "./journal.js";
import { recover } from "./recovery.js";
import { loadRegistry } from "./registry.js";
import { createDeploymentService } from "./service.js";
import { createReviewHostRouter } from "./t3.js";
import type { LaneRecord } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
const authorKeys = generateKeyPairSync("ed25519");
const reviewerKeys = generateKeyPairSync("ed25519");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TREE = "c".repeat(40);

function signed<T extends object>(body: T, key = privateKey): T & { signature: string } {
  return {
    ...body,
    signature: sign(null, Buffer.from(canonicalJson(body)), key).toString("base64url"),
  };
}

function trustedAdapter(
  repositoryId: string,
  rollback: RuntimeAdapter["rollback"] = "files",
  deny: string[] = [".env"],
): RuntimeAdapter {
  return {
    version: "1",
    repositoryId,
    allow: ["src/", "docs/"],
    deny,
    runtimeTargetId: "runtime-a",
    busyCheckId: "busy-a",
    verifyCheckId: "verify-a",
    reloadId: "reload-a",
    rollback,
    architecture: "x64",
    runtimeVersions: { node: "20" },
    verificationKeyId: "pinned-key",
  };
}

function hooks(overrides: Partial<RuntimeCallbacks> = {}): RuntimeCallbacks {
  return {
    runtimeTargetId: "runtime-a",
    busyCheckId: "busy-a",
    verifyCheckId: "verify-a",
    reloadId: "reload-a",
    busy: () => false,
    lease: () => ({ release() {} }),
    idle: () => true,
    orderingOk: () => true,
    write: () => undefined,
    restore: () => undefined,
    previous: () => new Map(),
    reload: () => undefined,
    verify: () => true,
    verifyRestore: () => true,
    deliverReceipt: () => true,
    observe: () => "",
    ...overrides,
  };
}

function pinRelease(
  store: DeployJournal,
  repositoryId: string,
  rollback: RuntimeAdapter["rollback"] = "files",
  deny?: string[],
): string {
  store.pinTrust("pinned-key", publicKey);
  return store.pinAdapter(trustedAdapter(repositoryId, rollback, deny));
}

function journal(): { db: DatabaseConstructor.Database; store: DeployJournal } {
  const db = new DatabaseConstructor(":memory:");
  migrate(db);
  const store = openDeployJournal(db);
  store.seedOwner(
    signed({
      repositoryId: "repo-a",
      owner: "legacy" as const,
      phase: "stable" as const,
      generation: 1,
      deploymentActivationEnabled: false,
      updatedAt: "2026-10-06T00:00:00.000Z",
    }),
    "pinned-key",
  );
  return { db, store };
}

describe("second review probes", () => {
  it("substituted-key probe rejects a verifier key supplied on the owner change", () => {
    const { db, store } = journal();
    store.seedOwner(
      signed({
        repositoryId: "repo-b",
        owner: "legacy" as const,
        phase: "stable" as const,
        generation: 1,
        deploymentActivationEnabled: false,
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      "pinned-key",
    );
    store.beginDrain("repo-b", 1);
    const next = signed(
      {
        repositoryId: "repo-b",
        owner: "omarchy" as const,
        phase: "stable" as const,
        generation: 2,
        deploymentActivationEnabled: true,
        updatedAt: "2026-10-06T00:00:00.000Z",
      },
      attacker.privateKey,
    );
    const genesis = signed(
      {
        repositoryId: "repo-b",
        adapterVersion: "1",
        adapterDigest: "d".repeat(64),
        mergeSha: SHA_A,
        treeHash: SHA_B,
        mergeEventId: "adapter-repo-b",
        targetGeneration: 2,
      },
      attacker.privateKey,
    );
    store.pinTrust("pinned-key", publicKey);
    expect(() => store.pinTrust("pinned-key", attacker.publicKey)).toThrow(/immutable/);
    expect(() =>
      store.completeOwnerChange({
        repositoryId: "repo-b",
        expectedGeneration: 1,
        next,
        genesis,
        rollback: false,
        keyId: "pinned-key",
      }),
    ).toThrow(/signature|trust|key/);
    expect(store.consumedGenesis("repo-b")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM deploy_genesis").get()).toEqual({ count: 0 });
  });

  it("trusted-digest probe ignores a malicious supplied .env policy", () => {
    const { store } = journal();
    const digest = pinRelease(store, "repo-a", "files", [".env"]);
    store.beginDrain("repo-a", 1);
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: signed({
        repositoryId: "repo-a",
        owner: "omarchy" as const,
        phase: "stable" as const,
        generation: 2,
        deploymentActivationEnabled: true,
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      genesis: signed({
        repositoryId: "repo-a",
        adapterVersion: "1",
        adapterDigest: digest,
        mergeSha: SHA_A,
        treeHash: SHA_B,
        mergeEventId: "adapter-repo-a",
        targetGeneration: 2,
      }),
      rollback: false,
      keyId: "pinned-key",
    });
    store.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: null,
      notice: null,
      deliveryId: "d1",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      headSha: SHA_A,
      baseSha: SHA_B,
      pr: 1,
    });
    const bytes = Buffer.from("SECRET=1\n");
    const envelope = buildArtifactEnvelope({
      repositoryId: "repo-a",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      adapterVersion: "1",
      architecture: "x64",
      runtimeVersions: { node: "20" },
      compatibility: "reversible",
      files: [{ path: ".env", mode: 0o100644, bytes }],
      expectedArchitecture: "x64",
      expectedRuntimeVersions: { node: "20" },
      adapterIntroducedByMerge: null,
      signingKey: privateKey,
    });
    let writes = 0;
    expect(() =>
      executeRelease({
        envelope,
        bytes: new Map([[".env", bytes]]),
        expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
        journal: store,
        intentId: "intent-d1",
        adapterDigest: "d".repeat(64),
        adapterPolicy: { allow: [".env"], deny: [] },
        adapterRollback: "files",
        callbacks: hooks({
          write: () => {
            writes += 1;
          },
        }),
        token: 1,
        receiptId: "r-env",
        replay: false,
      }),
    ).toThrow(/policy|deny|adapter/);
    expect(writes).toBe(0);
  });

  it("holds cutover and admission while a deployment lease is unreleased", () => {
    const { store } = journal();
    store.acquireLease({
      id: "deploy-1",
      repositoryId: "repo-a",
      generation: 1,
      kind: "deployment",
    });
    store.beginDrain("repo-a", 1);
    expect(() =>
      store.completeOwnerChange({
        repositoryId: "repo-a",
        expectedGeneration: 1,
        next: signed({
          repositoryId: "repo-a",
          owner: "omarchy" as const,
          phase: "stable" as const,
          generation: 2,
          deploymentActivationEnabled: true,
          updatedAt: "2026-10-06T00:00:00.000Z",
        }),
        genesis: signed({
          repositoryId: "repo-a",
          adapterVersion: "1",
          adapterDigest: "d".repeat(64),
          mergeSha: SHA_A,
          treeHash: SHA_B,
          mergeEventId: "adapter-repo-a",
          targetGeneration: 2,
        }) as GenesisAdapterRecord,
        rollback: false,
        keyId: "pinned-key",
      }),
    ).toThrow(/active|lease/);
    store.releaseLease("deploy-1");
    expect(() =>
      store.acquireLease({
        id: "deploy-2",
        repositoryId: "repo-a",
        generation: 1,
        kind: "deployment",
      }),
    ).toThrow(/draining/);
    const digest = pinRelease(store, "repo-a");
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: signed({
        repositoryId: "repo-a",
        owner: "omarchy" as const,
        phase: "stable" as const,
        generation: 2,
        deploymentActivationEnabled: true,
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      genesis: signed({
        repositoryId: "repo-a",
        adapterVersion: "1",
        adapterDigest: digest,
        mergeSha: SHA_A,
        treeHash: SHA_B,
        mergeEventId: "adapter-repo-a",
        targetGeneration: 2,
      }),
      rollback: false,
      keyId: "pinned-key",
    });
    store.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: null,
      notice: null,
      deliveryId: "d1",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      headSha: SHA_A,
      baseSha: SHA_B,
      pr: 1,
    });
    const bytes = Buffer.from("print(1)\n");
    const envelope = buildArtifactEnvelope({
      repositoryId: "repo-a",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      adapterVersion: "1",
      architecture: "x64",
      runtimeVersions: { node: "20" },
      compatibility: "reversible",
      files: [{ path: "src/app.py", mode: 0o100644, bytes }],
      expectedArchitecture: "x64",
      expectedRuntimeVersions: { node: "20" },
      adapterIntroducedByMerge: null,
      signingKey: privateKey,
    });
    let heldLease = false;
    let cutoverError = "";
    executeRelease({
      envelope,
      bytes: new Map([["src/app.py", bytes]]),
      expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
      journal: store,
      intentId: "intent-d1",
      callbacks: hooks({
        write: () => {
          heldLease = store.activeDeploymentLease("repo-a");
          store.beginDrain("repo-a", 2);
          try {
            store.completeOwnerChange({
              repositoryId: "repo-a",
              expectedGeneration: 2,
              next: signed({
                repositoryId: "repo-a",
                owner: "omarchy" as const,
                phase: "stable" as const,
                generation: 3,
                deploymentActivationEnabled: true,
                updatedAt: "2026-10-06T00:00:00.000Z",
              }),
              genesis: null,
              rollback: false,
              keyId: "pinned-key",
            });
          } catch (error) {
            cutoverError = error instanceof Error ? error.message : "error";
          }
        },
      }),
      token: 3,
      receiptId: "r-lease",
      replay: false,
    });
    expect(heldLease).toBe(true);
    expect(cutoverError).toMatch(/active|lease/);
  });

  it("original-withdraw-approval demotes merge-ready", () => {
    let state = blankCandidate({
      repositoryId: "repo-a",
      pr: 7,
      headSha: SHA_A,
      baseSha: SHA_A,
      treeHash: TREE,
    });
    state = advanceCandidate(state, { type: "checks", checks: "success" });
    state = advanceCandidate(state, {
      type: "verdict",
      verdict: {
        role: "author",
        decision: "approve",
        headSha: SHA_A,
        baseSha: SHA_A,
        treeHash: TREE,
      },
    });
    state = advanceCandidate(state, {
      type: "verdict",
      verdict: {
        role: "reviewer",
        decision: "approve",
        headSha: SHA_A,
        baseSha: SHA_A,
        treeHash: TREE,
      },
    });
    expect(state.state).toBe("merge-ready");
    const withdrawn = advanceCandidate(state, {
      type: "verdict",
      verdict: {
        role: "reviewer",
        decision: "reject",
        headSha: SHA_A,
        baseSha: SHA_A,
        treeHash: TREE,
      },
    });
    expect(withdrawn.state).not.toBe("merge-ready");
  });

  it("original-checks-pending demotes merge-ready", () => {
    let state = blankCandidate({
      repositoryId: "repo-a",
      pr: 7,
      headSha: SHA_A,
      baseSha: SHA_A,
      treeHash: TREE,
    });
    state = advanceCandidate(state, { type: "checks", checks: "success" });
    state = advanceCandidate(state, {
      type: "verdict",
      verdict: {
        role: "author",
        decision: "approve",
        headSha: SHA_A,
        baseSha: SHA_A,
        treeHash: TREE,
      },
    });
    state = advanceCandidate(state, {
      type: "verdict",
      verdict: {
        role: "reviewer",
        decision: "approve",
        headSha: SHA_A,
        baseSha: SHA_A,
        treeHash: TREE,
      },
    });
    const pending = advanceCandidate(state, { type: "checks", checks: "pending" });
    expect(pending.state).not.toBe("merge-ready");
    expect(pending.checks).toBe("pending");
  });

  it("binds verdicts to the issued registry role and keeps wake dedupe after restart", async () => {
    const lane: LaneRecord = {
      laneId: "a",
      repositoryId: "repo-a",
      github: { owner: "example", name: "one" },
      roots: { checkout: "/srv/a/checkout", worktree: "/srv/a/worktree", cache: "/srv/a/cache" },
      threads: {
        author: { projectId: "pa", threadId: "author-thread" },
        reviewer: { projectId: "pr", threadId: "review-thread" },
      },
      adapterPath: "/srv/a/adapter.json",
    };
    const db = new DatabaseConstructor(":memory:");
    migrate(db);
    const transport = {
      async deliver() {
        return undefined;
      },
    };
    const authority = { author: authorKeys.publicKey, reviewer: reviewerKeys.publicKey };
    const first = createReviewHostRouter([lane], transport, authority, { db });
    const wake = {
      laneId: "a",
      role: "reviewer" as const,
      requestId: "r1",
      repositoryId: "repo-a",
      pr: 7,
      headSha: SHA_A,
      baseSha: SHA_B,
      treeHash: TREE,
    };
    await first.wake(wake);
    const restarted = createReviewHostRouter([lane], transport, authority, { db });
    await expect(restarted.wake(wake)).rejects.toThrow(/duplicate/);
    const mismatched = {
      laneId: "a",
      role: "reviewer" as const,
      requestId: "r1",
      repositoryId: "repo-a",
      pr: 8,
      decision: "approve" as const,
      headSha: SHA_A,
      baseSha: SHA_B,
      treeHash: TREE,
    };
    expect(() =>
      restarted.ingestVerdict({
        ...mismatched,
        signature: sign(
          null,
          Buffer.from(canonicalJson(mismatched)),
          authorKeys.privateKey,
        ).toString("base64url"),
      }),
    ).toThrow(/role|key|request|pr/);
    const matching = {
      laneId: "a",
      role: "reviewer" as const,
      requestId: "r1",
      repositoryId: "repo-a",
      pr: 7,
      decision: "approve" as const,
      headSha: SHA_A,
      baseSha: SHA_B,
      treeHash: TREE,
    };
    expect(() =>
      restarted.ingestVerdict({
        ...matching,
        signature: sign(null, Buffer.from(canonicalJson(matching)), authorKeys.privateKey).toString(
          "base64url",
        ),
      }),
    ).toThrow(/signature|key|role/);
    expect(
      restarted.ingestVerdict({
        ...matching,
        signature: sign(
          null,
          Buffer.from(canonicalJson(matching)),
          reviewerKeys.privateKey,
        ).toString("base64url"),
      }).requestId,
    ).toBe("r1");
    const reviewerBroker = createBroker(
      createGuardedTransport({
        async request() {
          return { ok: true };
        },
      }),
      { owner: "example", name: "one", branches: ["review/lane-a"] },
      "reviewer",
    );
    await expect(
      reviewerBroker.publishBranch({
        owner: "example",
        name: "one",
        branch: "review/lane-a",
        sha: SHA_A,
        role: "author",
      }),
    ).rejects.toThrow(/author|role/);
  });

  it("observes runtime through a fixed callback and copies once across crash recovery", () => {
    const { db, store } = journal();
    const digest = pinRelease(store, "repo-a");
    store.beginDrain("repo-a", 1);
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: signed({
        repositoryId: "repo-a",
        owner: "omarchy" as const,
        phase: "stable" as const,
        generation: 2,
        deploymentActivationEnabled: true,
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      genesis: signed({
        repositoryId: "repo-a",
        adapterVersion: "1",
        adapterDigest: digest,
        mergeSha: SHA_A,
        treeHash: SHA_B,
        mergeEventId: "adapter-repo-a",
        targetGeneration: 2,
      }),
      rollback: false,
      keyId: "pinned-key",
    });
    store.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: null,
      notice: null,
      deliveryId: "d1",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      headSha: SHA_A,
      baseSha: SHA_B,
      pr: 1,
    });
    store.recordManifest("intent-d1", "manifest-a");
    expect(store.tryAcquire(4, { repositoryId: "repo-a", intentId: "intent-d1" })).toBe("acquired");
    store.retain(4, "uncertain");
    expect(
      recover(
        db,
        { repositoryId: "repo-a", intentId: "intent-d1", token: 4 },
        () => "other-runtime",
      ),
    ).toBe("fenced");
    expect(
      recover(db, { repositoryId: "repo-a", intentId: "intent-d1", token: 4 }, () => "manifest-a"),
    ).toBe("cleared");
    const bytes = Buffer.from("print(1)\n");
    const previousBytes = Buffer.from("old-bytes");
    const envelope = buildArtifactEnvelope({
      repositoryId: "repo-a",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      adapterVersion: "1",
      architecture: "x64",
      runtimeVersions: { node: "20" },
      compatibility: "reversible",
      files: [{ path: "src/app.py", mode: 0o100644, bytes }],
      expectedArchitecture: "x64",
      expectedRuntimeVersions: { node: "20" },
      adapterIntroducedByMerge: null,
      signingKey: privateKey,
    });
    let copies = 0;
    let previousReads = 0;
    let savedBeforeCopy = false;
    let crashed = false;
    const release = (token: number, receiptId: string) =>
      executeRelease({
        envelope,
        bytes: new Map([["src/app.py", bytes]]),
        expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
        journal: store,
        intentId: "intent-d1",
        callbacks: hooks({
          previous: () => {
            previousReads += 1;
            if (previousReads > 1) throw new Error("previous bytes were read again");
            return new Map([["src/app.py", previousBytes]]);
          },
          write: () => {
            copies += 1;
            savedBeforeCopy =
              store.previousFiles("intent-d1").get("src/app.py")?.equals(previousBytes) ?? false;
          },
          afterMutation: () => {
            if (!crashed) {
              crashed = true;
              throw new Error("crash after copy");
            }
          },
          observe: () => store.intentRecord("intent-d1")?.targetManifest ?? "",
        }),
        token,
        receiptId,
        replay: false,
      });
    expect(release(5, "r-copy").status).toBe("fenced");
    expect(copies).toBe(1);
    expect(savedBeforeCopy).toBe(true);
    const target = store.intentRecord("intent-d1")?.targetManifest ?? "";
    expect(target.length).toBeGreaterThan(0);
    expect(
      recover(db, { repositoryId: "repo-a", intentId: "intent-d1", token: 5 }, () => "caller-hash"),
    ).toBe("fenced");
    expect(
      recover(db, { repositoryId: "repo-a", intentId: "intent-d1", token: 5 }, () => target),
    ).toBe("cleared");
    expect(release(6, "r-retry").status).toBe("deployed");
    expect(copies).toBe(1);
    expect(previousReads).toBe(1);
  });

  it("records every fence, resends an unacked receipt, and clears only the linked repair", () => {
    const { store } = journal();
    const digest = pinRelease(store, "repo-a", "unsafe");
    store.beginDrain("repo-a", 1);
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: signed({
        repositoryId: "repo-a",
        owner: "omarchy" as const,
        phase: "stable" as const,
        generation: 2,
        deploymentActivationEnabled: true,
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      genesis: signed({
        repositoryId: "repo-a",
        adapterVersion: "1",
        adapterDigest: digest,
        mergeSha: SHA_A,
        treeHash: SHA_B,
        mergeEventId: "adapter-repo-a",
        targetGeneration: 2,
      }),
      rollback: false,
      keyId: "pinned-key",
    });
    store.pauseForRepair("repo-a", "repair-1", "linked repair");
    store.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: "repair-9",
      notice: null,
      deliveryId: "other-repair",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      headSha: SHA_A,
      baseSha: SHA_B,
      pr: 2,
    });
    const docs = buildArtifactEnvelope({
      repositoryId: "repo-a",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      adapterVersion: "1",
      architecture: "x64",
      runtimeVersions: { node: "20" },
      compatibility: "reversible",
      files: [{ path: "docs/readme.md", mode: 0o100644, bytes: Buffer.from("# doc\n") }],
      expectedArchitecture: "x64",
      expectedRuntimeVersions: { node: "20" },
      adapterIntroducedByMerge: null,
      signingKey: privateKey,
    });
    expect(
      executeRelease({
        envelope: docs,
        bytes: new Map(),
        expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
        journal: store,
        intentId: "intent-other-repair",
        callbacks: hooks({
          write: () => {
            throw new Error("unlinked repair must not deploy");
          },
        }),
        token: 2,
        receiptId: "r-other",
        replay: false,
      }).status,
    ).toBe("pending");
    expect(store.pause("repo-a")?.repairId).toBe("repair-1");
    store.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: "repair-1",
      notice: null,
      deliveryId: "linked-repair",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      headSha: SHA_A,
      baseSha: SHA_B,
      pr: 3,
    });
    expect(
      executeRelease({
        envelope: docs,
        bytes: new Map(),
        expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
        journal: store,
        intentId: "intent-linked-repair",
        callbacks: hooks(),
        token: 3,
        receiptId: "r-linked",
        replay: false,
      }).status,
    ).toBe("nothing-to-deploy");
    expect(store.pause("repo-a")).toBeNull();
    store.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: null,
      notice: null,
      deliveryId: "d1",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      headSha: SHA_A,
      baseSha: SHA_B,
      pr: 1,
    });
    const bytes = Buffer.from("print(1)\n");
    const envelope = buildArtifactEnvelope({
      repositoryId: "repo-a",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      adapterVersion: "1",
      architecture: "x64",
      runtimeVersions: { node: "20" },
      compatibility: "reversible",
      files: [{ path: "src/app.py", mode: 0o100644, bytes }],
      expectedArchitecture: "x64",
      expectedRuntimeVersions: { node: "20" },
      adapterIntroducedByMerge: null,
      signingKey: privateKey,
    });
    const fenced = executeRelease({
      envelope,
      bytes: new Map([["src/app.py", bytes]]),
      expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
      journal: store,
      intentId: "intent-d1",
      adapterDigest: "d".repeat(64),
      adapterPolicy: { allow: ["src/"], deny: [] },
      adapterRollback: "unsafe",
      callbacks: hooks({
        write: () => {
          throw new Error("unsafe");
        },
        deliverReceipt: () => false,
      }),
      token: 4,
      receiptId: "r-unsafe",
      replay: false,
    });
    expect(fenced.status).toBe("fenced");
    expect(store.receipt("r-unsafe")?.kind).toBe("fenced");
    expect(store.receipt("r-unsafe")?.acknowledged).toBe(false);
    expect(store.pause("repo-a")?.repairId).toMatch(/repair/);
    store.enqueueReceipt("r-pending", "intent-d1", "deployed");
    let attempts = 0;
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal: store,
      freshMerges: () => [],
      execute: () => ({ status: "pending" }),
      deliverReceipt: (receiptId) => {
        if (receiptId !== "r-pending") return false;
        attempts += 1;
        return attempts > 1;
      },
    });
    service.tick("repo-a");
    expect(store.pendingReceipts()).toContain("r-pending");
    service.tick("repo-a");
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(store.pendingReceipts()).not.toContain("r-pending");
  });

  it("does not rescan a bootstrap-consumed merge and keys refusals by merge event id", () => {
    const { store } = journal();
    store.intake({
      deliveryId: "adapter-delivery",
      repositoryId: "repo-a",
      kind: "merge",
      eventId: "adapter-repo-a",
      mergeSha: SHA_A,
    });
    store.intake({
      deliveryId: "push-delivery",
      repositoryId: "repo-a",
      kind: "merge",
      eventId: "merge-9",
      mergeSha: "9".repeat(40),
    });
    store.pinTrust("pinned-key", publicKey);
    store.beginDrain("repo-a", 1);
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: signed({
        repositoryId: "repo-a",
        owner: "omarchy" as const,
        phase: "stable" as const,
        generation: 2,
        deploymentActivationEnabled: true,
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      genesis: signed({
        repositoryId: "repo-a",
        adapterVersion: "1",
        adapterDigest: "d".repeat(64),
        mergeSha: SHA_A,
        treeHash: SHA_B,
        mergeEventId: "adapter-repo-a",
        targetGeneration: 2,
      }),
      rollback: false,
      keyId: "pinned-key",
    });
    let runs = 0;
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal: store,
      freshMerges: () => [
        {
          deliveryId: "adapter-delivery",
          repositoryId: "repo-a",
          kind: "pull_request_merged",
          mergedBy: "operator",
          expectedOperator: "operator",
          pr: 1,
          headSha: SHA_A,
          reviewedHeadSha: SHA_A,
          baseSha: SHA_B,
          reviewedBaseSha: SHA_B,
          treeHash: TREE,
          reviewedTreeHash: TREE,
          mergeSha: SHA_A,
          newerReleaseActivated: false,
          authorApproved: true,
          reviewerApproved: true,
          checks: "success",
          eventId: "adapter-repo-a",
        },
        {
          deliveryId: "push-delivery",
          repositoryId: "repo-a",
          kind: "push",
          mergedBy: "someone",
          expectedOperator: "operator",
          pr: null,
          headSha: SHA_A,
          reviewedHeadSha: SHA_A,
          baseSha: SHA_B,
          reviewedBaseSha: SHA_B,
          treeHash: TREE,
          reviewedTreeHash: TREE,
          mergeSha: "9".repeat(40),
          newerReleaseActivated: false,
          eventId: "merge-9",
        },
      ],
      execute: () => {
        runs += 1;
        return { status: "deployed" };
      },
    });
    service.tick("repo-a");
    expect(runs).toBe(0);
    expect(store.disposition("repo-a", "adapter-repo-a")).toBe("bootstrap-consumed");
    expect(store.intentId("adapter-delivery")).toBeNull();
    expect(store.disposition("repo-a", "merge-9")).toBe("refused");
    expect(store.advanceCursor("repo-a")).toBe(2);
  });

  it("rejects the src/./secret.py deny bypass and symlink lane roots", () => {
    const bytes = Buffer.from("SECRET=1\n");
    expect(() =>
      buildArtifactEnvelope({
        repositoryId: "repo-a",
        mergeSha: SHA_A,
        treeHash: SHA_B,
        adapterVersion: "1",
        architecture: "x64",
        runtimeVersions: { node: "20" },
        compatibility: "reversible",
        files: [{ path: "src/./secret.py", mode: 0o100644, bytes }],
        expectedArchitecture: "x64",
        expectedRuntimeVersions: { node: "20" },
        adapterIntroducedByMerge: null,
        signingKey: privateKey,
      }),
    ).toThrow(/canonical|dot|deny/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-link-"));
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    fs.mkdirSync(path.join(real, "checkout"), { recursive: true });
    fs.mkdirSync(path.join(real, "worktree"), { recursive: true });
    fs.mkdirSync(path.join(real, "cache"), { recursive: true });
    fs.symlinkSync(path.join(real, "checkout"), link);
    const file = path.join(dir, "registry.json");
    const lane: LaneRecord = {
      laneId: "lane-a",
      repositoryId: "repo-a",
      github: { owner: "example", name: "one" },
      roots: {
        checkout: link,
        worktree: path.join(real, "worktree"),
        cache: path.join(real, "cache"),
      },
      threads: {
        author: { projectId: "pa", threadId: "author" },
        reviewer: { projectId: "pr", threadId: "reviewer" },
      },
      adapterPath: path.join(real, "adapter.json"),
    };
    fs.writeFileSync(file, JSON.stringify({ lanes: [lane] }));
    fs.chmodSync(file, 0o600);
    expect(() => loadRegistry(file)).toThrow(/symlink/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
