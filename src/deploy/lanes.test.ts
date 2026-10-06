import { generateKeyPairSync, sign } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./crypto.js";
import { createLaneRouter } from "./lanes.js";
import type { EngineeringOwnerRecord, LaneRecord } from "./types.js";

function lane(id: string, root: string, thread: string): LaneRecord {
  return {
    laneId: id,
    repositoryId: `repo-${id}`,
    github: { owner: "example", name: id },
    roots: {
      checkout: path.join(root, id, "checkout"),
      worktree: path.join(root, id, "worktree"),
      cache: path.join(root, id, "cache"),
    },
    threads: {
      author: { projectId: `${id}-author-project`, threadId: `${thread}-author` },
      reviewer: { projectId: `${id}-review-project`, threadId: `${thread}-review` },
    },
    adapterPath: path.join(root, id, "adapter.json"),
  };
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function signedOwner(overrides: Partial<EngineeringOwnerRecord> = {}): EngineeringOwnerRecord {
  const body = {
    repositoryId: "repo-lane-a",
    owner: "legacy" as const,
    phase: "stable" as const,
    generation: 1,
    deploymentActivationEnabled: false,
    updatedAt: "2026-10-06T00:00:00.000Z",
    ...overrides,
  };
  const signature = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString("base64url");
  return { ...body, signature };
}

describe("lane routing", () => {
  it("routes simultaneous repositories without context bleed", () => {
    const lanes = [lane("lane-a", "/srv/lanes", "a"), lane("lane-b", "/srv/lanes", "b")];
    const router = createLaneRouter(lanes, signedOwner(), publicKey);
    expect(router.route({ repositoryId: "repo-lane-a", deliveryId: "d1" }).laneId).toBe("lane-a");
    expect(router.route({ repositoryId: "repo-lane-b", deliveryId: "d2" }).laneId).toBe("lane-b");
    expect(router.route({ repositoryId: "repo-lane-a", deliveryId: "d1" }).laneId).toBe("lane-a");
  });

  it("rejects a stale local owner flag", () => {
    const router = createLaneRouter(
      [lane("lane-a", "/srv/lanes", "a")],
      signedOwner({ generation: 4 }),
      publicKey,
    );
    expect(() => router.admit({ repositoryId: "repo-lane-a" }, 3)).toThrow(/owner generation/);
  });

  it("admits no new work while draining", () => {
    const router = createLaneRouter(
      [lane("lane-a", "/srv/lanes", "a")],
      signedOwner({ phase: "draining", generation: 2 }),
      publicKey,
    );
    expect(() => router.admit({ repositoryId: "repo-lane-a" }, 2)).toThrow(/draining/);
  });
});
