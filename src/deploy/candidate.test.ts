import { describe, expect, it } from "vitest";
import { advanceCandidate, blankCandidate } from "./candidate.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TREE = "c".repeat(40);

function ready() {
  let state = blankCandidate({
    repositoryId: "repo-a",
    pr: 7,
    headSha: SHA_A,
    baseSha: SHA_A,
    treeHash: TREE,
  });
  state = advanceCandidate(state, { type: "evidence" });
  state = advanceCandidate(state, { type: "checks", checks: "success" });
  state = advanceCandidate(state, {
    type: "verdict",
    verdict: {
      role: "author",
      decision: "approve",
      headSha: SHA_A,
      baseSha: SHA_A,
      treeHash: TREE,
    },
  });
  return advanceCandidate(state, {
    type: "verdict",
    verdict: {
      role: "reviewer",
      decision: "approve",
      headSha: SHA_A,
      baseSha: SHA_A,
      treeHash: TREE,
    },
  });
}

describe("advanceCandidate", () => {
  it("invalidates approval when the base moves", () => {
    const next = advanceCandidate(ready(), { type: "base-changed", baseSha: SHA_B });
    expect(next.state).toBe("invalidated");
    expect(next.verdicts).toEqual([]);
  });

  it("lets a draft enter challenge but not readiness", () => {
    const draft = {
      ...blankCandidate({
        repositoryId: "repo-a",
        pr: 1,
        headSha: SHA_A,
        baseSha: SHA_A,
        treeHash: TREE,
      }),
      draft: true,
    };
    const challenged = advanceCandidate(draft, { type: "evidence" });
    expect(challenged.state).toBe("challenging");
    const approved = advanceCandidate(
      advanceCandidate(challenged, { type: "checks", checks: "success" }),
      {
        type: "verdict",
        verdict: {
          role: "reviewer",
          decision: "approve",
          headSha: SHA_A,
          baseSha: SHA_A,
          treeHash: TREE,
        },
      },
    );
    expect(approved.state).not.toBe("merge-ready");
  });

  it("blocks on unresolved findings, cancelled checks, and unknown outcomes", () => {
    const base = blankCandidate({
      repositoryId: "repo-a",
      pr: 2,
      headSha: SHA_A,
      baseSha: SHA_A,
      treeHash: TREE,
    });
    expect(advanceCandidate(base, { type: "findings", count: 2 }).state).toBe("blocked");
    expect(advanceCandidate(base, { type: "checks", checks: "cancelled" }).state).toBe("blocked");
    expect(advanceCandidate(base, { type: "unknown" }).state).toBe("blocked");
    expect(advanceCandidate(base, { type: "timeout" }).state).toBe("blocked");
  });

  it("does not promote blocked or not-worth-merging without a new head", () => {
    const blocked = advanceCandidate(
      blankCandidate({
        repositoryId: "repo-a",
        pr: 3,
        headSha: SHA_A,
        baseSha: SHA_A,
        treeHash: TREE,
      }),
      { type: "blocked", reason: "needs a failure case" },
    );
    expect(advanceCandidate(blocked, { type: "checks", checks: "success" }).state).toBe("blocked");
    const rejected = advanceCandidate(blocked, {
      type: "not-worth-merging",
      reason: "not worth it",
    });
    expect(rejected.state).toBe("not-worth-merging");
    expect(advanceCandidate(rejected, { type: "head-changed", headSha: SHA_B }).state).toBe(
      "invalidated",
    );
  });
});
