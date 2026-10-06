import { createHash, type KeyObject } from "node:crypto";
import { verifyArtifactEnvelope } from "./artifact.js";
import type { DeployJournal } from "./journal.js";
import type { ArtifactEnvelope, ArtifactFile } from "./types.js";

export interface Lease {
  release(): void;
}

export interface AdapterPolicy {
  allow: string[];
  deny: string[];
}

export interface RuntimeCallbacks {
  busy(): boolean;
  lease(): Lease;
  idle(): boolean;
  orderingOk(): boolean;
  write(envelope: ArtifactEnvelope, bytes: ReadonlyMap<string, Buffer>): void;
  restore(previous: ReadonlyMap<string, Buffer>): void;
  previous(): ReadonlyMap<string, Buffer>;
  reload?(): void;
  verify?(): boolean;
  verifyRestore?(): boolean;
  deliverReceipt?(): boolean;
  observe?(): string;
  afterMutation?(): void;
}

export interface ExecuteRequest {
  envelope: ArtifactEnvelope;
  bytes: ReadonlyMap<string, Buffer>;
  publicKey: KeyObject;
  expected: { architecture: string; runtimeVersions: Record<string, string>; repositoryId: string };
  journal: DeployJournal;
  intentId: string | null;
  adapterDigest: string;
  adapterPolicy: AdapterPolicy;
  adapterRollback: "files" | "unsafe";
  callbacks: RuntimeCallbacks;
  token: number;
  receiptId: string;
  replay: boolean;
}

export interface ExecuteResult {
  status: "deployed" | "nothing-to-deploy" | "rolled-back" | "fenced" | "pending";
}

const RECEIPT_STATUSES = [
  "deployed",
  "nothing-to-deploy",
  "rolled-back",
  "fenced",
  "pending",
] as const;

interface Gate {
  lease?: Lease;
  lockHeld: boolean;
  retained: boolean;
}

