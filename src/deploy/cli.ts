import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import type { RuntimeAdapter } from "./adapter.js";
import { buildArtifactEnvelope } from "./artifact.js";
import { canonicalJson } from "./crypto.js";
import { type ExecuteRequest, executeRelease } from "./executor.js";
import type { GenesisAdapterRecord } from "./genesis.js";
import { openDeployJournal } from "./journal.js";
import type { FreshMerge } from "./reconcile.js";
import type { RecoveryEvidence } from "./recovery.js";
import { createDeploymentService } from "./service.js";
import type { EngineeringOwnerRecord } from "./types.js";

export interface StatusRepository {
  repositoryId: string;
  owner: string;
  phase: string;
  generation: number;
  deploymentActivationEnabled: boolean;
  signature?: string;
  token?: string;
  notice?: string;
}

export interface DeployCliDeps {
  dryRun: () => { repositoryId: "example/one"; status: "nothing-to-deploy"; writes: number };
  recover: (evidence: RecoveryEvidence) => "cleared" | "fenced";
  status: () => { repositories: StatusRepository[] };
}

const FORBIDDEN = /^--(repo|path|command|enable|activate|clear|merge)(?:=|$)/;

export function dispatchDeploy(argv: readonly string[], deps: DeployCliDeps): unknown {
  if (argv.some((arg) => arg === "merge" || FORBIDDEN.test(arg))) {
    throw new Error("merge and arbitrary repo, path, or command arguments are forbidden");
  }
  const [action, ...rest] = argv;
  if (action === "dry-run") {
    if (rest.length > 0) throw new Error("dry-run accepts no arguments");
    return deps.dryRun();
  }
  if (action === "status") {
    if (rest.length > 0) throw new Error("status accepts no arguments");
    return JSON.parse(renderStatus(deps.status())) as unknown;
  }
  if (action === "recover") {
    return { status: deps.recover(parseRecover(rest)) };
  }
  throw new Error(`unsupported deploy action: ${action ?? ""}`);
}

export function renderStatus(status: { repositories: StatusRepository[] }): string {
  const repositories = status.repositories.map((row) => ({
    repositoryId: row.repositoryId,
    owner: row.owner,
    phase: row.phase,
    generation: row.generation,
    deploymentActivationEnabled: row.deploymentActivationEnabled,
    ...(row.notice ? { notice: row.notice.replace(/ghp_[A-Za-z0-9_]+/g, "[redacted]") } : {}),
  }));
  const output = JSON.stringify({ repositories });
  if (output.includes("ghp_") || output.includes("secret-signature")) {
    throw new Error("status leaked a secret");
  }
  return output;
}

export function readDeployStatus(db: Database): { repositories: StatusRepository[] } {
  const rows = db
    .prepare(
      `SELECT repository_id, owner, phase, generation, deployment_activation_enabled, signature
       FROM deploy_owners ORDER BY repository_id`,
    )
    .all() as Array<{
    repository_id: string;
    owner: string;
    phase: string;
    generation: number;
    deployment_activation_enabled: number;
    signature: string;
  }>;
  return {
    repositories: rows.map((row) => ({
      repositoryId: row.repository_id,
      owner: row.owner,
      phase: row.phase,
      generation: row.generation,
      deploymentActivationEnabled: row.deployment_activation_enabled === 1,
      signature: row.signature,
    })),
  };
}

export function runDryRun(): {
  repositoryId: "example/one";
  status: "nothing-to-deploy";
  writes: number;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const db = new DatabaseConstructor(":memory:");
  migrate(db);
  const journal = openDeployJournal(db);
  const repositoryId = "example/one";
  journal.pinTrust("pinned-key", publicKey);
  const adapter: RuntimeAdapter = {
    version: "1",
    repositoryId,
    allow: ["docs/"],
    deny: [".env"],
    runtimeTargetId: "runtime-dry",
    busyCheckId: "busy-dry",
    verifyCheckId: "verify-dry",
    reloadId: "reload-dry",
    rollback: "files",
    architecture: "x64",
    runtimeVersions: { node: "20" },
    verificationKeyId: "pinned-key",
  };
  const digest = journal.pinAdapter(adapter);
  journal.seedOwner(
    ownerRecord(privateKey, {
      repositoryId,
      owner: "legacy",
      phase: "stable",
      generation: 1,
      deploymentActivationEnabled: false,
      updatedAt: "2026-10-06T00:00:00.000Z",
    }),
  );
  let writes = 0;
  let token = 0;
  const outcome: {
    status: "nothing-to-deploy" | "deployed" | "rolled-back" | "fenced" | "pending";
  } = { status: "pending" };
  const service = createDeploymentService({
    host: "omarchy",
    publicKey,
    journal,
    freshMerges: () => [sampleMerge(repositoryId)],
    nextToken: () => {
      token += 1;
      return token;
    },
    artifactFor: () =>
      dryArtifact(privateKey, repositoryId, adapter, () => {
        writes += 1;
      }),
    execute: (input) => {
      if (!input) throw new Error("dry-run executor request is missing");
      const result = executeRelease(input);
      outcome.status = result.status;
      return result;
    },
  });
  service.bootstrap({
    repositoryId,
    expectedGeneration: 1,
    next: ownerRecord(privateKey, {
      repositoryId,
      owner: "omarchy",
      phase: "stable",
      generation: 2,
      deploymentActivationEnabled: true,
      updatedAt: "2026-10-06T00:00:00.000Z",
    }),
    genesis: genesisRecord(privateKey, repositoryId, digest),
    rollback: false,
    keyId: "pinned-key",
  });
  service.tick(repositoryId);
  db.close();
  if (outcome.status !== "nothing-to-deploy") throw new Error(`dry-run status ${outcome.status}`);
  return { repositoryId, status: outcome.status, writes };
}

