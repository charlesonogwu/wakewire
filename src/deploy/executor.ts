import { createHash } from "node:crypto";
import type { RuntimeAdapter } from "./adapter.js";
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
  runtimeTargetId: string;
  busyCheckId: string;
  verifyCheckId: string;
  reloadId: string;
  busy(): boolean;
  lease(): Lease;
  idle(): boolean;
  orderingOk(): boolean;
  write(envelope: ArtifactEnvelope, bytes: ReadonlyMap<string, Buffer>): void;
  restore(previous: ReadonlyMap<string, Buffer>): void;
  previous(): ReadonlyMap<string, Buffer>;
  reload(): void;
  verify(): boolean;
  verifyRestore(): boolean;
  deliverReceipt(): boolean;
  observe(): string;
  afterMutation?(): void;
}

export interface ExecuteRequest {
  envelope: ArtifactEnvelope;
  bytes: ReadonlyMap<string, Buffer>;
  expected: { architecture: string; runtimeVersions: Record<string, string>; repositoryId: string };
  journal: DeployJournal;
  intentId: string | null;
  adapterDigest?: string;
  adapterPolicy?: AdapterPolicy;
  adapterRollback?: "files" | "unsafe";
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
  deploymentLeaseId?: string;
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
  if (owner.phase !== "stable" || !owner.deploymentActivationEnabled) {
    throw new Error("deployment activation is not enabled for the active owner");
  }
  const adapter = input.journal.activatedAdapter(intent.repositoryId);
  if (!adapter || adapter.version !== input.envelope.adapterVersion) {
    throw new Error("adapter digest is not the active adapter");
  }
  const callbacks = requireCallbacks(input.callbacks, adapter);
  const manifestHash = hashFiles(input.envelope.files);
  const existing = input.journal.receipt(input.receiptId);
  if (existing) {
    if (
      (existing.intentId !== null && existing.intentId !== intentId) ||
      (existing.repositoryId !== null && existing.repositoryId !== intent.repositoryId) ||
      (existing.mergeSha !== null && existing.mergeSha !== intent.mergeSha) ||
      (existing.treeHash !== null && existing.treeHash !== intent.treeHash) ||
      (existing.manifestHash !== null && existing.manifestHash !== manifestHash)
    ) {
      throw new Error("unrelated receipt");
    }
    if (!existing.acknowledged) {
      try {
        if (callbacks.deliverReceipt()) input.journal.acknowledge(input.receiptId);
      } catch (error) {
        throw new ReceiptDeliveryError(error instanceof Error ? error.message : "delivery failed");
      }
    }
    if (
      existing.kind === "deployed" ||
      existing.kind === "nothing-to-deploy" ||
      existing.kind === "rolled-back"
    ) {
      input.journal.markSettled(intentId, existing.kind);
    }
    const status = RECEIPT_STATUSES.find((item) => item === existing.kind);
    if (status) return { status };
  }
  const pause = input.journal.pause(intent.repositoryId);
  if (pause && pause.repairId !== intent.repairId) {
    const peeked = input.journal.tryAcquire(input.token, {
      repositoryId: intent.repositoryId,
      intentId: intent.id,
    });
    if (peeked === "fenced") return { status: "fenced" };
    if (peeked === "acquired") input.journal.release(input.token);
    return { status: "pending" };
  }
  if (callbacks.busy()) return { status: "pending" };
  const gate: Gate = { lockHeld: false, retained: false };
  try {
    gate.lease = callbacks.lease();
    if (!callbacks.idle()) return { status: "pending" };
    const acquired = input.journal.tryAcquire(input.token, {
      repositoryId: intent.repositoryId,
      intentId: intent.id,
    });
    if (acquired === "fenced") return { status: "fenced" };
    if (acquired !== "acquired") return { status: "pending" };
    gate.lockHeld = true;
    if (!callbacks.orderingOk()) return { status: "pending" };
    const deploymentLeaseId = `deployment:${intentId}:${input.token}`;
    input.journal.acquireLease({
      id: deploymentLeaseId,
      repositoryId: intent.repositoryId,
      generation: owner.generation,
      kind: "deployment",
    });
    gate.deploymentLeaseId = deploymentLeaseId;
    verifyArtifactEnvelope(
      input.envelope,
      input.bytes,
      input.journal.trustKey(adapter.verificationKeyId),
      {
        architecture: adapter.architecture,
        runtimeVersions: adapter.runtimeVersions,
        repositoryId: intent.repositoryId,
        policy: { allow: adapter.allow, deny: adapter.deny },
      },
    );
    if (input.envelope.files.length === 0) {
      publishReceipt(input, intent, "nothing-to-deploy", manifestHash);
      input.journal.markSettled(intentId, "nothing-to-deploy");
      clearMatchingPause(input, intent.repairId);
      return { status: "nothing-to-deploy" };
    }
    const previous = durablePrevious(input, intentId);
    const previousManifest = hashPrevious(previous);
    const targetManifest = hashFiles(input.envelope.files);
    const current = input.journal.intentRecord(intentId);
    const alreadyCopied =
      current?.targetManifest === targetManifest &&
      (current.phase === "activating" || current.phase === "prepared") &&
      callbacks.observe() === current.targetManifest;
    if (!alreadyCopied) {
      input.journal.savePreviousFiles(intentId, previous);
      input.journal.prepareActivation(intentId, previousManifest, targetManifest);
      input.journal.beginActivation(intentId);
      try {
        callbacks.write(input.envelope, input.bytes);
      } catch (error) {
        return rollback(input, gate, adapter, error);
      }
    }
    try {
      callbacks.reload();
      if (!callbacks.verify()) throw new Error("reload verification failed");
      callbacks.afterMutation?.();
      input.journal.recordManifest(intentId, targetManifest);
      publishReceipt(input, intent, "deployed", manifestHash);
      input.journal.markSettled(intentId, "deployed");
      clearMatchingPause(input, intent.repairId);
    } catch (error) {
      if (error instanceof ReceiptDeliveryError) throw error;
      if (error instanceof Error && error.message === "reload verification failed") {
        return rollback(input, gate, adapter, error);
      }
      gate.retained = true;
      input.journal.retain(
        input.token,
        error instanceof Error ? error.message : "uncertain activation",
      );
      publishReceipt(input, intent, "fenced", manifestHash);
      return { status: "fenced" };
    }
    return { status: "deployed" };
  } finally {
    if (gate.deploymentLeaseId && !gate.retained) {
      input.journal.releaseLease(gate.deploymentLeaseId);
    }
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
  adapter: RuntimeAdapter,
  error: unknown,
): ExecuteResult {
  const intentId = input.intentId;
  if (!intentId) throw new Error("intent is required");
  const intent = input.journal.intentRecord(intentId);
  if (!intent) throw new Error("intent is required");
  const repairId = `repair-${input.receiptId}`;
  const manifestHash = hashFiles(input.envelope.files);
  const backup = input.journal.readBackup(intentId);
  if (adapter.rollback !== "unsafe" && (!backup.recorded || !backup.complete)) {
    gate.retained = true;
    input.journal.retain(input.token, "incomplete backup set");
    input.journal.pauseForRepair(intent.repositoryId, repairId, "incomplete backup set");
    publishReceipt(input, intent, "fenced", manifestHash);
    return { status: "fenced" };
  }
  if (adapter.rollback === "unsafe") {
    gate.retained = true;
    input.journal.retain(input.token, error instanceof Error ? error.message : "unsafe rollback");
    input.journal.pauseForRepair(intent.repositoryId, repairId, "unsafe rollback requires repair");
    publishReceipt(input, intent, "fenced", manifestHash);
    return { status: "fenced" };
  }
  try {
    input.callbacks.restore(backup.files);
    if (!input.callbacks.verifyRestore()) throw new Error("restore verification failed");
  } catch (restoreError) {
    gate.retained = true;
    input.journal.retain(
      input.token,
      restoreError instanceof Error ? restoreError.message : "rollback failed",
    );
    input.journal.pauseForRepair(intent.repositoryId, repairId, "rollback failed");
    publishReceipt(input, intent, "fenced", manifestHash);
    return { status: "fenced" };
  }
  input.journal.pauseForRepair(
    intent.repositoryId,
    repairId,
    "verified rollback requires a linked repair",
  );
  publishReceipt(input, intent, "rolled-back", manifestHash);
  input.journal.markSettled(intentId, "rolled-back");
  return { status: "rolled-back" };
}

function publishReceipt(
  input: ExecuteRequest,
  intent: { id: string; repositoryId: string; mergeSha: string; treeHash: string },
  kind: string,
  manifestHash: string,
): void {
  input.journal.enqueueReceipt(input.receiptId, intent.id, kind, {
    repositoryId: intent.repositoryId,
    mergeSha: intent.mergeSha,
    treeHash: intent.treeHash,
    manifestHash,
  });
  try {
    if (input.callbacks.deliverReceipt()) input.journal.acknowledge(input.receiptId);
  } catch (error) {
    throw new ReceiptDeliveryError(error instanceof Error ? error.message : "delivery failed");
  }
}

class ReceiptDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptDeliveryError";
  }
}

function requireCallbacks(callbacks: RuntimeCallbacks, adapter: RuntimeAdapter): RuntimeCallbacks {
  if (
    callbacks.runtimeTargetId !== adapter.runtimeTargetId ||
    callbacks.busyCheckId !== adapter.busyCheckId ||
    callbacks.verifyCheckId !== adapter.verifyCheckId ||
    callbacks.reloadId !== adapter.reloadId
  ) {
    throw new Error("adapter callbacks are not the activated adapter");
  }
  return callbacks;
}

function durablePrevious(input: ExecuteRequest, intentId: string): ReadonlyMap<string, Buffer> {
  const stored = input.journal.readBackup(intentId);
  if (stored.recorded) {
    if (!stored.complete) throw new Error("incomplete backup set");
    return stored.files;
  }
  const fresh = input.callbacks.previous();
  input.journal.savePreviousFiles(intentId, fresh);
  return fresh;
}

function clearMatchingPause(input: ExecuteRequest, repairId: string | null): void {
  if (!repairId) return;
  const pause = input.journal.pause(input.expected.repositoryId);
  if (pause?.repairId === repairId) input.journal.clearPause(input.expected.repositoryId, repairId);
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
