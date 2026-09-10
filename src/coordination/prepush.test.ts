import { describe, expect, it } from "vitest";
import {
  type CoordinationConfig,
  type CoordinationSnapshot,
  evaluateCoordination,
} from "./policy.js";
import { selectPrepushRequest as selectPrepush } from "./prepush.js";

const head = "a".repeat(40);
const candidate = "b".repeat(40);
const digest = "c".repeat(64);
const config: CoordinationConfig = {
  expectedRepository: "example/project",
  localAgent: "codex",
  trustedAuthorIds: { codex: ["101"], hermes: ["202"] },
  waitingLabel: "waiting:operator",
  prepushEnabled: true,
};
const body = `<!-- agent-prepush:v1\nowner: hermes\nbranch: hermes/example\nexpected-head: ${head}\ncandidate-sha: ${candidate}\nbundle-sha256: ${digest}\n-->`;
const request = (id = 1, text = body, updatedAt = "2026-09-10T10:00:00Z") => ({
  id,
  body: text,
  updatedAt,
  authorId: "202",
});
function snapshot(): CoordinationSnapshot {
  return {
    repository: "example/project",
    headRepository: "example/project",
    state: "open",
    headSha: head,
    headBranch: "hermes/example",
    checks: "pending",
    labels: ["agent:hermes"],
    body: "<!-- agent-handoff:v1\norigin: hermes\nowner: hermes\nreviewer: codex\nimpacts: website\n-->",
    comments: [request()],
  };
}

