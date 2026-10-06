import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrations.js";
import type { RuntimeAdapter } from "./adapter.js";
import { buildArtifactEnvelope } from "./artifact.js";
import { advanceCandidate, blankCandidate } from "./candidate.js";
import { recoverWithRuntimeAdapter } from "./cli.js";
import { canonicalJson } from "./crypto.js";
import { executeRelease, type RuntimeCallbacks } from "./executor.js";
import type { GenesisAdapterRecord } from "./genesis.js";
import { type DeployJournal, openDeployJournal } from "./journal.js";
import type { FreshMerge } from "./reconcile.js";
import { recover } from "./recovery.js";
import { loadRegistry } from "./registry.js";
import { createDeploymentService } from "./service.js";
import { createReviewHostRouter, type T3Transport } from "./t3.js";
import type { EngineeringOwnerRecord, LaneRecord } from "./types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const attacker = generateKeyPairSync("ed25519");
const authorKeys = generateKeyPairSync("ed25519");
const reviewerKeys = generateKeyPairSync("ed25519");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TREE = "c".repeat(40);
const MERGE = "c".repeat(40);

function signed<T extends object>(body: T, key = privateKey): T & { signature: string } {
  return {
    ...body,
    signature: sign(null, Buffer.from(canonicalJson(body)), key).toString("base64url"),
  };
}