function parseRecover(rest: readonly string[]): RecoveryEvidence {
  if (rest.some((arg) => arg === "--manifest" || arg.startsWith("--manifest="))) {
    throw new Error("caller manifest is rejected");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag || !value || value.startsWith("--")) {
      throw new Error("recovery requires repository, intent, and token");
    }
    values.set(flag, value);
  }
  const repositoryId = values.get("--repository");
  const intentId = values.get("--intent");
  const tokenText = values.get("--token");
  const token = Number(tokenText);
  if (
    values.size !== 3 ||
    !repositoryId ||
    !intentId ||
    !tokenText ||
    !Number.isInteger(token) ||
    token <= 0
  ) {
    throw new Error("recovery requires repository, intent, and token");
  }
  return { repositoryId, intentId, token };
}

function ownerRecord(
  privateKey: KeyObject,
  body: Omit<EngineeringOwnerRecord, "signature">,
): EngineeringOwnerRecord {
  return {
    ...body,
    signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url"),
  };
}

function genesisRecord(
  privateKey: KeyObject,
  repositoryId: string,
  adapterDigest: string,
): GenesisAdapterRecord {
  const body = {
    repositoryId,
    adapterVersion: "1",
    adapterDigest,
    mergeSha: "a".repeat(40),
    treeHash: "b".repeat(40),
    mergeEventId: "adapter-merge",
    targetGeneration: 2,
  };
  return {
    ...body,
    signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url"),
  };
}

function sampleMerge(repositoryId: string): FreshMerge {
  return {
    deliveryId: "dry-run-merge",
    repositoryId,
    kind: "pull_request_merged",
    mergedBy: "operator",
    expectedOperator: "operator",
    pr: 1,
    headSha: "a".repeat(40),
    reviewedHeadSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewedBaseSha: "b".repeat(40),
    treeHash: "c".repeat(40),
    reviewedTreeHash: "c".repeat(40),
    mergeSha: "e".repeat(40),
    newerReleaseActivated: false,
    authorApproved: true,
    reviewerApproved: true,
    checks: "success",
  };
}

function dryArtifact(
  privateKey: KeyObject,
  repositoryId: string,
  adapter: RuntimeAdapter,
  write: () => void,
): Omit<ExecuteRequest, "journal" | "intentId" | "token" | "receiptId" | "replay"> {
  const bytes = Buffer.from("# example\n");
  return {
    envelope: buildArtifactEnvelope({
      repositoryId,
      mergeSha: "e".repeat(40),
      treeHash: "c".repeat(40),
      adapterVersion: "1",
      architecture: "x64",
      runtimeVersions: { node: "20" },
      compatibility: "reversible",
      files: [{ path: "docs/readme.md", mode: 0o100644, bytes }],
      expectedArchitecture: "x64",
      expectedRuntimeVersions: { node: "20" },
      adapterIntroducedByMerge: null,
      signingKey: privateKey,
    }),
    bytes: new Map(),
    expected: { architecture: "x64", runtimeVersions: { node: "20" }, repositoryId },
    adapterDigest: "ignored",
    adapterPolicy: { allow: [".env"], deny: [] },
    adapterRollback: "unsafe",
    callbacks: {
      runtimeTargetId: adapter.runtimeTargetId,
      busyCheckId: adapter.busyCheckId,
      verifyCheckId: adapter.verifyCheckId,
      reloadId: adapter.reloadId,
      busy: () => false,
      lease: () => ({ release() {} }),
      idle: () => true,
      orderingOk: () => true,
      write: () => write(),
      restore: () => undefined,
      previous: () => new Map(),
      reload: () => undefined,
      verify: () => true,
      verifyRestore: () => true,
      deliverReceipt: () => true,
      observe: () => "",
    },
  };
}
