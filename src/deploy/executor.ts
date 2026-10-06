import { createHash, type KeyObject } from "node:crypto";
import { verifyArtifactEnvelope } from "./artifact.js";
import type { DeployJournal } from "./journal.js";
import type { ArtifactEnvelope } from "./types.js";

export interface Lease {
  release(): void;
}

export interface RuntimeCallbacks {
  busy(): boolean;
  lease(): Lease;
  idle(): boolean;
  orderingOk(): boolean;
  write(envelope: ArtifactEnvelope, bytes: ReadonlyMap<string, Buffer>): void;
  restore(previous: ReadonlyMap<string, Buffer>): void;
  previous(): ReadonlyMap<string, Buffer>;
}

export interface ExecuteRequest {
  envelope: ArtifactEnvelope;
  bytes: ReadonlyMap<string, Buffer>;
  publicKey: KeyObject;
  expected: { architecture: string; runtimeVersions: Record<string, string>; repositoryId: string };
  journal: DeployJournal;
  intentId: string | null;
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

export function executeRelease(input: ExecuteRequest): ExecuteResult {
  assertGenesis(input);
  if (input.replay) {
    const existing = input.journal.receipt(input.receiptId);
    if (existing) {
      if (!existing.acknowledged) input.journal.acknowledge(input.receiptId);
      const status = RECEIPT_STATUSES.find((item) => item === existing.kind);
      if (status) return { status };
    }
  }
  if (input.callbacks.busy()) return { status: "pending" };
  const lease = input.callbacks.lease();
  if (!input.callbacks.idle()) {
    lease.release();
    return { status: "pending" };
  }
  const acquired = input.journal.tryAcquire(input.token);
  if (acquired === "fenced") {
    lease.release();
    return { status: "fenced" };
  }
  if (acquired !== "acquired") {
    lease.release();
    return { status: "pending" };
  }
  if (!input.callbacks.orderingOk()) {
    input.journal.release(input.token);
    lease.release();
    return { status: "pending" };
  }
  try {
    verifyArtifactEnvelope(input.envelope, input.bytes, input.publicKey, input.expected);
  } catch (error) {
    input.journal.release(input.token);
    lease.release();
    throw error;
  }
  if (input.envelope.files.length === 0) {
    input.journal.enqueueReceipt(input.receiptId, input.intentId, "nothing-to-deploy");
    input.journal.acknowledge(input.receiptId);
    input.journal.release(input.token);
    lease.release();
    return { status: "nothing-to-deploy" };
  }
  if (input.intentId) {
    try {
      input.journal.beginActivation(input.intentId);
    } catch (error) {
      input.journal.release(input.token);
      lease.release();
      throw error;
    }
  }
  try {
    input.callbacks.write(input.envelope, input.bytes);
  } catch (error) {
    return rollback(input, lease, error);
  }
  const hash = createHash("sha256").update(JSON.stringify(input.envelope.files)).digest("hex");
  if (input.intentId) input.journal.recordManifest(input.intentId, hash);
  input.journal.enqueueReceipt(input.receiptId, input.intentId, "deployed");
  input.journal.acknowledge(input.receiptId);
  input.journal.release(input.token);
  lease.release();
  return { status: "deployed" };
}

function rollback(input: ExecuteRequest, lease: Lease, error: unknown): ExecuteResult {
  if (input.adapterRollback === "unsafe") {
    input.journal.retain(input.token, error instanceof Error ? error.message : "unsafe rollback");
    lease.release();
    return { status: "fenced" };
  }
  try {
    input.callbacks.restore(input.callbacks.previous());
  } catch (restoreError) {
    input.journal.retain(
      input.token,
      restoreError instanceof Error ? restoreError.message : "rollback failed",
    );
    lease.release();
    return { status: "fenced" };
  }
  input.journal.release(input.token);
  lease.release();
  return { status: "rolled-back" };
}

function assertGenesis(input: ExecuteRequest): void {
  const consumed = input.journal.consumedGenesis(input.expected.repositoryId);
  const owner = input.journal.owner(input.expected.repositoryId);
  if (!consumed || !owner || consumed.targetGeneration !== owner.generation) {
    throw new Error("consumed genesis does not match the active owner generation");
  }
}
