import { describe, expect, it } from "vitest";
import type { FreshMerge } from "./reconcile.js";
import { scanMerge } from "./reconcile.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TREE = "c".repeat(40);

function merge(overrides: Partial<FreshMerge> = {}): FreshMerge {
  return {
    deliveryId: "delivery-1",
    repositoryId: "repo-a",
    kind: "pull_request_merged",
    mergedBy: "charles",
    expectedOperator: "charles",
    pr: 7,
    headSha: SHA_A,
    reviewedHeadSha: SHA_A,
    baseSha: SHA_A,
    reviewedBaseSha: SHA_A,
    treeHash: TREE,
    reviewedTreeHash: TREE,
    mergeSha: SHA_B,
    newerReleaseActivated: false,
    authorApproved: true,
    reviewerApproved: true,
    checks: "success",
    ...overrides,
  };
}

describe("scanMerge", () => {
  it("refuses a direct push, actor mismatch, head or base drift, and tree mismatch", () => {
    expect(scanMerge(merge({ kind: "push", pr: null })).kind).toBe("refuse");
    expect(scanMerge(merge({ mergedBy: "other" })).notice).toMatch(/operator/);
    expect(scanMerge(merge({ headSha: SHA_B })).kind).toBe("refuse");
    expect(scanMerge(merge({ baseSha: SHA_B })).kind).toBe("refuse");
    expect(scanMerge(merge({ treeHash: SHA_B })).kind).toBe("refuse");
  });

  it("creates one intent for a missed or duplicate webhook and suppresses an older release", () => {
    const seen = new Map();
    const first = scanMerge(merge(), seen);
    const second = scanMerge(merge(), seen);
    expect(first.kind).toBe("intent");
    expect(second).toEqual(first);
    expect(scanMerge(merge({ deliveryId: "old", newerReleaseActivated: true }), seen).kind).toBe(
      "refuse",
    );
  });
});
