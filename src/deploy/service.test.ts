import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import DatabaseConstructor from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../db/migrations.js";
import { canonicalJson } from "./crypto.js";
import type { GenesisAdapterRecord } from "./genesis.js";
import { openDeployJournal } from "./journal.js";
import type { FreshMerge } from "./reconcile.js";
import { createDeploymentService } from "./service.js";
import type { EngineeringOwnerRecord } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function signed<T extends object>(body: T): T & { signature: string } {
  return {
    ...body,
    signature: sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url"),
  };
}

function database() {
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
  return { db, journal };
}

function genesis(repositoryId = "repo-a"): GenesisAdapterRecord {
  return signed({
    repositoryId,
    adapterVersion: "1",
    adapterDigest: "d".repeat(64),
    mergeSha: "a".repeat(40),
    treeHash: "b".repeat(40),
    mergeEventId: "adapter-merge",
    targetGeneration: 2,
  });
}

function enabledOwner(): EngineeringOwnerRecord {
  return signed({
    repositoryId: "repo-a",
    owner: "omarchy" as const,
    phase: "stable" as const,
    generation: 2,
    deploymentActivationEnabled: true,
    updatedAt: "2026-10-06T00:00:00.000Z",
  });
}

function merged(deliveryId = "m1"): FreshMerge {
  return {
    deliveryId,
    repositoryId: "repo-a",
    kind: "pull_request_merged",
    mergedBy: "operator",
    expectedOperator: "operator",
    pr: 7,
    headSha: "a".repeat(40),
    reviewedHeadSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    reviewedBaseSha: "b".repeat(40),
    treeHash: "c".repeat(40),
    reviewedTreeHash: "c".repeat(40),
    mergeSha: "d".repeat(40),
    newerReleaseActivated: false,
    authorApproved: true,
    reviewerApproved: true,
    checks: "success",
  };
}

describe("DeploymentService", () => {
  it("stores a signed receipt while activation is off and deploys once from a fresh scan", () => {
    const { db, journal } = database();
    let scans = 0;
    let executions = 0;
    const seen: string[] = [];
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal,
      freshMerges: () => {
        scans += 1;
        seen.push("fresh");
        return [merged()];
      },
      execute: () => {
        executions += 1;
        return { status: "deployed" };
      },
    });
    const receipt = signed({
      deliveryId: "stored-merge",
      repositoryId: "repo-a",
      kind: "merge" as const,
      eventId: "event-1",
      mergeSha: "f".repeat(40),
    });
    service.intake(receipt);
    service.intake(receipt);
    expect(db.prepare("SELECT COUNT(*) AS count FROM deploy_raw_receipts").get()).toEqual({
      count: 1,
    });
    expect(journal.intentId("stored-merge")).toBeNull();
    expect(journal.intentId("m1")).toBeNull();
    expect(journal.pause("repo-a")).toBeNull();
    expect(service.tick("repo-a")).toEqual({ decisions: 0, executions: 0 });
    expect(scans).toBe(0);
    expect(executions).toBe(0);
    service.bootstrap({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: enabledOwner(),
      genesis: genesis(),
      keyId: "pinned-key",
      rollback: false,
    });
    expect(() =>
      service.bootstrap({
        repositoryId: "repo-a",
        expectedGeneration: 2,
        next: enabledOwner(),
        genesis: genesis(),
        keyId: "pinned-key",
        rollback: false,
      }),
    ).toThrow(/reused genesis|draining/);
    expect(service.tick("repo-a")).toEqual({ decisions: 1, executions: 1 });
    expect(journal.intentId("m1")).toBe("intent-m1");
    expect(journal.intentId("stored-merge")).toBeNull();
    expect(seen).toEqual(["fresh"]);
    expect(service.tick("repo-a")).toEqual({ decisions: 0, executions: 0 });
    expect(executions).toBe(1);
  });

  it("trusts a fresh refusal over a stored merge receipt", () => {
    const { journal } = database();
    let executions = 0;
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal,
      freshMerges: () => [{ ...merged("push-1"), kind: "push", pr: null, mergedBy: "someone" }],
      execute: () => {
        executions += 1;
        return { status: "deployed" };
      },
    });
    journal.beginDrain("repo-a", 1);
    journal.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: enabledOwner(),
      genesis: genesis(),
      keyId: "pinned-key",
      rollback: false,
    });
    service.intake(
      signed({
        deliveryId: "stored-merge",
        repositoryId: "repo-a",
        kind: "merge" as const,
        eventId: "event-1",
        mergeSha: "f".repeat(40),
      }),
    );
    expect(service.tick("repo-a")).toEqual({ decisions: 1, executions: 0 });
    expect(executions).toBe(0);
    expect(journal.intentId("push-1")).toBeNull();
    expect(journal.pause("repo-a")?.repairId).toBe("repair-push-1");
  });

  it("refuses work for a stale generation, a drain, or the wrong host", () => {
    const { journal } = database();
    let scans = 0;
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal,
      freshMerges: () => {
        scans += 1;
        return [merged()];
      },
      execute: () => ({ status: "deployed" }),
    });
    expect(() =>
      service.bootstrap({
        repositoryId: "repo-a",
        expectedGeneration: 99,
        next: enabledOwner(),
        genesis: genesis(),
        keyId: "pinned-key",
        rollback: false,
      }),
    ).toThrow(/generation/);
    service.bootstrap({
      repositoryId: "repo-a",
      expectedGeneration: 1,
      next: enabledOwner(),
      genesis: genesis(),
      keyId: "pinned-key",
      rollback: false,
    });
    journal.beginDrain("repo-a", 2);
    expect(service.tick("repo-a")).toEqual({ decisions: 0, executions: 0 });
    const wrongHost = createDeploymentService({
      host: "legacy",
      publicKey,
      journal,
      freshMerges: () => {
        scans += 1;
        return [merged()];
      },
      execute: () => ({ status: "deployed" }),
    });
    journal.completeOwnerChange({
      repositoryId: "repo-a",
      expectedGeneration: 2,
      next: signed({
        repositoryId: "repo-a",
        owner: "omarchy" as const,
        phase: "stable" as const,
        generation: 3,
        deploymentActivationEnabled: true,
        updatedAt: "2026-10-06T00:00:00.000Z",
      }),
      genesis: null,
      keyId: "pinned-key",
      rollback: false,
    });
    expect(wrongHost.tick("repo-a")).toEqual({ decisions: 0, executions: 0 });
    expect(scans).toBe(0);
  });

  it("rejects an unsigned event and keeps review receipts off the merge cursor", () => {
    const { db, journal } = database();
    const service = createDeploymentService({
      host: "omarchy",
      publicKey,
      journal,
      freshMerges: () => [],
      execute: () => ({ status: "pending" }),
    });
    expect(() =>
      service.intake({
        deliveryId: "bad",
        repositoryId: "repo-a",
        kind: "review",
        eventId: "review-1",
        signature: "invalid",
      }),
    ).toThrow(/signature/);
    service.intake(
      signed({
        deliveryId: "review-1",
        repositoryId: "repo-a",
        kind: "review" as const,
        eventId: "review-1",
      }),
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM deploy_merges").get()).toEqual({
      count: 0,
    });
    expect(journal.cursor("repo-a")).toBe(0);
  });

  it("does not let the daemon scan or activate deployments", () => {
    const daemon = readFileSync(new URL("../daemon/daemon.ts", import.meta.url), "utf8");
    expect(daemon).not.toContain("createDeploymentService");
    expect(daemon).not.toContain("executeRelease");
    expect(daemon).not.toContain("scanMerge");
  });
});