export function executeRelease(input: ExecuteRequest): ExecuteResult {
  const intentId = input.intentId;
  if (!intentId) throw new Error("intent is required");
  const intent = input.journal.intentRecord(intentId);
  if (
    !intent ||
    intent.repositoryId !== input.expected.repositoryId ||
    intent.repositoryId !== input.envelope.repositoryId ||
    intent.mergeSha !== input.envelope.mergeSha ||
    intent.treeHash !== input.envelope.treeHash
  ) {
    throw new Error("intent does not bind repository, merge, or tree");
  }
  const consumed = input.journal.consumedGenesis(intent.repositoryId);
  const owner = input.journal.owner(intent.repositoryId);
  if (!consumed || !owner || consumed.targetGeneration !== owner.generation) {
    throw new Error("consumed genesis does not match the active owner generation");
  }
  if (
    !consumed.adapterDigest ||
    !consumed.adapterVersion ||
    consumed.adapterDigest !== input.adapterDigest ||
    consumed.adapterVersion !== input.envelope.adapterVersion
  ) {
    throw new Error("adapter digest is not the active adapter");
  }
  if (input.replay) {
    const existing = input.journal.receipt(input.receiptId);
    if (existing) {
      if (!existing.acknowledged && delivered(input)) input.journal.acknowledge(input.receiptId);
      const status = RECEIPT_STATUSES.find((item) => item === existing.kind);
      if (status) return { status };
    }
  }
  const pause = input.journal.pause(intent.repositoryId);
  if (pause && pause.repairId !== intent.repairId) return { status: "pending" };
  if (input.callbacks.busy()) return { status: "pending" };
  const gate: Gate = { lockHeld: false, retained: false };
  try {
    gate.lease = input.callbacks.lease();
    if (!input.callbacks.idle()) return { status: "pending" };
    const acquired = input.journal.tryAcquire(input.token, {
      repositoryId: intent.repositoryId,
      intentId: intent.id,
    });
    if (acquired === "fenced") return { status: "fenced" };
    if (acquired !== "acquired") return { status: "pending" };
    gate.lockHeld = true;
    if (!input.callbacks.orderingOk()) return { status: "pending" };
    verifyArtifactEnvelope(input.envelope, input.bytes, input.publicKey, {
      architecture: input.expected.architecture,
      runtimeVersions: input.expected.runtimeVersions,
      repositoryId: input.expected.repositoryId,
      policy: input.adapterPolicy,
    });
    if (input.envelope.files.length === 0) {
      input.journal.enqueueReceipt(input.receiptId, intentId, "nothing-to-deploy");
      input.journal.acknowledge(input.receiptId);
      input.journal.markSettled(intentId, "nothing-to-deploy");
      return { status: "nothing-to-deploy" };
    }
    const previous = input.callbacks.previous();
    const previousManifest = hashPrevious(previous);
    const targetManifest = hashFiles(input.envelope.files);
    const current = input.journal.intentRecord(intentId);
    const alreadyCopied =
      current?.targetManifest === targetManifest &&
      (current.phase === "activating" || current.phase === "prepared") &&
      input.callbacks.observe?.() === current.targetManifest;
    if (!alreadyCopied) {
      input.journal.prepareActivation(intentId, previousManifest, targetManifest);
      input.journal.beginActivation(intentId);
      try {
        input.callbacks.write(input.envelope, input.bytes);
      } catch (error) {
        return rollback(input, gate, error, previous);
      }
    }
    try {
      input.callbacks.reload?.();
      if (input.callbacks.verify && !input.callbacks.verify()) {
        throw new Error("reload verification failed");
      }
      input.callbacks.afterMutation?.();
      input.journal.recordManifest(intentId, targetManifest);
      input.journal.enqueueReceipt(input.receiptId, intentId, "deployed");
      if (delivered(input)) input.journal.acknowledge(input.receiptId);
      input.journal.markSettled(intentId, "deployed");
    } catch (error) {
      if (error instanceof Error && error.message === "reload verification failed") {
        return rollback(input, gate, error, previous);
      }
      gate.retained = true;
      input.journal.retain(
        input.token,
        error instanceof Error ? error.message : "uncertain activation",
      );
      return { status: "fenced" };
    }
    return { status: "deployed" };
  } finally {
    if (gate.lockHeld && !gate.retained) {
      input.journal.release(input.token);
      gate.lockHeld = false;
    }
    gate.lease?.release();
  }
}

function rollback(
  input: ExecuteRequest,
  gate: Gate,
  error: unknown,
  previous: ReadonlyMap<string, Buffer>,
): ExecuteResult {
  const intentId = input.intentId;
  if (!intentId) throw new Error("intent is required");
  const intent = input.journal.intentRecord(intentId);
  if (!intent) throw new Error("intent is required");
  if (input.adapterRollback === "unsafe") {
    gate.retained = true;
    input.journal.retain(input.token, error instanceof Error ? error.message : "unsafe rollback");
    return { status: "fenced" };
  }
  try {
    input.callbacks.restore(previous);
    if (input.callbacks.verifyRestore && !input.callbacks.verifyRestore()) {
      throw new Error("restore verification failed");
    }
  } catch (restoreError) {
    gate.retained = true;
    input.journal.retain(
      input.token,
      restoreError instanceof Error ? restoreError.message : "rollback failed",
    );
    return { status: "fenced" };
  }
  const repairId = `repair-${input.receiptId}`;
  input.journal.pauseForRepair(
    intent.repositoryId,
    repairId,
    "verified rollback requires a linked repair",
  );
  input.journal.enqueueReceipt(input.receiptId, intentId, "rolled-back");
  if (delivered(input)) input.journal.acknowledge(input.receiptId);
  input.journal.markSettled(intentId, "rolled-back");
  return { status: "rolled-back" };
}

function delivered(input: ExecuteRequest): boolean {
  return input.callbacks.deliverReceipt?.() ?? true;
}

function hashFiles(files: readonly ArtifactFile[]): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

function hashPrevious(previous: ReadonlyMap<string, Buffer>): string {
  const entries = [...previous.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, bytes]) => [filePath, bytes.toString("base64")]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
