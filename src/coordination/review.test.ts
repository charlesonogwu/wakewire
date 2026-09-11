import { describe, expect, it } from "vitest";
import { parseReview } from "./review.js";

const valid = `<!-- agent-review:v1\nreviewer: hermes\ndecision: approve\nhead-sha: ${"a".repeat(40)}\n-->`;
describe("explicit review declarations", () => {
  it.each([
    "Summary: agent-review:v1 was used.",
    "See `agent-review:v1`.",
    "agent-review:v1 verdicts are already posted; this is only a summary.",
    "<!-- Documentation mentions agent-review:v1 here. -->",
  ])("ignores ordinary discussion %s", (body) => {
    expect(parseReview(body)).toEqual({ kind: "absent" });
  });
  it.each([
    "<!-- agent-review:v1 -->",
    "<!-- agent-review:v1",
    "agent-review:v1",
    `${valid}${valid}`,
    `${valid}\n<!-- agent-review:v1`,
    valid.replace("v1", "v2"),
    valid.replace("approve", "maybe"),
    valid.replace("reviewer: hermes\n", ""),
    valid.replace("-->", "decision: reject\n-->"),
    valid.replace("-->", "extra: value\n-->"),
    valid.replace("a".repeat(40), "A".repeat(40)),
  ])("fails closed on explicit malformed declaration %s", (body) => {
    expect(parseReview(body)).toEqual({ kind: "invalid" });
  });
  it("supports one declaration with prose mentions before and after", () => {
    expect(
      parseReview(`Uses agent-review:v1.\n${valid}\nagent-review:v1 is the protocol used above.`),
    ).toEqual({ kind: "review", reviewer: "hermes", decision: "approve", headSha: "a".repeat(40) });
  });
});
