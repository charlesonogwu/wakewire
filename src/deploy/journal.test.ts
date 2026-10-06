import { generateKeyPairSync, sign } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrations.js";
import { canonicalJson } from "./crypto.js";
import type { GenesisAdapterRecord } from "./genesis.js";
import { openDeployJournal } from "./journal.js";
import type { EngineeringOwnerRecord, MergeDecision } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function signBody<T extends object>(body: T): T & { signature: string } {
  const signature = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url");
  return { ...body, signature };
}

function owner(
  generation: number,
  phase: EngineeringOwnerRecord["phase"] = "stable",
): EngineeringOwnerRecord {
  return signBody({
    repositoryId: "repo-a",
    owner: generation > 1 ? "omarchy" : "legacy",
    phase,
    generation,
    deploymentActivationEnabled: generation > 1,
    updatedAt: "2026-10-06T00:00:00.000Z",
  });
}

function genesis(generation = 2): GenesisAdapterRecord {
  return signBody({
    repositoryId: "repo-a",
    adapterVersion: "1",
    adapterDigest: "d".repeat(64),
    mergeSha: "a".repeat(40),
    treeHash: "b".repeat(40),
    mergeEventId: "adapter-merge",
    targetGeneration: generation,
  });
}

function intent(): Extract<MergeDecision, { kind: "intent" }> {
  return {
    kind: "intent",
    repositoryId: "repo-a",
    repairId: null,
    notice: null,
    deliveryId: "d1",
    mergeSha: "c".repeat(40),
    treeHash: "b".repeat(40),
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    pr: 4,
  };
}

function journal() {
  const db = new DatabaseConstructor(":memory:");
  migrate(db);
  const store = openDeployJournal(db);
  store.seedOwner(owner(1));
  return store;
}

describe("deploy journal", () => {
  it("records an intent before activation and a refusal without an intent", () => {
    const store = journal();
    store.applyDecision(intent());
    expect(store.phases("intent-d1")).toEqual(["recorded"]);
    store.beginActivation("intent-d1");
    expect(store.phases("intent-d1")[0]).toBe("recorded");
    store.applyDecision({
      kind: "refuse",
      repositoryId: "repo-a",
      repairId: "repair-1",
      notice: "tree mismatch",
      deliveryId: "d2",
    });
    expect(store.intentId("d2")).toBeNull();
    expect(store.pause("repo-a")?.repairId).toBe("repair-1");
  });

  it("keeps review receipts off the merge cursor and bootstrap-consumes genesis out of order", () => {
    const store = journal();
    store.intake({ deliveryId: "r", repositoryId: "repo-a", kind: "review", eventId: "review-1" });
    store.intake({
      deliveryId: "m1",
      repositoryId: "repo-a",
      kind: "merge",
      eventId: "pin-merge",
      mergeSha: "1".repeat(40),
    });
    store.intake({
      deliveryId: "m2",
      repositoryId: "repo-a",
      kind: "merge",
      eventId: "adapter-merge",
      mergeSha: "a".repeat(40),
    });
    store.beginDrain("repo-a", 1);
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: owner(2),
      genesis: genesis(),
      publicKey,
      rollback: false,
    });
    expect(store.disposition("repo-a", "adapter-merge")).toBe("bootstrap-consumed");
    expect(store.intentId("m2")).toBeNull();
    expect(store.advanceCursor("repo-a")).toBe(0);
    store.applyDecision({ ...intent(), deliveryId: "pin", mergeSha: "1".repeat(40) });
    // pin disposition is an intent record, but the cursor needs a disposition row.
    expect(store.cursor("repo-a")).toBe(0);
  });

  it("refuses ownership change while a deploy is active or the fence is uncertain", () => {
    const store = journal();
    store.beginDrain("repo-a", 1);
    store.setActiveDeploys("repo-a", 1);
    expect(() =>
      store.completeOwnerChange({
        repositoryId: "repo-a",
        expectedGeneration: 1,
        next: owner(2),
        genesis: genesis(),
        publicKey,
        rollback: false,
      }),
    ).toThrow(/active transaction/);
    store.setActiveDeploys("repo-a", 0);
    store.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: owner(2),
      genesis: genesis(),
      publicKey,
      rollback: false,
    });
    expect(store.tryAcquire(1)).toBe("acquired");
    store.retain(1, "uncertain");
    store.beginDrain("repo-a", 2);
    expect(() =>
      store.completeOwnerChange({
        repositoryId: "repo-a",
        expectedGeneration: 2,
        next: owner(1, "stable"),
        genesis: null,
        publicKey,
        rollback: true,
      }),
    ).toThrow(/uncertainty fence/);
    expect(() => store.clearFence()).toThrow(/forbidden/);
  });

  it("replays an unacknowledged receipt once", () => {
    const store = journal();
    store.applyDecision(intent());
    store.enqueueReceipt("receipt-1", "intent-d1", "deployed");
    expect(store.pendingReceipts()).toEqual(["receipt-1"]);
    store.acknowledge("receipt-1");
    expect(store.pendingReceipts()).toEqual([]);
  });
});
