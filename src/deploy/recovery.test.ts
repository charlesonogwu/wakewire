import { generateKeyPairSync, sign } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrations.js";
import { canonicalJson } from "./crypto.js";
import type { GenesisAdapterRecord } from "./genesis.js";
import { openDeployJournal } from "./journal.js";
import { recover } from "./recovery.js";
import type { EngineeringOwnerRecord } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function signed<T extends object>(body: T): T & { signature: string } {
  return {
    ...body,
    signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url"),
  };
}

describe("recover", () => {
  it("clears a matching manifest without creating an intent and keeps every other fence", () => {
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
    journal.pinTrust("pinned-key", publicKey);
    journal.seedOwner(initial);
    journal.beginDrain("repo-a", 1);
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
      next: signed({
        repositoryId: "repo-a",
        owner: "omarchy" as const,
        phase: "stable" as const,
        generation: 2,
        deploymentActivationEnabled: true,
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      genesis,
      keyId: "pinned-key",
      rollback: false,
    });
    journal.applyDecision({
      kind: "intent",
      repositoryId: "repo-a",
      repairId: null,
      notice: null,
      deliveryId: "d1",
      mergeSha: "c".repeat(40),
      treeHash: "b".repeat(40),
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      pr: 1,
    });
    journal.recordManifest("intent-d1", "manifest-hash");
    expect(journal.tryAcquire(1, { repositoryId: "repo-a", intentId: "intent-d1" })).toBe(
      "acquired",
    );
    journal.retain(1, "uncertain");
    expect(
      recover(
        db,
        {
          repositoryId: "repo-a",
          intentId: "intent-d1",
          token: 1,
        },
        () => "other",
      ),
    ).toBe("fenced");
    expect(journal.tryAcquire(2)).toBe("fenced");
    expect(
      recover(
        db,
        {
          repositoryId: "repo-a",
          intentId: "intent-d1",
          token: 1,
        },
        () => "manifest-hash",
      ),
    ).toBe("cleared");
    expect(journal.tryAcquire(2)).toBe("acquired");
    expect(journal.intentId("recovery-must-not-create")).toBeNull();
  });
});
