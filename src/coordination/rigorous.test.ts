import { describe, expect, it } from "vitest";
import real from "./fixtures/pr130.json" with { type: "json" };
import { type CoordinationSnapshot, evaluateCoordination, type ReviewComment } from "./policy.js";

const sha = "b607e0741fa409d1f65477268c36d47265cd1732";
const config = {
  expectedRepository: "charlesonogwu/lash-luxe-nyc",
  localAgent: "codex" as const,
  trustedAuthorIds: { codex: ["217436545"], hermes: ["217436545"] },
  waitingLabel: "waiting:charles",
};
function snapshot(comments: ReviewComment[], owner = "codex"): CoordinationSnapshot {
  return {
    number: 130,
    repository: config.expectedRepository,
    state: "open",
    headSha: sha,
    headRepository: config.expectedRepository,
    body: `<!-- agent-handoff:v1\norigin: ${owner}\nowner: ${owner}\nreviewer: ${owner === "codex" ? "hermes" : "codex"}\nimpacts: website\n-->`,
    labels: [`agent:${owner}`],
    checks: "success",
    comments,
  };
}
function record(marker: string, fields: string, n: number): ReviewComment {
  return {
    id: 6053004300 + n,
    authorId: "217436545",
    updatedAt: `2026-10-08T06:00:${String(n).padStart(2, "0")}Z`,
    body: `<!-- ${marker}\npr: 130\nhead-sha: ${sha}\n${fields}\nsummary: Fixture inspected.\n-->`,
  };
}
const evidence = real.find((c) => c.body.includes("agent-owner-evidence:v1"));
const route = real.find((c) => c.body.includes("agent-routing:v2"));
if (!evidence || !route) throw new Error("Missing real fixtures");
const challenge = record(
  "agent-challenge:v1",
  "reviewer: hermes\nchallenge-id: c1\nfindings-json: []",
  1,
);
const response = record(
  "agent-response:v1",
  "owner: codex\nchallenge-id: c1\nresponses-json: []",
  2,
);
const verdict = record(
  "agent-review:v2",
  "reviewer: hermes\nchallenge-id: c1\ndecision: approve",
  3,
);
const verification = record("agent-owner-verification:v1", "owner: codex\nverification-id: v1", 4);
describe("rigorous routing from real GitHub record shapes", () => {
  it("routes real evidence:owner handoff without needing an at-mention", () => {
    const current = {
      ...route,
      body: route.body
        .replaceAll("5be55f39486b5527672fe795e9e91f6264b607f0", sha)
        .replace("@codex", "Codex (T3)"),
    };
    expect(evaluateCoordination(snapshot([current]), config).action).toBe("evidence:owner");
  });
  it("ignores the actual old-head route", () => {
    expect(evaluateCoordination(snapshot([route]), config).action).toBe("wait");
  });
  it("derives owner response and verification, then waits for Charles", () => {
    expect(evaluateCoordination(snapshot([evidence]), config).action).toBe("wait");
    expect(evaluateCoordination(snapshot([evidence, challenge]), config).action).toBe(
      "response:owner",
    );
    expect(evaluateCoordination(snapshot([evidence, challenge, response]), config).action).toBe(
      "wait",
    );
    expect(
      evaluateCoordination(snapshot([evidence, challenge, response, verdict]), config).action,
    ).toBe("verification:owner");
    expect(
      evaluateCoordination(snapshot([evidence, challenge, response, verdict, verification]), config)
        .stage,
    ).toBe("waiting:charles");
  });
  it("wakes codex reviewer for challenge and verdict on Hermes-owned PRs", () => {
    const swap = (c: ReviewComment) => ({
      ...c,
      body: c.body
        .replaceAll("owner: codex", "owner: hermes")
        .replaceAll("reviewer: hermes", "reviewer: codex"),
    });
    expect(evaluateCoordination(snapshot([swap(evidence)], "hermes"), config).action).toBe(
      "challenge:peer",
    );
    expect(
      evaluateCoordination(snapshot([evidence, challenge, response].map(swap), "hermes"), config)
        .action,
    ).toBe("verdict:peer");
  });
  it("rejects untrusted, wrong PR, duplicate, malformed and stale evidence", () => {
    expect(evaluateCoordination(snapshot([{ ...evidence, authorId: "999" }]), config).action).toBe(
      "wait",
    );
    for (const bad of [
      { ...evidence, body: evidence.body.replace("pr: 130", "pr: 131") },
      { ...evidence, body: evidence.body.replace("owner: codex", "owner: codex\nowner: codex") },
      { ...evidence, id: 0 },
    ])
      expect(evaluateCoordination(snapshot([bad]), config).action).toBe("blocked");
    expect(evaluateCoordination(snapshot([evidence, evidence]), config).action).toBe("blocked");
    expect(
      evaluateCoordination(
        snapshot([{ ...evidence, body: evidence.body.replaceAll(sha, "a".repeat(40)) }]),
        config,
      ).action,
    ).toBe("wait");
  });
  it("rejects role mismatch and missing or extra response findings", () => {
    const challenged = {
      ...challenge,
      body: challenge.body.replace(
        "findings-json: []",
        'findings-json: [{"id":"f1","severity":"important","component":"copy","evidence":"problem","request":"answer"}]',
      ),
    };
    expect(evaluateCoordination(snapshot([evidence, challenged, response]), config).action).toBe(
      "response:owner",
    );
    expect(
      evaluateCoordination(
        snapshot([
          evidence,
          { ...challenge, body: challenge.body.replace("reviewer: hermes", "reviewer: codex") },
        ]),
        config,
      ).action,
    ).toBe("blocked");
  });
});

it("accepts the unchanged real owner route only at its recorded head", () => {
  const old = snapshot([route]);
  old.headSha = "5be55f39486b5527672fe795e9e91f6264b607f0";
  expect(evaluateCoordination(old, config).action).toBe("evidence:owner");
});
it("keeps revise cycles tied to the active challenge and requires a new response", () => {
  const revise = {
    ...verdict,
    body: verdict.body.replace("decision: approve", "decision: revise"),
  };
  expect(
    evaluateCoordination(snapshot([evidence, challenge, response, revise]), config).action,
  ).toBe("response:owner");
  const nextResponse = { ...response, id: response.id + 100, updatedAt: "2026-10-08T06:00:05Z" };
  expect(
    evaluateCoordination(snapshot([evidence, challenge, response, revise, nextResponse]), config)
      .action,
  ).toBe("wait");
  const unrelated = {
    ...verdict,
    body: verdict.body.replace("challenge-id: c1", "challenge-id: other"),
  };
  expect(
    evaluateCoordination(snapshot([evidence, challenge, response, unrelated]), config).stage,
  ).toBe("verdict:peer");
});
it("manual block, wrong actor trust, fork and closed PR remain gated", () => {
  const ready = snapshot([evidence, challenge, response, verdict]);
  expect(
    evaluateCoordination({ ...ready, labels: ["agent:codex", "blocked:coordination"] }, config)
      .action,
  ).toBe("blocked");
  expect(evaluateCoordination({ ...ready, headRepository: "foreign/project" }, config).action).toBe(
    "blocked",
  );
  expect(evaluateCoordination({ ...ready, state: "closed" }, config).action).toBe("ignore");
  const split = { ...config, trustedAuthorIds: { codex: ["217436545"], hermes: ["222"] } };
  expect(evaluateCoordination(ready, split).stage).toBe("challenge:peer");
});
