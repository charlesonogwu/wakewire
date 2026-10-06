import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrations.js";
import { buildArtifactEnvelope, verifyArtifactEnvelope } from "./artifact.js";
import { createBroker, createGuardedTransport } from "./broker.js";
import { advanceCandidate, blankCandidate } from "./candidate.js";
import { canonicalJson } from "./crypto.js";
import { executeRelease } from "./executor.js";
import type { GenesisAdapterRecord } from "./genesis.js";
import { type DeployJournal, openDeployJournal } from "./journal.js";
import { createLaneRouter } from "./lanes.js";
import { type FreshMerge, scanMerge } from "./reconcile.js";
import { recover } from "./recovery.js";
import { loadRegistry } from "./registry.js";
import { createDeploymentService } from "./service.js";
import { renderOperatorSummary } from "./summary.js";
import { createReviewHostRouter } from "./t3.js";
import type { LaneRecord } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TREE = "c".repeat(40);

function signed<T extends object>(body: T): T & { signature: string } {
  return {
    ...body,
    signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url"),
  };
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
  );
  return { db, store };
}

function cutover(store: DeployJournal, repositoryId = "repo-a") {
  store.beginDrain(repositoryId, 1);
  const genesis: GenesisAdapterRecord = signed({
    repositoryId,
    adapterVersion: "1",
    adapterDigest: "d".repeat(64),
    mergeSha: SHA_A,
    treeHash: SHA_B,
    mergeEventId: `adapter-${repositoryId}`,
    targetGeneration: 2,
  });
  store.completeOwnerChange({
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
    genesis,
    publicKey,
    rollback: false,
    keyId: "pinned-key",
  });
}