function trustedAdapter(repositoryId: string): RuntimeAdapter {
  return {
    version: "1",
    repositoryId,
    allow: ["src/", "docs/"],
    deny: [".env"],
    runtimeTargetId: "runtime-a",
    busyCheckId: "busy-a",
    verifyCheckId: "verify-a",
    reloadId: "reload-a",
    rollback: "files",
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

function database() {
  const db = new DatabaseConstructor(":memory:");
  migrate(db);
  const store = openDeployJournal(db);
  store.pinTrust("pinned-key", publicKey);
  store.seedOwner(owner("repo-a", 1, false, "legacy"), "pinned-key");
  return { db, store };
}

function owner(
  repositoryId: string,
  generation: number,
  enabled: boolean,
  host: "legacy" | "omarchy",
  phase: "stable" | "draining" = "stable",
): EngineeringOwnerRecord {
  return signed({
    repositoryId,
    owner: host,
    phase,
    generation,
    deploymentActivationEnabled: enabled,
    updatedAt: "2026-10-06T00:00:00.000Z",
  });
}

function genesisFor(repositoryId: string, digest: string): GenesisAdapterRecord {
  return signed({
    repositoryId,
    adapterVersion: "1",
    adapterDigest: digest,
    mergeSha: SHA_A,
    treeHash: SHA_B,
    mergeEventId: `adapter-${repositoryId}`,
    targetGeneration: 2,
  });
}

function cutover(store: DeployJournal, repositoryId = "repo-a"): string {
  store.beginDrain(repositoryId, 1);
  const digest = store.pinAdapter(trustedAdapter(repositoryId));
  store.completeOwnerChange({
    repositoryId,
    expectedGeneration: 1,
    next: owner(repositoryId, 2, true, "omarchy"),
    genesis: genesisFor(repositoryId, digest),
    rollback: false,
    keyId: "pinned-key",
  });
  return digest;
}

function intent(deliveryId: string, mergeSha = MERGE, treeHash = SHA_B) {
  return {
    kind: "intent" as const,
    repositoryId: "repo-a",
    repairId: null,
    notice: null,
    deliveryId,
    mergeSha,
    treeHash,
    headSha: SHA_A,
    baseSha: SHA_B,
    pr: 1,
  };
}

function envelopeFor(bytes: Buffer, mergeSha = MERGE, treeHash = SHA_B, key = privateKey) {
  return buildArtifactEnvelope({
    repositoryId: "repo-a",
    mergeSha,
    treeHash,
    adapterVersion: "1",
    architecture: "x64",
    runtimeVersions: { node: "20" },
    compatibility: "reversible",
    files: [{ path: "src/app.py", mode: 0o100644, bytes }],
    expectedArchitecture: "x64",
    expectedRuntimeVersions: { node: "20" },
    adapterIntroducedByMerge: null,
    signingKey: key,
  });
}

function release(
  store: DeployJournal,
  overrides: Partial<Parameters<typeof executeRelease>[0]> = {},
) {
  const bytes = Buffer.from("print(1)\n");
  return executeRelease({
    envelope: envelopeFor(bytes),
    bytes: new Map([["src/app.py", bytes]]),
    expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId: "repo-a" },
    journal: store,
    intentId: "intent-d1",
    callbacks: hooks(),
    token: 1,
    receiptId: "r1",
    replay: false,
    ...overrides,
  });
}

function merged(deliveryId: string, repositoryId = "repo-a"): FreshMerge {
  return {
    deliveryId,
    repositoryId,
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
  };
}

function lane(): LaneRecord {
  return {
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
}

function expectLinkedAlias(type: "dir" | "junction") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-link-"));
  const real = path.join(dir, "real");
  fs.mkdirSync(real);
  const link = path.join(dir, "link");
  fs.symlinkSync(real, link, type);
  const aliased = lane();
  aliased.roots = {
    checkout: path.join(link, "missing", "checkout"),
    worktree: path.join(dir, "lane-a", "worktree"),
    cache: path.join(dir, "lane-a", "cache"),
  };
  const direct = lane();
  direct.laneId = "b";
  direct.repositoryId = "repo-b";
  direct.threads = {
    author: { projectId: "pb", threadId: "b-author" },
    reviewer: { projectId: "pb2", threadId: "b-review" },
  };
  direct.roots = {
    checkout: path.join(real, "missing", "checkout"),
    worktree: path.join(dir, "lane-b", "worktree"),
    cache: path.join(dir, "lane-b", "cache"),
  };
  expect(() => loadRegistry(registryFile([aliased, direct]))).toThrow(/symlink|alias|overlap/);
  fs.rmSync(dir, { recursive: true, force: true });
}

function registryFile(lanes: LaneRecord[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-third-"));
  const file = path.join(dir, "registry.json");
  fs.writeFileSync(file, JSON.stringify({ lanes }));
  fs.chmodSync(file, 0o600);
  return file;
}

describe("third review probes", () => {
  it("rejects an artifact whose signature key is caller input instead of pinned trust", () => {
    const { store } = database();
    cutover(store);
    store.applyDecision(intent("d1"));
    const bytes = Buffer.from("print(1)\n");
    let writes = 0;
    expect(() =>
      release(store, {
        envelope: envelopeFor(bytes, MERGE, SHA_B, attacker.privateKey),
        callbacks: hooks({
          write: () => {
            writes += 1;
          },
        }),
      }),
    ).toThrow(/signature|trust|key/);
    expect(writes).toBe(0);
  });

  it("refuses a direct execute when the active owner is not stable and enabled", () => {
    const { db, store } = database();
    cutover(store);
    store.applyDecision(intent("d1"));
    db.prepare(
      "UPDATE deploy_owners SET deployment_activation_enabled = 0 WHERE repository_id = ?",
    ).run("repo-a");
    let writes = 0;
    expect(() =>
      release(store, {
        callbacks: hooks({
          write: () => {
            writes += 1;
          },
        }),
      }),
    ).toThrow(/activation|owner/);
    expect(writes).toBe(0);
    expect(store.activeDeploymentLease("repo-a")).toBe(false);
  });

  it("rejects a signed next owner for another repository or a generation that is not strictly newer", () => {
    const { store } = database();
    store.pinTrust("pinned-key", publicKey);
    store.beginDrain("repo-a", 1);
    expect(() =>
      store.completeOwnerChange({
        repositoryId: "repo-a",
        expectedGeneration: 1,
        next: owner("repo-b", 2, true, "omarchy"),
        genesis: null,
        rollback: false,
        keyId: "pinned-key",
      }),
    ).toThrow(/repository|generation/);
    expect(store.owner("repo-a")?.generation).toBe(1);
    expect(store.owner("repo-a")?.owner).toBe("legacy");
    expect(() =>
      store.completeOwnerChange({
        repositoryId: "repo-a",
        expectedGeneration: 1,
        next: owner("repo-a", 1, true, "omarchy"),
        genesis: null,
        rollback: false,
        keyId: "pinned-key",
      }),
    ).toThrow(/generation/);
    expect(store.owner("repo-a")?.generation).toBe(1);
  });

  it("releases the exact deployment lease when recovery clears an explicit fence", () => {
    const { db, store } = database();
    cutover(store);
    store.applyDecision(intent("d1"));
    db.prepare("UPDATE deploy_intents SET manifest_hash = ? WHERE id = ?").run(
      "manifest-a",
      "intent-d1",
    );
    expect(store.tryAcquire(4, { repositoryId: "repo-a", intentId: "intent-d1" })).toBe("acquired");
    store.retain(4, "uncertain");
    store.acquireLease({
      id: "deployment:intent-d1:4",
      repositoryId: "repo-a",
      generation: 2,
      kind: "deployment",
    });
    expect(
      recover(db, { repositoryId: "repo-a", intentId: "intent-d1", token: 4 }, () => "manifest-a"),
    ).toBe("cleared");
    expect(store.activeDeploymentLease("repo-a")).toBe(false);
  });

  it("reconciles a lease and lock left by a child process killed after the copy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-crash-"));
    const dbPath = path.join(dir, "wakewire.sqlite");
    const copyPath = path.join(dir, "app.py");
    const counterPath = path.join(dir, "copies.txt");
    const keyPath = path.join(dir, "key.pem");
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    const setup = new DatabaseConstructor(dbPath);
    setup.pragma("busy_timeout = 5000");
    migrate(setup);
    const store = openDeployJournal(setup);
    store.pinTrust("pinned-key", publicKey);
    store.seedOwner(owner("repo-a", 1, false, "legacy"), "pinned-key");
    cutover(store);
    store.applyDecision({ ...intent("crash"), deliveryId: "crash" });
    setup.close();

    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(root, "src", "deploy", "crash-child.ts"),
        dbPath,
        copyPath,
        counterPath,
        keyPath,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`crash child timed out: ${Buffer.concat(stderr).toString()}`));
        }, 15000);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );
    expect(exit.signal === "SIGKILL" || (exit.signal === null && exit.code !== 0)).toBe(true);
    expect(fs.readFileSync(copyPath, "utf8")).toBe("payload-v1\n");
    const copies = fs.readFileSync(counterPath, "utf8").trim().split("\n").filter(Boolean);
    expect(copies).toEqual(["copy"]);
    const db = new DatabaseConstructor(dbPath);
    db.pragma("busy_timeout = 5000");
    const reopened = openDeployJournal(db);
    expect(reopened.activeDeploymentLease("repo-a")).toBe(true);
    expect(
      db
        .prepare(
          "SELECT token, held, fenced, repository_id, intent_id FROM deploy_fence WHERE id = 1",
        )
        .get(),
    ).toMatchObject({
      token: 4,
      held: 1,
      fenced: 0,
      repository_id: "repo-a",
      intent_id: "intent-crash",
    });
    reopened.seedOwner(owner("repo-b", 1, false, "legacy"));
    reopened.applyDecision({ ...intent("other"), repositoryId: "repo-b" });
    const wrongEvidence = { repositoryId: "repo-a", intentId: "intent-crash", token: 5 };
    expect(reopened.reconcileInterrupted(wrongEvidence, () => "wrong")).toBe("idle");
    expect(
      reopened.reconcileInterrupted(
        { repositoryId: "repo-b", intentId: "intent-crash", token: 4 },
        () => "wrong",
      ),
    ).toBe("idle");
    const unconfigured = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal: reopened,
      freshMerges: () => [],
      execute: () => ({ status: "pending" }),
    });
    expect(() => unconfigured.tick("repo-a")).toThrow("trusted runtime observer is not configured");
    expect(reopened.activeDeploymentLease("repo-a")).toBe(true);
    expect(reopened.intentRecord("intent-crash")?.phase).toBe("activating");
    const observedRuntime = () => {
      const sha256 = createHash("sha256").update(fs.readFileSync(copyPath)).digest("hex");
      return createHash("sha256")
        .update(JSON.stringify([{ path: "src/app.py", mode: 0o100644, sha256 }]))
        .digest("hex");
    };
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal: reopened,
      freshMerges: () => [],
      execute: () => ({ status: "pending" }),
      runtimeObserverFor: (repositoryId: string) =>
        repositoryId === "repo-a" ? hooks({ observe: observedRuntime }) : undefined,
    });
    expect(service.tick("repo-a")).toEqual({ decisions: 0, executions: 0 });
    expect(reopened.intentRecord("intent-crash")?.phase).toBe("deployed");
    expect(reopened.intentRecord("intent-other")?.phase).toBe("recorded");
    expect(reopened.activeDeploymentLease("repo-a")).toBe(false);
    expect(db.prepare("SELECT held, fenced FROM deploy_fence WHERE id = 1").get()).toEqual({
      held: 0,
      fenced: 0,
    });
    expect(reopened.tryAcquire(8, { repositoryId: "repo-a", intentId: "intent-crash" })).toBe(
      "acquired",
    );
    reopened.retain(8, "operator recovery required");
    const recoveryEvidence = { repositoryId: "repo-a", intentId: "intent-crash", token: 8 };
    expect(() => recoverWithRuntimeAdapter(db, recoveryEvidence, undefined)).toThrow(
      "trusted runtime observer is not configured",
    );
    expect(() =>
      recoverWithRuntimeAdapter(db, recoveryEvidence, () =>
        hooks({
          runtimeTargetId: "other-runtime",
          observe: observedRuntime,
        }),
      ),
    ).toThrow("trusted runtime observer is not configured");
    expect(
      recoverWithRuntimeAdapter(db, recoveryEvidence, (repositoryId) =>
        repositoryId === "repo-a" ? hooks({ observe: observedRuntime }) : undefined,
      ),
    ).toBe("cleared");
    expect(fs.readFileSync(counterPath, "utf8").trim().split("\n").filter(Boolean)).toEqual([
      "copy",
    ]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it("terminally fences only the copied release when trusted restart observation mismatches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-crash-mismatch-"));
    const dbPath = path.join(dir, "wakewire.sqlite");
    const copyPath = path.join(dir, "app.py");
    const counterPath = path.join(dir, "copies.txt");
    const keyPath = path.join(dir, "key.pem");
    let db: DatabaseConstructor.Database | null = null;
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    try {
      const setup = new DatabaseConstructor(dbPath);
      migrate(setup);
      const store = openDeployJournal(setup);
      store.pinTrust("pinned-key", publicKey);
      store.seedOwner(owner("repo-a", 1, false, "legacy"), "pinned-key");
      cutover(store);
      store.applyDecision({ ...intent("crash"), deliveryId: "crash" });
      store.seedOwner(owner("repo-b", 1, true, "omarchy"));
      store.applyDecision({ ...intent("other"), repositoryId: "repo-b" });
      store.acquireLease({
        id: "deployment:intent-other:99",
        repositoryId: "repo-b",
        generation: 1,
        kind: "deployment",
      });
      setup.close();

      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(root, "src", "deploy", "crash-child.ts"),
          dbPath,
          copyPath,
          counterPath,
          keyPath,
        ],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      const stderr: Buffer[] = [];
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`crash child timed out: ${Buffer.concat(stderr).toString()}`));
          }, 15000);
          child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        },
      );
      expect(exit.signal === "SIGKILL" || (exit.signal === null && exit.code !== 0)).toBe(true);
      expect(fs.readFileSync(copyPath, "utf8")).toBe("payload-v1\n");
      expect(fs.readFileSync(counterPath, "utf8").trim().split("\n")).toEqual(["copy"]);

      db = new DatabaseConstructor(dbPath);
      const reopened = openDeployJournal(db);
      let executions = 0;
      const service = createDeploymentService({
        host: "omarchy",
        publicKey,
        journal: reopened,
        freshMerges: () => [],
        execute: () => {
          executions += 1;
          return { status: "fenced" };
        },
        runtimeObserverFor: (repositoryId) =>
          repositoryId === "repo-a"
            ? hooks({ observe: () => "neither-durable-manifest" })
            : undefined,
      });
      expect(service.tick("repo-a")).toEqual({ decisions: 0, executions: 0 });
      expect(reopened.intentRecord("intent-crash")?.phase).toBe("fenced");
      expect(reopened.phases("intent-crash").at(-1)).toBe("fenced");
      expect(
        db
          .prepare("SELECT intent_id, kind, repository_id FROM deploy_outbox WHERE intent_id = ?")
          .get("intent-crash"),
      ).toMatchObject({
        intent_id: "intent-crash",
        kind: "fenced",
        repository_id: "repo-a",
      });
      expect(
        db
          .prepare(
            "SELECT repository_id, intent_id, token, reason FROM deploy_restart_fences WHERE intent_id = ?",
          )
          .get("intent-crash"),
      ).toMatchObject({
        repository_id: "repo-a",
        intent_id: "intent-crash",
        token: 4,
        reason: "restart observation does not match a durable manifest",
      });
      expect(reopened.activeDeploymentLease("repo-a")).toBe(false);
      expect(reopened.activeDeploymentLease("repo-b")).toBe(true);
      expect(reopened.intentRecord("intent-other")?.phase).toBe("recorded");
      expect(db.prepare("SELECT held, fenced FROM deploy_fence WHERE id = 1").get()).toEqual({
        held: 0,
        fenced: 0,
      });
      expect(reopened.tryAcquire(8, { repositoryId: "repo-a", intentId: "intent-crash" })).toBe(
        "acquired",
      );
      reopened.release(8);
      expect(service.tick("repo-a")).toEqual({ decisions: 0, executions: 0 });
      expect(executions).toBe(0);
      expect(reopened.intentRecord("intent-other")?.phase).toBe("recorded");
      expect(reopened.activeDeploymentLease("repo-b")).toBe(true);
      const otherService = createDeploymentService({
        host: "omarchy",
        publicKey,
        journal: reopened,
        freshMerges: () => [],
        execute: () => {
          const lock = reopened.tryAcquire(9, { repositoryId: "repo-b", intentId: "intent-other" });
          if (lock === "acquired") reopened.release(9);
          return { status: lock === "fenced" ? "fenced" : "pending" };
        },
      });
      expect(otherService.tick("repo-b")).toEqual({ decisions: 0, executions: 1 });
      expect(reopened.intentRecord("intent-other")?.phase).toBe("recorded");
      expect(reopened.activeDeploymentLease("repo-b")).toBe(true);
      expect(fs.readFileSync(counterPath, "utf8").trim().split("\n")).toEqual(["copy"]);
    } finally {
      db?.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("binds a receipt to one intent and reuses the outbox row when delivery throws", () => {
    const { db, store } = database();
    cutover(store);
    store.applyDecision(intent("d1"));
    store.applyDecision(intent("d2", "e".repeat(40), "f".repeat(40)));
    release(store, { token: 1, receiptId: "r1" });
    const other = envelopeFor(Buffer.from("other\n"), "e".repeat(40), "f".repeat(40));
    expect(() =>
      release(store, {
        envelope: other,
        bytes: new Map([["src/app.py", Buffer.from("other\n")]]),
        intentId: "intent-d2",
        token: 2,
        receiptId: "r1",
        replay: true,
      }),
    ).toThrow(/receipt|intent|manifest/);
    let writes = 0;
    let deliveries = 0;
    expect(() =>
      release(store, {
        token: 3,
        receiptId: "r-deliver",
        callbacks: hooks({
          write: () => {
            writes += 1;
          },
          deliverReceipt: () => {
            deliveries += 1;
            throw new Error("delivery down");
          },
        }),
      }),
    ).toThrow(/delivery down/);
    expect(store.activeDeploymentLease("repo-a")).toBe(false);
    expect(store.tryAcquire(9, { repositoryId: "repo-a", intentId: "intent-d1" })).toBe("acquired");
    store.release(9);
    const retried = release(store, {
      token: 4,
      receiptId: "r-deliver",
      callbacks: hooks({
        write: () => {
          writes += 1;
        },
        deliverReceipt: () => {
          deliveries += 1;
          return true;
        },
      }),
    });
    expect(retried.status).toBe("deployed");
    expect(writes).toBe(1);
    expect(deliveries).toBe(2);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM deploy_outbox WHERE id = ?").get("r-deliver"),
    ).toEqual({ count: 1 });
  });

  it("resumes an unfinished intent without a fresh merge and issues durable tokens", () => {
    const { store } = database();
    store.beginDrain("repo-a", 1);
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: owner("repo-a", 2, true, "omarchy"),
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
    store.applyDecision(intent("open-1"));
    let resumed = 0;
    const resume = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal: store,
      freshMerges: () => [],
      execute: () => {
        resumed += 1;
        return { status: "pending" };
      },
    });
    expect(resume.tick("repo-a").executions).toBeGreaterThanOrEqual(1);
    expect(resumed).toBeGreaterThanOrEqual(1);
  });

  it("issues a strictly increasing durable token instead of the default 1", () => {
    const { store } = database();
    store.beginDrain("repo-a", 1);
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: owner("repo-a", 2, true, "omarchy"),
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
    const tokens: number[] = [];
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal: store,
      freshMerges: () => [merged("m-a"), merged("m-b")],
      artifactFor: () => ({ marker: true }) as never,
      execute: (input) => {
        tokens.push(input?.token ?? 0);
        return { status: "deployed" };
      },
    });
    service.tick("repo-a");
    expect(tokens).toHaveLength(2);
    const first = tokens[0] ?? 0;
    const second = tokens[1] ?? 0;
    expect(second).toBeGreaterThan(first);
    const again = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal: store,
      freshMerges: () => [merged("m-c")],
      artifactFor: () => ({ marker: true }) as never,
      execute: (input) => {
        tokens.push(input?.token ?? 0);
        return { status: "deployed" };
      },
    });
    again.tick("repo-a");
    const third = tokens[2] ?? 0;
    expect(third).toBeGreaterThan(second);
  });

  it("rejects one key used as both author and reviewer", async () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db);
    const same = { author: publicKey, reviewer: publicKey };
    let router: ReturnType<typeof createReviewHostRouter> | undefined;
    try {
      router = createReviewHostRouter([lane()], { async deliver() {} }, same, { db });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/distinct|same key/);
    }
    const request = {
      laneId: "a",
      role: "reviewer" as const,
      requestId: "r-same",
      repositoryId: "repo-a",
      pr: 7,
      headSha: SHA_A,
      baseSha: SHA_B,
      treeHash: TREE,
    };
    if (router) {
      await expect(router.wake(request)).rejects.toThrow(/distinct|same key/);
      expect(() =>
        router?.ingestVerdict({
          ...request,
          decision: "approve",
          signature: "00",
        }),
      ).toThrow(/distinct|same key/);
    }
    expect(router).toBeUndefined();
  });

  it("reserves a wake before delivery and allows one winner under concurrency", async () => {
    const db = new DatabaseConstructor(":memory:");
    migrate(db);
    let entered = 0;
    let releaseHold: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    const transport: T3Transport = {
      async deliver() {
        entered += 1;
        await hold;
      },
    };
    const authority = { author: authorKeys.publicKey, reviewer: reviewerKeys.publicKey };
    const router = createReviewHostRouter([lane()], transport, authority, { db });
    const request = {
      laneId: "a",
      role: "reviewer" as const,
      requestId: "r-concurrent",
      repositoryId: "repo-a",
      pr: 7,
      headSha: SHA_A,
      baseSha: SHA_B,
      treeHash: TREE,
    };
    const first = router.wake(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = router.wake(request);
    const denied = expect(second).rejects.toThrow(/duplicate/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(1);
    releaseHold();
    await first;
    await denied;
    let failed = true;
    let deliveries = 0;
    const retry = createReviewHostRouter(
      [lane()],
      {
        async deliver() {
          if (failed) {
            failed = false;
            throw new Error("transport down");
          }
          deliveries += 1;
        },
      },
      authority,
      { db },
    );
    const again = { ...request, requestId: "r-retry" };
    await expect(retry.wake(again)).rejects.toThrow(/transport/);
    expect(
      db.prepare("SELECT request_id FROM deploy_wakes WHERE request_id = ?").get("r-retry"),
    ).toEqual({
      request_id: "r-retry",
    });
    await retry.wake(again);
    expect(deliveries).toBe(1);
    await expect(retry.wake(again)).rejects.toThrow(/duplicate/);
    expect(() => createReviewHostRouter([lane()], transport, authority)).toThrow(
      /durable|database/,
    );
  });

  it("rejects a scan or event identity that belongs to another repository", () => {
    const { store } = database();
    store.beginDrain("repo-a", 1);
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: owner("repo-a", 2, true, "omarchy"),
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
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal: store,
      freshMerges: () => [merged("foreign", "repo-b")],
      execute: () => ({ status: "deployed" }),
    });
    expect(() => service.tick("repo-a")).toThrow(/repository/);
    store.intake({
      deliveryId: "same-delivery",
      repositoryId: "repo-a",
      kind: "merge",
      eventId: "event-shared",
      mergeSha: SHA_A,
    });
    store.intake({
      deliveryId: "same-delivery",
      repositoryId: "repo-a",
      kind: "merge",
      eventId: "event-shared",
      mergeSha: SHA_A,
    });
    expect(() =>
      store.intake({
        deliveryId: "same-delivery",
        repositoryId: "repo-b",
        kind: "merge",
        eventId: "event-other",
        mergeSha: SHA_B,
      }),
    ).toThrow(/repository|delivery/);
    expect(() =>
      store.intake({
        deliveryId: "other-delivery",
        repositoryId: "repo-b",
        kind: "merge",
        eventId: "event-shared",
        mergeSha: SHA_B,
      }),
    ).toThrow(/repository|event/);
  });

  it("fences rollback when the persisted backup set is missing a file", () => {
    const { db, store } = database();
    cutover(store);
    store.applyDecision(intent("d1"));
    let restored: ReadonlyMap<string, Buffer> | null = null;
    const result = release(store, {
      callbacks: hooks({
        previous: () =>
          new Map<string, Buffer>([
            ["empty.txt", Buffer.alloc(0)],
            ["keep.txt", Buffer.from("kept")],
          ]),
        write: () => {
          db.prepare("DELETE FROM deploy_previous_files WHERE intent_id = ? AND path = ?").run(
            "intent-d1",
            "keep.txt",
          );
          throw new Error("copy failed");
        },
        restore: (files) => {
          restored = files;
        },
      }),
    });
    expect(result.status).toBe("fenced");
    expect(restored).toBeNull();
    expect(store.tryAcquire(9, { repositoryId: "repo-a", intentId: "intent-d1" })).toBe("fenced");
  });

  it("keeps a zero-byte file distinct from a missing backup member", () => {
    const { store } = database();
    cutover(store);
    store.applyDecision(intent("d1"));
    const captured: { files: ReadonlyMap<string, Buffer> | null } = { files: null };
    const result = release(store, {
      callbacks: hooks({
        previous: () =>
          new Map<string, Buffer>([
            ["empty.txt", Buffer.alloc(0)],
            ["keep.txt", Buffer.from("kept")],
          ]),
        verify: () => false,
        restore: (files) => {
          captured.files = files;
        },
      }),
    });
    expect(result.status).toBe("rolled-back");
    expect(captured.files?.get("empty.txt")?.length).toBe(0);
    expect(captured.files?.get("keep.txt")?.toString()).toBe("kept");
  });

  it("canonicalizes a missing lane root through the nearest real parent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-link-"));
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    const link = path.join(dir, "link");
    fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    const aliased = lane();
    aliased.roots = {
      checkout: path.join(link, "missing", "checkout"),
      worktree: path.join(dir, "lane-a", "worktree"),
      cache: path.join(dir, "lane-a", "cache"),
    };
    const direct = lane();
    direct.laneId = "b";
    direct.repositoryId = "repo-b";
    direct.threads = {
      author: { projectId: "pb", threadId: "b-author" },
      reviewer: { projectId: "pb2", threadId: "b-review" },
    };
    direct.roots = {
      checkout: path.join(real, "missing", "checkout"),
      worktree: path.join(dir, "lane-b", "worktree"),
      cache: path.join(dir, "lane-b", "cache"),
    };
    expect(() => loadRegistry(registryFile([aliased, direct]))).toThrow(/symlink|alias|overlap/);
    const windows = lane();
    windows.roots = {
      checkout: "C:/lanes/checkout",
      worktree: path.join(dir, "lane-a", "worktree"),
      cache: path.join(dir, "lane-a", "cache"),
    };
    const windowsError = process.platform === "win32" ? /linux-only/ : /windows/;
    expect(() => loadRegistry(registryFile([windows]))).toThrow(windowsError);
    const unc = lane();
    unc.roots = {
      checkout: "//server/share/checkout",
      worktree: path.join(dir, "lane-a", "worktree"),
      cache: path.join(dir, "lane-a", "cache"),
    };
    expect(() => loadRegistry(registryFile([unc]))).toThrow(/windows/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a linux symlink alias of a missing lane root",
    () => {
      expectLinkedAlias("dir");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "rejects a windows junction alias of a missing lane root",
    () => {
      expectLinkedAlias("junction");
    },
  );

  it("does not promote a candidate whose head, base, or tree is empty", () => {
    let state = blankCandidate({
      repositoryId: "repo-a",
      pr: 1,
      headSha: SHA_A,
      baseSha: SHA_B,
      treeHash: TREE,
    });
    state = advanceCandidate(state, { type: "head-changed", headSha: SHA_A });
    expect(state.id.treeHash).toBe("");
    state = advanceCandidate(state, { type: "checks", checks: "success" });
    state = advanceCandidate(state, {
      type: "verdict",
      verdict: {
        role: "author",
        decision: "approve",
        headSha: state.id.headSha,
        baseSha: state.id.baseSha,
        treeHash: "",
      },
    });
    state = advanceCandidate(state, {
      type: "verdict",
      verdict: {
        role: "reviewer",
        decision: "approve",
        headSha: state.id.headSha,
        baseSha: state.id.baseSha,
        treeHash: "",
      },
    });
    expect(state.state).not.toBe("merge-ready");
  });
});