describe("trusted candidate selection", () => {
  const revision = () => ({
    ...request(
      2,
      `<!-- agent-review:v1\nreviewer: codex\ndecision: revise\nhead-sha: ${head}\n-->`,
      "2026-09-10T09:00:00Z",
    ),
    authorId: "101",
  });
  const correction = () => ({
    ...snapshot(),
    labels: ["agent:hermes", "changes-requested:hermes"],
    comments: [revision(), request(3)],
  });
  it("selects a fresh correction while preserving the rejected head and labels", () => {
    const s = correction();
    const before = structuredClone(s);
    expect(selectPrepush(s, config)?.candidateSha).toBe(candidate);
    expect(s).toEqual(before);
    expect(evaluateCoordination(s, config).action).toBe("wait");
    expect(evaluateCoordination(s, { ...config, localAgent: "hermes" }).action).toBe("fix");
  });
  it.each([
    "blocked:coordination",
    "blocked:manual",
    "waiting:operator",
    "review:codex",
    "approved:codex",
    "changes-requested:codex",
  ])("correction never bypasses %s", (label) => {
    const s = correction();
    s.labels.push(label);
    expect(selectPrepush(s, config)).toBeNull();
  });
  it.each(["approve", "reject"])("requires revise, not %s", (verdict) => {
    const s = correction();
    s.comments[0] = {
      ...revision(),
      body: revision().body.replace("decision: revise", `decision: ${verdict}`),
    };
    expect(selectPrepush(s, config)).toBeNull();
  });
  it("rejects untrusted, stale and malformed review evidence", () => {
    for (const change of [
      { authorId: "999" },
      { body: revision().body.replace(head, "e".repeat(40)) },
      { body: "agent-review malformed" },
    ]) {
      const s = correction();
      s.comments[0] = { ...revision(), ...change };
      expect(selectPrepush(s, config)).toBeNull();
    }
  });
  it("does not revive a candidate submitted before the latest review", () => {
    const s = correction();
    s.comments[0] = { ...revision(), updatedAt: "2026-09-10T11:00:00Z" };
    expect(selectPrepush(s, config)).toBeNull();
  });
  it("selects exact immutable facts without changing ordinary policy", () => {
    const s = snapshot();
    const before = structuredClone(s);
    expect(evaluateCoordination(s, config).action).toBe("wait");
    expect(selectPrepush(s, config)).toEqual({
      branch: "hermes/example",
      expectedHead: head,
      candidateSha: candidate,
      bundleSha256: digest,
    });
    expect(s).toEqual(before);
    expect(evaluateCoordination(s, config).action).toBe("wait");
  });
  it.each([false, undefined])("requires explicit opt-in %s", (prepushEnabled) => {
    const settings = { ...config };
    delete settings.prepushEnabled;
    if (prepushEnabled !== undefined) settings.prepushEnabled = prepushEnabled;
    expect(selectPrepush(snapshot(), settings)).toBeNull();
  });
  it("requires local Codex", () => {
    expect(selectPrepush(snapshot(), { ...config, localAgent: "hermes" })).toBeNull();
  });
  it.each([
    { state: "closed" as const },
    { repository: "foreign/project" },
    { headRepository: "fork/project" },
    { headBranch: "hermes/other" },
    { headSha: null },
    { body: "bad handoff" },
    { labels: ["agent:codex"] },
  ])("rejects ineligible snapshot %j", (change) => {
    expect(selectPrepush({ ...snapshot(), ...change }, config)).toBeNull();
  });
  it("requires headBranch readback", () => {
    const s = snapshot();
    delete s.headBranch;
    expect(selectPrepush(s, config)).toBeNull();
  });
  it.each([
    "review:codex",
    "changes-requested:hermes",
    "approved:hermes",
    "waiting:operator",
    "blocked:coordination",
    "blocked:manual",
    "waiting:other",
  ])("never bypasses %s", (label) => {
    expect(selectPrepush({ ...snapshot(), labels: ["agent:hermes", label] }, config)).toBeNull();
  });
  it.each([
    body + body,
    body.replace("-->", "owner: hermes\n-->"),
    body.replace("-->", "command: test\n-->"),
    body.replace("owner: hermes\n", ""),
    body.replace("v1", "v2"),
    body.replace("-->", ""),
    body.replace("owner: hermes", "owner: codex"),
    body.replace(candidate, head),
    body.replace(candidate, "B".repeat(40)),
    body.replace(head, "a".repeat(39)),
    body.replace(digest, "c".repeat(63)),
    body.replace(digest, "C".repeat(64)),
    "<!-- agent-prepush:v1 withdrawn -->",
    `agent-prepush\n${body}`,
  ])("fails closed on malformed trusted request %s", (text) => {
    expect(
      selectPrepush({ ...snapshot(), comments: [request(), request(2, text)] }, config),
    ).toBeNull();
  });
  it.each([
    "main",
    "hermes/",
    "hermes/../x",
    "hermes/a..b",
    "hermes/a.lock",
    "hermes/.hidden",
    "hermes/a/",
    "hermes//a",
    "hermes/a@{b",
    "hermes/a b",
    "hermes/a;command",
    "hermes/a\\b",
    "hermes/a.",
    `hermes/${"a".repeat(250)}`,
  ])("rejects unsafe branch %s even when current branch matches", (branch) => {
    expect(
      selectPrepush(
        {
          ...snapshot(),
          headBranch: branch,
          comments: [request(1, body.replace("hermes/example", branch))],
        },
        config,
      ),
    ).toBeNull();
  });
  it("ignores all untrusted evidence including invalid ordering and malformed envelopes", () => {
    const forged = { ...request(NaN, "agent-prepush malformed", "bad"), authorId: "999" };
    expect(
      selectPrepush({ ...snapshot(), comments: [request(), forged] }, config)?.candidateSha,
    ).toBe(candidate);
    expect(
      selectPrepush({ ...snapshot(), comments: [{ ...request(), authorId: "101" }] }, config),
    ).toBeNull();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
    "fails closed on invalid trusted ID %s",
    (id) => {
      expect(
        selectPrepush({ ...snapshot(), comments: [request(), request(id)] }, config),
      ).toBeNull();
    },
  );
  it("fails closed on invalid time or duplicate ID even in stale requests", () => {
    for (const comment of [request(2, body, "bad"), request(1, body.replace(head, "d".repeat(40)))])
      expect(selectPrepush({ ...snapshot(), comments: [request(), comment] }, config)).toBeNull();
  });
  it("selects by updatedAt before numeric ID, independent of array order", () => {
    const newer = request(2, body.replace(candidate, "d".repeat(40)), "2026-09-10T11:00:00Z");
    for (const comments of [
      [request(99), newer],
      [newer, request(99)],
    ])
      expect(selectPrepush({ ...snapshot(), comments }, config)?.candidateSha).toBe("d".repeat(40));
  });
  it("breaks time ties numerically and never falls back after stale or same-candidate requests", () => {
    for (const text of [body.replace(head, "d".repeat(40)), body.replace(candidate, head)])
      expect(
        selectPrepush({ ...snapshot(), comments: [request(10, text), request(9)] }, config),
      ).toBeNull();
    expect(
      selectPrepush(
        {
          ...snapshot(),
          comments: [request(9), request(10, body.replace(candidate, "d".repeat(40)))],
        },
        config,
      )?.candidateSha,
    ).toBe("d".repeat(40));
  });
});
