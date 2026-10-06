import { describe, expect, it } from "vitest";
import { blankCandidate } from "./candidate.js";
import { renderOperatorSummary } from "./summary.js";

const SHA_A = "a".repeat(40);
const TREE = "c".repeat(40);

describe("renderOperatorSummary", () => {
  it("names the candidate for merge-ready and not-worth-merging", () => {
    const candidate = blankCandidate({
      repositoryId: "repo-a",
      pr: 9,
      headSha: SHA_A,
      baseSha: SHA_A,
      treeHash: TREE,
    });
    const ready = renderOperatorSummary({ ...candidate, state: "merge-ready" });
    expect(ready.text).toContain("repo-a");
    expect(ready.text).toContain(SHA_A);
    expect(ready.text).toContain(TREE);
    const rejected = renderOperatorSummary({ ...candidate, state: "not-worth-merging" });
    expect(rejected.text).toContain("not worth merging");
  });

  it("does not call a blocked review merge-ready", () => {
    const text = renderOperatorSummary({
      ...blankCandidate({
        repositoryId: "repo-a",
        pr: 1,
        headSha: SHA_A,
        baseSha: SHA_A,
        treeHash: TREE,
      }),
      state: "blocked",
      blockReason: "missing a failure case",
    }).text;
    expect(text).toContain("missing evidence");
    expect(text).not.toContain("merge-ready");
  });

  it("marks a summary stale when the head moves", () => {
    const rendered = renderOperatorSummary({
      ...blankCandidate({
        repositoryId: "repo-a",
        pr: 1,
        headSha: SHA_A,
        baseSha: SHA_A,
        treeHash: TREE,
      }),
      state: "merge-ready",
      summaryId: "sum-1",
    });
    expect(
      renderOperatorSummary(
        { ...rendered.candidate, id: { ...rendered.candidate.id, headSha: "d".repeat(40) } },
        "sum-1",
      ).stale,
    ).toBe(true);
  });
});
