import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./crypto.js";
import {
  type GenesisAdapterRecord,
  genesisExports,
  verifyGenesisAdapterRecord,
} from "./genesis.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function record(overrides: Partial<GenesisAdapterRecord> = {}): GenesisAdapterRecord {
  const body = {
    repositoryId: "repo-a",
    adapterVersion: "1",
    adapterDigest: "d".repeat(64),
    mergeSha: "a".repeat(40),
    treeHash: "b".repeat(40),
    mergeEventId: "merge-event-1",
    targetGeneration: 2,
    ...overrides,
  };
  const signature = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url");
  return { ...body, signature };
}

describe("genesis", () => {
  it("rejects a missing signature, reuse, and a repository mismatch", () => {
    expect(() =>
      verifyGenesisAdapterRecord({ ...record(), signature: "nope" }, publicKey, new Set()),
    ).toThrow(/signature/);
    const valid = record();
    expect(() =>
      verifyGenesisAdapterRecord(valid, publicKey, new Set([valid.mergeEventId])),
    ).toThrow(/reused/);
    expect(() =>
      verifyGenesisAdapterRecord(record({ repositoryId: "repo-b" }), publicKey, new Set(), "repo-a"),
    ).toThrow(/repository/);
  });

  it("does not let an executor create genesis trust", () => {
    expect(genesisExports).not.toContain("createGenesis");
    expect(() => verifyGenesisAdapterRecord(record(), publicKey, new Set())).not.toThrow();
  });
});
