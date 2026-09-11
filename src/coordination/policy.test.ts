import { describe, expect, it } from "vitest";
import {
  type CoordinationConfig,
  type CoordinationSnapshot,
  evaluateCoordination,
  type ReviewComment,
} from "./policy.js";

const sha = "a".repeat(40);
const config: CoordinationConfig = {
  expectedRepository: "example/project",
  localAgent: "codex",
  trustedAuthorIds: { codex: ["101"], hermes: ["202"] },
  waitingLabel: "waiting:peer",
};
const handoff =
  "<!-- agent-handoff:v1\norigin: codex\nowner: codex\nreviewer: hermes\nimpacts: website,pi\n-->";
function snapshot(overrides: Partial<CoordinationSnapshot> = {}): CoordinationSnapshot {
  return {
    repository: "example/project",
    state: "open",
    headSha: sha,
    headRepository: "example/project",
    body: handoff,
    labels: ["agent:codex"],
    checks: "success",
    comments: [],
    ...overrides,
  };
}
function vote(
  reviewer: "codex" | "hermes",
  decision = "approve",
  overrides: Partial<ReviewComment> = {},
): ReviewComment {
  return {
    authorId: reviewer === "codex" ? "101" : "202",
    id: reviewer === "codex" ? 1 : 2,
    updatedAt: "2026-09-10T10:00:00Z",
    body: `<!-- agent-review:v1\nreviewer: ${reviewer}\ndecision: ${decision}\nhead-sha: ${sha}\n-->`,
    ...overrides,
  };
}
const approvals = () => [vote("codex"), vote("hermes")];
describe("pure dual-review policy", () => {
  it.each([
    "Our docs specify agent-review:v1 verdicts. This is only a summary.",
    "The `agent-review:v1` protocol is documented elsewhere.",
    "agent-review:v1 verdicts are already posted; this is only a summary.",
  ])("ignores prose mention without hiding real decisions: %s", (body) => {
    const summary = vote("hermes", "approve", { id: 3, body });
    expect(
      evaluateCoordination(snapshot({ comments: [...approvals(), summary] }), config).action,
    ).toBe("ready");
    expect(evaluateCoordination(snapshot({ comments: [summary] }), config).action).toBe("wait");
    expect(
      evaluateCoordination(snapshot({ comments: [vote("hermes", "reject"), summary] }), config)
        .action,
    ).toBe("blocked");
  });
  it("allows prose alongside one actual review declaration", () => {
    const peer = vote("hermes");
    peer.body += "\nagent-review:v1 is the protocol used above.";
    expect(evaluateCoordination(snapshot({ comments: [vote("codex"), peer] }), config).action).toBe(
      "ready",
    );
  });
  it("accepts agent:hermes ownership with both current approvals", () => {
    expect(
      evaluateCoordination(
        snapshot({
          body: "<!-- agent-handoff:v1\norigin: hermes\nowner: hermes\nreviewer: codex\nimpacts: website\n-->",
          labels: ["agent:hermes", "impact:website"],
          comments: approvals(),
        }),
        config,
      ).action,
    ).toBe("ready");
  });
  it("blocks conflicting agent and legacy owner labels despite both approvals", () => {
    expect(
      evaluateCoordination(
        snapshot({
          labels: ["agent:codex", "owner:hermes"],
          comments: approvals(),
        }),
        config,
      ).action,
    ).toBe("blocked");
  });
  it.each([
    { labels: ["agent:hermes", "impact:website"], action: "wait" },
    { labels: ["agent:hermes", "impact:website", "review:codex"], action: "review" },
  ])("accepts live-shaped synthetic agent ownership labels: $action", ({ labels, action }) => {
    const input = snapshot({
      body: "<!-- agent-handoff:v1\norigin: hermes\nowner: hermes\nreviewer: codex\nimpacts: website\n-->",
      labels,
    });
    expect(evaluateCoordination(input, config)).toMatchObject({ action, owner: "hermes" });
  });
  it.each([{ state: "closed" as const }, { repository: "other/project" }])(
    "ignores out-of-scope PRs %j",
    (input) => {
      expect(evaluateCoordination(snapshot(input), config).action).toBe("ignore");
    },
  );
  it("waits without peer approval, even with successful tests", () => {
    for (const comments of [[], [vote("codex")]]) {
      expect(evaluateCoordination(snapshot({ comments }), config).action).toBe("wait");
    }
  });
  it.each(["success", "pending", "failure"] as const)(
    "requests owner verification, never readiness, after peer approval with %s checks",
    (checks) => {
      const input = snapshot({ checks, comments: [vote("hermes")] });
      expect(evaluateCoordination(input, config)).toMatchObject({
        action: "verify",
        owner: "codex",
        headSha: sha,
      });
      expect(evaluateCoordination(input, config).action).not.toBe("ready");
      expect(evaluateCoordination(input, { ...config, localAgent: "hermes" }).action).toBe("wait");
    },
  );
  it("requires owner re-verification when only its old-head approval exists", () => {
    expect(
      evaluateCoordination(
        snapshot({
          comments: [
            vote("hermes"),
            vote("codex", "approve", { body: vote("codex").body.replace(sha, "b".repeat(40)) }),
          ],
        }),
        config,
      ).action,
    ).toBe("verify");
  });
  it("does not request verification over manual blocks or current rejection", () => {
    expect(
      evaluateCoordination(
        snapshot({ labels: ["agent:codex", "blocked:coordination"], comments: [vote("hermes")] }),
        config,
      ).action,
    ).toBe("blocked");
    expect(
      evaluateCoordination(
        snapshot({ comments: [vote("hermes"), vote("codex", "reject")] }),
        config,
      ).action,
    ).toBe("blocked");
    expect(
      evaluateCoordination(snapshot({ comments: [vote("hermes", "revise")] }), config).action,
    ).toBe("wait");
  });
  it("returns ready and stable context for two current approvals", () => {
    expect(evaluateCoordination(snapshot({ comments: approvals() }), config)).toMatchObject({
      action: "ready",
      owner: "codex",
      headSha: sha,
      reason: expect.any(String),
    });
  });
  it.each(["pending", "failure"] as const)("waits on %s checks despite approvals", (checks) => {
    expect(evaluateCoordination(snapshot({ comments: approvals(), checks }), config).action).toBe(
      "wait",
    );
  });
  it("ignores stale and forged votes", () => {
    for (const peer of [
      vote("hermes", "approve", { authorId: "999" }),
      vote("hermes", "approve", { authorId: "101" }),
      vote("hermes", "approve", { body: vote("hermes").body.replace(sha, "b".repeat(40)) }),
    ]) {
      expect(
        evaluateCoordination(snapshot({ comments: [vote("codex"), peer] }), config).action,
      ).toBe("wait");
    }
  });
  it("allows shared trusted accounts only through logical reviewer markers", () => {
    expect(
      evaluateCoordination(
        snapshot({ comments: [vote("codex"), vote("hermes", "approve", { authorId: "101" })] }),
        { ...config, trustedAuthorIds: { codex: ["101"], hermes: ["101"] } },
      ).action,
    ).toBe("ready");
  });
  it("fixes a newer peer revision only for the local owner with matching label", () => {
    const input = snapshot({
      labels: ["agent:codex", "changes-requested:codex"],
      comments: [
        ...approvals(),
        vote("hermes", "revise", { id: 3, updatedAt: "2026-09-10T11:00:00Z" }),
      ],
    });
    expect(evaluateCoordination(input, config).action).toBe("fix");
    expect(evaluateCoordination(input, { ...config, localAgent: "hermes" }).action).toBe("wait");
    expect(evaluateCoordination({ ...input, labels: ["agent:codex"] }, config).action).toBe("wait");
  });
  it("orders same-SHA votes by time then numeric comment ID, not array order", () => {
    const negative = vote("hermes", "reject", { id: 10 });
    for (const comments of [
      [negative, ...approvals()],
      [...approvals(), negative],
    ]) {
      expect(evaluateCoordination(snapshot({ comments }), config).action).toBe("blocked");
    }
    expect(
      evaluateCoordination(
        snapshot({
          comments: [
            negative,
            vote("codex"),
            vote("hermes", "approve", { id: 3, updatedAt: "2026-09-10T11:00:00Z" }),
          ],
        }),
        config,
      ).action,
    ).toBe("ready");
  });
  it("reviews only when local agent is the designated non-owner", () => {
    const input = snapshot({ labels: ["agent:codex", "review:hermes"] });
    expect(evaluateCoordination(input, config).action).toBe("wait");
    expect(evaluateCoordination(input, { ...config, localAgent: "hermes" }).action).toBe("review");
  });
  it.each([null, "", "abc", "z".repeat(40)])("blocks invalid head %s", (headSha) => {
    expect(evaluateCoordination(snapshot({ headSha }), config).action).toBe("blocked");
  });
  it("blocks a fork head", () => {
    expect(evaluateCoordination(snapshot({ headRepository: "fork/project" }), config).action).toBe(
      "blocked",
    );
  });
  it.each([
    "",
    handoff + handoff,
    handoff.replace("owner: codex", "owner: hermes"),
    handoff.replace("reviewer: hermes", "reviewer: codex"),
    handoff.replace("website,pi", ""),
    handoff.replace("website,pi", "unknown"),
    handoff.replace("origin: codex", "origin: codex\norigin: codex"),
    handoff.replace("-->", ""),
    handoff.replace("v1", "v2"),
  ])("blocks invalid handoff %s", (body) => {
    expect(evaluateCoordination(snapshot({ body }), config).action).toBe("blocked");
  });
  it.each([
    [],
    ["agent:hermes"],
    ["agent:codex", "agent:hermes"],
    ["agent:codex", "review:unknown"],
    ["agent:codex", "review:codex"],
    ["agent:codex", "changes-requested:hermes"],
    ["agent:codex", "review:hermes", "waiting:peer"],
    ["agent:codex", "approved:codex", "approved:hermes"],
    ["agent:codex", "approved:unknown"],
    ["agent:codex", "blocked:coordination"],
  ])("blocks contradictory labels %j", (...labels) => {
    expect(evaluateCoordination(snapshot({ labels, comments: approvals() }), config).action).toBe(
      "blocked",
    );
  });
  it("blocks approval labels that contradict votes", () => {
    expect(
      evaluateCoordination(
        snapshot({
          labels: ["agent:codex", "approved:hermes"],
          comments: [vote("hermes", "revise")],
        }),
        config,
      ).action,
    ).toBe("blocked");
  });
  it("accepts unrelated labels and configured waiting label", () => {
    expect(
      evaluateCoordination(snapshot({ labels: ["agent:codex", "waiting:custom", "bug"] }), {
        ...config,
        waitingLabel: "waiting:custom",
      }).action,
    ).toBe("wait");
  });
  it.each([
    "<!-- agent-review:v1 -->",
    vote("hermes").body.replace("approve", "maybe"),
    vote("hermes").body.replace(sha, "abc"),
    vote("hermes").body + vote("hermes").body,
    vote("hermes").body.replace("-->", ""),
    vote("hermes").body.replace("v1", "v2"),
  ])("fails closed for malformed trusted reviews %s", (body) => {
    expect(
      evaluateCoordination(snapshot({ comments: [vote("hermes", "approve", { body })] }), config)
        .action,
    ).toBe("blocked");
    expect(
      evaluateCoordination(
        snapshot({ comments: [vote("hermes", "approve", { body, authorId: "999" })] }),
        config,
      ).action,
    ).toBe("wait");
  });
  it("blocks invalid trusted ordering evidence", () => {
    for (const overrides of [{ updatedAt: "bad" }, { id: NaN }]) {
      expect(
        evaluateCoordination(snapshot({ comments: [vote("hermes", "approve", overrides)] }), config)
          .action,
      ).toBe("blocked");
    }
  });
  it("does not mutate its inputs", () => {
    const input = snapshot({ comments: approvals().reverse() });
    const before = JSON.stringify(input);
    evaluateCoordination(input, config);
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(["success", "pending", "failure"] as const)(
    "blocks a change-request label contradicting a current peer approval with %s checks",
    (checks) => {
      expect(
        evaluateCoordination(
          snapshot({
            checks,
            labels: ["agent:codex", "changes-requested:codex"],
            comments: [vote("hermes")],
          }),
          config,
        ).action,
      ).toBe("blocked");
    },
  );
  it("handles Hermes ownership symmetrically", () => {
    const input = snapshot({
      body: handoff
        .replaceAll("codex", "TEMP")
        .replaceAll("hermes", "codex")
        .replaceAll("TEMP", "hermes"),
      labels: ["agent:hermes", "changes-requested:hermes"],
      comments: [vote("codex", "revise")],
    });
    expect(evaluateCoordination(input, { ...config, localAgent: "hermes" }).action).toBe("fix");
    expect(
      evaluateCoordination(
        { ...input, labels: ["agent:hermes", "review:codex"], comments: [] },
        config,
      ).action,
    ).toBe("review");
  });
  it("ignores a stale rejection and ordinary trusted prose", () => {
    expect(
      evaluateCoordination(
        snapshot({
          comments: [
            ...approvals(),
            vote("hermes", "reject", {
              id: 3,
              body: vote("hermes", "reject").body.replace(sha, "b".repeat(40)),
            }),
            vote("codex", "approve", { id: 4, body: "Checks passed; this is not an approval." }),
          ],
        }),
        config,
      ).action,
    ).toBe("ready");
  });
  it("blocks duplicate immutable comment IDs instead of depending on array order", () => {
    expect(
      evaluateCoordination(
        snapshot({ comments: [...approvals(), vote("hermes", "reject")] }),
        config,
      ).action,
    ).toBe("blocked");
  });
});
