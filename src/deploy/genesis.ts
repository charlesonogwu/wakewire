import type { KeyObject } from "node:crypto";
import { verifySignature } from "./crypto.js";

export interface GenesisAdapterRecord {
  repositoryId: string;
  adapterVersion: string;
  adapterDigest: string;
  mergeSha: string;
  treeHash: string;
  mergeEventId: string;
  targetGeneration: number;
  signature: string;
}

export function verifyGenesisAdapterRecord(
  record: GenesisAdapterRecord,
  publicKey: KeyObject,
  consumedEventIds: ReadonlySet<string>,
  expectedRepositoryId?: string,
): void {
  const { signature, ...body } = record;
  if (!verifySignature(body, signature, publicKey)) throw new Error("missing genesis signature");
  if (expectedRepositoryId !== undefined && record.repositoryId !== expectedRepositoryId) {
    throw new Error("repository mismatch");
  }
  if (consumedEventIds.has(record.mergeEventId)) throw new Error("reused genesis record");
}

export const genesisExports = ["verifyGenesisAdapterRecord"] as const;