describe("review regressions", () => {
  it("binds the executor to the intent, merge, tree, and active adapter before mutation", () => {
    const { store } = journal();
    cutover(store);
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
    const envelope = buildArtifactEnvelope({
      repositoryId: "repo-b",
      mergeSha: "e".repeat(40),
      treeHash: "f".repeat(40),
      adapterVersion: "9",
      architecture: "x64",
      runtimeVersions: { node: "20" },
      compatibility: "reversible",
      files: [{ path: "src/app.py", mode: 0o100644, bytes: Buffer.from("print(1)\n") }],
      expectedArchitecture: "x64",
      expectedRuntimeVersions: { node: "20" },
      adapterIntroducedByMerge: null,
      signingKey: privateKey,
    });
    let writes = 0;
    expect(() =>
      executeRelease({
        envelope,
        bytes: new Map([["src/app.py", Buffer.from("print(1)\n")]]),
        publicKey,
        expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-b" },
        journal: store,
        intentId: "intent-d1",
        adapterDigest: "e".repeat(64),
        adapterPolicy: { allow: ["src/"], deny: [] },
        adapterRollback: "files",
        callbacks: {
          busy: () => false,
          lease: () => ({ release() {} }),
          idle: () => true,
          orderingOk: () => true,
          write: () => {
            writes += 1;
          },
          restore: () => undefined,
          previous: () => new Map(),
        },
        token: 1,
        receiptId: "r1",
        replay: false,
      }),
    ).toThrow(/intent|adapter/);
    expect(writes).toBe(0);
    expect(() =>
      executeRelease({
        envelope,
        bytes: new Map(),
        publicKey,
        expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-b" },
        journal: store,
        intentId: null,
        adapterDigest: "d".repeat(64),
        adapterPolicy: { allow: ["src/"], deny: [] },
        adapterRollback: "files",
        callbacks: {
          busy: () => false,
          lease: () => ({ release() {} }),
          idle: () => true,
          orderingOk: () => true,
          write: () => {
            writes += 1;
          },
          restore: () => undefined,
          previous: () => new Map(),
        },
        token: 2,
        receiptId: "r2",
        replay: false,
      }),
    ).toThrow(/intent/);
  });

  it("clears only the exact fenced repository, intent, and token", () => {
    const { db, store } = journal();
    cutover(store);
    store.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: null,
      notice: null,
      deliveryId: "d1",
      mergeSha: SHA_A,
      treeHash: SHA_B,
      headSha: SHA_A,
      baseSha: SHA_B,
      pr: 1,
    });
    store.recordManifest("intent-d1", "manifest-a");
    expect(store.tryAcquire(4, { repositoryId: "repo-a", intentId: "intent-d1" })).toBe("acquired");
    store.retain(4, "uncertain");
    expect(
      recover(db, {
        repositoryId: "repo-b",
        intentId: "intent-d1",
        token: 4,
        observedManifest: "manifest-a",
      }),
    ).toBe("fenced");
    expect(store.tryAcquire(5)).toBe("fenced");
    expect(
      recover(db, {
        repositoryId: "repo-a",
        intentId: "intent-d1",
        token: 3,
        observedManifest: "manifest-a",
      }),
    ).toBe("fenced");
    expect(
      recover(db, {
        repositoryId: "repo-a",
        intentId: "intent-d1",
        token: 4,
        observedManifest: "manifest-a",
      }),
    ).toBe("cleared");
    expect(store.intentId("recovery-must-not-create")).toBeNull();
  });

  it("does not clear an active lock that is not an uncertainty fence", () => {
    const { db, store } = journal();
    cutover(store);
    store.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: null,
      notice: null,
      deliveryId: "d1",
      mergeSha: SHA_A,
      treeHash: SHA_B,
      headSha: SHA_A,
      baseSha: SHA_B,
      pr: 1,
    });
    store.recordManifest("intent-d1", "manifest-a");
    expect(store.tryAcquire(2, { repositoryId: "repo-a", intentId: "intent-d1" })).toBe("acquired");
    expect(
      recover(db, {
        repositoryId: "repo-a",
        intentId: "intent-d1",
        token: 2,
        observedManifest: "manifest-a",
      }),
    ).toBe("fenced");
    expect(store.tryAcquire(3)).toBe("busy");
  });

  it("verifies the next owner before consuming genesis and pins the external key", () => {
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
    const genesis = signed({
      repositoryId: "repo-b",
      adapterVersion: "1",
      adapterDigest: "d".repeat(64),
      mergeSha: SHA_A,
      treeHash: SHA_B,
      mergeEventId: "adapter-repo-b",
      targetGeneration: 2,
    });
    const next = signed({
      repositoryId: "repo-b",
      owner: "omarchy" as const,
      phase: "stable" as const,
      generation: 2,
      deploymentActivationEnabled: true,
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(() =>
      store.completeOwnerChange({
        repositoryId: "repo-b",
        expectedGeneration: 1,
        next: { ...next, signature: "invalid" },
        genesis,
        publicKey,
        rollback: false,
        keyId: "pinned-key",
      }),
    ).toThrow(/signature/);
    expect(store.consumedGenesis("repo-b")).toBeNull();
    expect(() =>
      store.completeOwnerChange({
        repositoryId: "repo-b",
        expectedGeneration: 1,
        next,
        genesis,
        publicKey,
        rollback: false,
        keyId: "other-key",
      }),
    ).toThrow(/pinned key/);
    expect(store.consumedGenesis("repo-b")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS count FROM deploy_genesis").get()).toEqual({ count: 0 });
  });

  it("reads a fresh owner and honors durable leases", () => {
    const lane: LaneRecord = {
      laneId: "lane-a",
      repositoryId: "repo-a",
      github: { owner: "example", name: "one" },
      roots: {
        checkout: "/srv/a/checkout",
        worktree: "/srv/a/worktree",
        cache: "/srv/a/cache",
      },
      threads: {
        author: { projectId: "pa", threadId: "author" },
        reviewer: { projectId: "pr", threadId: "reviewer" },
      },
      adapterPath: "/srv/a/adapter.json",
    };
    let current = signed({
      repositoryId: "repo-a",
      owner: "omarchy" as const,
      phase: "stable" as const,
      generation: 2,
      deploymentActivationEnabled: true,
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    const { store } = journal();
    store.acquireLease({
      id: "deploy-1",
      repositoryId: "repo-a",
      generation: 2,
      kind: "deployment",
    });
    const router = createLaneRouter([lane], () => current, publicKey, {
      deploymentLeaseActive: (repositoryId) => store.activeDeploymentLease(repositoryId),
    });
    expect(() => router.admit({ repositoryId: "repo-a" }, 2)).toThrow(/lease/);
    store.releaseLease("deploy-1");
    current = signed({
      repositoryId: "repo-a",
      owner: "omarchy" as const,
      phase: "stable" as const,
      generation: 3,
      deploymentActivationEnabled: true,
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(() => router.admit({ repositoryId: "repo-a" }, 2)).toThrow(/generation/);
    router.admit({ repositoryId: "repo-a" }, 3);
  });

  it("clears stale tree, checks, and approvals when a candidate is invalidated", () => {
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
    const next = advanceCandidate(state, { type: "base-changed", baseSha: SHA_B });
    expect(next.state).not.toBe("merge-ready");
    expect(next.verdicts).toEqual([]);
    expect(next.checks).toBe("pending");
    expect(next.id.treeHash).toBe("");
  });

  it("refuses a merge that lacks current exact-candidate approvals or checks", () => {
    const merge = (overrides: Partial<FreshMerge> = {}): FreshMerge => ({
      deliveryId: "m1",
      repositoryId: "repo-a",
      kind: "pull_request_merged",
      mergedBy: "operator",
      expectedOperator: "operator",
      pr: 7,
      headSha: SHA_A,
      reviewedHeadSha: SHA_A,
      baseSha: SHA_B,
      reviewedBaseSha: SHA_B,
      treeHash: TREE,
      reviewedTreeHash: TREE,
      mergeSha: "d".repeat(40),
      newerReleaseActivated: false,
      authorApproved: true,
      reviewerApproved: true,
      checks: "success",
      ...overrides,
    });
    expect(scanMerge(merge({ authorApproved: false })).kind).toBe("refuse");
    expect(scanMerge(merge({ reviewerApproved: false })).kind).toBe("refuse");
    expect(scanMerge(merge({ checks: "pending" })).kind).toBe("refuse");
    expect(scanMerge(merge()).kind).toBe("intent");
  });

  it("retries a pending intent and advances the cursor without skipping bootstrap", () => {
    const { store } = journal();
    store.intake({
      deliveryId: "early",
      repositoryId: "repo-a",
      kind: "merge",
      eventId: "early-merge",
      mergeSha: "1".repeat(40),
    });
    store.intake({
      deliveryId: "adapter",
      repositoryId: "repo-a",
      kind: "merge",
      eventId: "adapter-repo-a",
      mergeSha: SHA_A,
    });
    cutover(store);
    expect(store.advanceCursor("repo-a")).toBe(0);
    let runs = 0;
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal: store,
      freshMerges: () => [
        {
          deliveryId: "early",
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
          mergeSha: "1".repeat(40),
          newerReleaseActivated: false,
          authorApproved: true,
          reviewerApproved: true,
          checks: "success",
          eventId: "early-merge",
        },
      ],
      execute: () => {
        runs += 1;
        return { status: runs === 1 ? "pending" : "deployed" };
      },
    });
    expect(service.tick("repo-a").executions).toBe(1);
    expect(service.tick("repo-a").executions).toBe(1);
    expect(runs).toBe(2);
    expect(store.disposition("repo-a", "early-merge")).toBe("intent");
    expect(store.advanceCursor("repo-a")).toBe(2);
  });

  it("journals the target manifest before copy and does not copy twice after a crash", () => {
    const { store } = journal();
    cutover(store);
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
    let writes = 0;
    const first = executeRelease({
      envelope,
      bytes: new Map([["src/app.py", bytes]]),
      publicKey,
      expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
      journal: store,
      intentId: "intent-d1",
      adapterDigest: "d".repeat(64),
      adapterPolicy: { allow: ["src/"], deny: ["secrets/"] },
      adapterRollback: "files",
      callbacks: {
        busy: () => false,
        lease: () => ({ release() {} }),
        idle: () => true,
        orderingOk: () => true,
        write: () => {
          writes += 1;
        },
        restore: () => undefined,
        previous: () => new Map([["src/app.py", Buffer.from("old")]]),
        afterMutation: () => {
          throw new Error("crash before receipt");
        },
        observe: () => store.intentRecord("intent-d1")?.targetManifest ?? "",
      },
      token: 7,
      receiptId: "r-crash",
      replay: false,
    });
    expect(first.status).toBe("fenced");
    expect(writes).toBe(1);
    expect(store.intentRecord("intent-d1")?.targetManifest).toBeTruthy();
    expect(store.intentRecord("intent-d1")?.previousManifest).toBeTruthy();
  });

  it("pauses a repository after a verified rollback and blocks an ordinary release", () => {
    const { store } = journal();
    cutover(store);
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
    const rolled = executeRelease({
      envelope,
      bytes: new Map([["src/app.py", bytes]]),
      publicKey,
      expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
      journal: store,
      intentId: "intent-d1",
      adapterDigest: "d".repeat(64),
      adapterPolicy: { allow: ["src/"], deny: [] },
      adapterRollback: "files",
      callbacks: {
        busy: () => false,
        lease: () => ({ release() {} }),
        idle: () => true,
        orderingOk: () => true,
        write: () => {
          throw new Error("partial");
        },
        restore: () => undefined,
        verifyRestore: () => true,
        previous: () => new Map(),
        deliverReceipt: () => true,
      },
      token: 8,
      receiptId: "r-roll",
      replay: false,
    });
    expect(rolled.status).toBe("rolled-back");
    expect(store.pause("repo-a")?.repairId).toMatch(/repair/);
    expect(store.receipt("r-roll")?.kind).toBe("rolled-back");
    expect(store.receipt("r-roll")?.acknowledged).toBe(true);
    store.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: null,
      notice: null,
      deliveryId: "d2",
      mergeSha: "c".repeat(40),
      treeHash: SHA_B,
      headSha: SHA_A,
      baseSha: SHA_B,
      pr: 2,
    });
    const blocked = executeRelease({
      envelope,
      bytes: new Map([["src/app.py", bytes]]),
      publicKey,
      expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
      journal: store,
      intentId: "intent-d2",
      adapterDigest: "d".repeat(64),
      adapterPolicy: { allow: ["src/"], deny: [] },
      adapterRollback: "files",
      callbacks: {
        busy: () => false,
        lease: () => ({ release() {} }),
        idle: () => true,
        orderingOk: () => true,
        write: () => {
          throw new Error("should not write");
        },
        restore: () => undefined,
        previous: () => new Map(),
      },
      token: 9,
      receiptId: "r-blocked",
      replay: false,
    });
    expect(blocked.status).toBe("pending");
  });

  it("keeps a receipt unacknowledged until delivery succeeds", () => {
    const { store } = journal();
    cutover(store);
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
    const result = executeRelease({
      envelope,
      bytes: new Map([["src/app.py", bytes]]),
      publicKey,
      expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
      journal: store,
      intentId: "intent-d1",
      adapterDigest: "d".repeat(64),
      adapterPolicy: { allow: ["src/"], deny: [] },
      adapterRollback: "files",
      callbacks: {
        busy: () => false,
        lease: () => ({ release() {} }),
        idle: () => true,
        orderingOk: () => true,
        write: () => undefined,
        restore: () => undefined,
        previous: () => new Map(),
        reload: () => undefined,
        verify: () => true,
        deliverReceipt: () => false,
      },
      token: 10,
      receiptId: "r-undelivered",
      replay: false,
    });
    expect(result.status).toBe("deployed");
    expect(store.receipt("r-undelivered")?.acknowledged).toBe(false);
    expect(store.pendingReceipts()).toContain("r-undelivered");
  });

  it("isolates broker branches and records a wake only after delivery", async () => {
    const transport = createGuardedTransport({
      async request() {
        return { ok: true };
      },
    });
    const broker = createBroker(transport, {
      owner: "example",
      name: "one",
      branches: ["review/lane-a"],
    });
    await expect(
      broker.publishBranch({
        owner: "example",
        name: "two",
        branch: "review/lane-a",
        sha: SHA_A,
        role: "author",
      }),
    ).rejects.toThrow(/repository/);
    await expect(
      broker.publishBranch({
        owner: "example",
        name: "one",
        branch: "main",
        sha: SHA_A,
        role: "author",
      }),
    ).rejects.toThrow(/branch/);
    await expect(
      broker.publishBranch({
        owner: "example",
        name: "one",
        branch: "review/lane-a",
        sha: SHA_A,
        role: "reviewer",
      }),
    ).rejects.toThrow(/author/);
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
    let failOnce = true;
    const seen: string[] = [];
    const router = createReviewHostRouter(
      [lane],
      {
        async deliver() {
          if (failOnce) {
            failOnce = false;
            throw new Error("transport down");
          }
        },
      },
      publicKey,
      {
        remember(requestId) {
          seen.push(requestId);
        },
      },
    );
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
    await expect(router.wake(wake)).rejects.toThrow(/transport/);
    expect(seen).toEqual([]);
    await router.wake(wake);
    expect(seen).toEqual(["r1"]);
    await expect(router.wake({ ...wake, repositoryId: "repo-b" })).rejects.toThrow(/repository/);
    const verdictBody = {
      laneId: "a",
      role: "reviewer" as const,
      requestId: "r1",
      repositoryId: "repo-b",
      pr: 7,
      decision: "approve" as const,
      headSha: SHA_A,
      baseSha: SHA_B,
      treeHash: TREE,
    };
    expect(() =>
      router.ingestVerdict({
        ...verdictBody,
        signature: sign(null, Buffer.from(canonicalJson(verdictBody)), privateKey).toString(
          "base64url",
        ),
      }),
    ).toThrow(/repository/);
  });

  it("rejects windows paths, special modes, and files outside the activated policy", () => {
    const bytes = Buffer.from("print(1)\n");
    expect(() =>
      buildArtifactEnvelope({
        repositoryId: "repo-a",
        mergeSha: SHA_A,
        treeHash: SHA_B,
        adapterVersion: "1",
        architecture: "x64",
        runtimeVersions: { node: "20" },
        compatibility: "reversible",
        files: [{ path: "C:/Windows/app.py", mode: 0o100644, bytes }],
        expectedArchitecture: "x64",
        expectedRuntimeVersions: { node: "20" },
        adapterIntroducedByMerge: null,
        signingKey: privateKey,
      }),
    ).toThrow(/windows|traversal/);
    expect(() =>
      buildArtifactEnvelope({
        repositoryId: "repo-a",
        mergeSha: SHA_A,
        treeHash: SHA_B,
        adapterVersion: "1",
        architecture: "x64",
        runtimeVersions: { node: "20" },
        compatibility: "reversible",
        files: [{ path: "src/app.py", mode: 0o020644, bytes }],
        expectedArchitecture: "x64",
        expectedRuntimeVersions: { node: "20" },
        adapterIntroducedByMerge: null,
        signingKey: privateKey,
      }),
    ).toThrow(/special|symlink/);
    const envelope = buildArtifactEnvelope({
      repositoryId: "repo-a",
      mergeSha: SHA_A,
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
    expect(() =>
      verifyArtifactEnvelope(envelope, new Map([["src/app.py", bytes]]), publicKey, {
        architecture: "x64",
        runtimeVersions: { node: "20" },
        repositoryId: "repo-a",
        policy: { allow: ["src/"], deny: ["src/app.py"] },
      }),
    ).toThrow(/policy|deny/);
  });

  it("says merge-ready only with the required sections", () => {
    const candidate = blankCandidate({
      repositoryId: "repo-a",
      pr: 4,
      headSha: SHA_A,
      baseSha: SHA_B,
      treeHash: TREE,
    });
    const blocked = renderOperatorSummary({ ...candidate, state: "challenging" }).text;
    expect(blocked).not.toContain("merge-ready");
    const ready = renderOperatorSummary({ ...candidate, state: "merge-ready" }, undefined, {
      changes: "job count",
      challenges: "none open",
      tests: "unit passed",
      risks: "reversible",
      deploymentContents: "src/app.py",
    }).text;
    expect(ready).toContain("merge-ready");
    expect(ready).toContain("job count");
    expect(ready).toContain("none open");
    expect(ready).toContain("unit passed");
    expect(ready).toContain("reversible");
    expect(ready).toContain("src/app.py");
  });

  it("keeps thread and root errors ahead of linux-only owner isolation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-reg-"));
    const file = path.join(dir, "registry.json");
    const shared: LaneRecord = {
      laneId: "lane-a",
      repositoryId: "repo-a",
      github: { owner: "example", name: "one" },
      roots: {
        checkout: "/srv/lanes/a/checkout",
        worktree: "/srv/lanes/a/worktree",
        cache: "/srv/lanes/a/cache",
      },
      threads: {
        author: { projectId: "pa", threadId: "same" },
        reviewer: { projectId: "pr", threadId: "same" },
      },
      adapterPath: "/srv/lanes/a/adapter.json",
    };
    fs.writeFileSync(file, JSON.stringify({ lanes: [shared] }));
    fs.chmodSync(file, 0o600);
    expect(() => loadRegistry(file)).toThrow(/threadId/);
    const overlap = {
      lanes: [
        {
          ...shared,
          threads: {
            author: { projectId: "pa", threadId: "a-author" },
            reviewer: { projectId: "pr", threadId: "a-review" },
          },
        },
        {
          ...shared,
          laneId: "lane-b",
          repositoryId: "repo-b",
          roots: {
            checkout: "/srv/lanes/a/../a/checkout",
            worktree: "/srv/lanes/b/worktree",
            cache: "/srv/lanes/b/cache",
          },
          threads: {
            author: { projectId: "pb", threadId: "b-author" },
            reviewer: { projectId: "pb2", threadId: "b-review" },
          },
        },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(overlap));
    fs.chmodSync(file, 0o600);
    expect(() => loadRegistry(file)).toThrow(/overlap/);
    fs.writeFileSync(
      file,
      JSON.stringify({
        lanes: [
          {
            ...shared,
            roots: {
              checkout: "C:/lanes/checkout",
              worktree: "/srv/lanes/a/worktree",
              cache: "/srv/lanes/a/cache",
            },
            threads: {
              author: { projectId: "pa", threadId: "a-author" },
              reviewer: { projectId: "pr", threadId: "a-review" },
            },
          },
        ],
      }),
    );
    expect(() => loadRegistry(file)).toThrow(/windows/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
