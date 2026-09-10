import { describe, expect, it } from "vitest";
import { type Route, RouteInputSchema } from "../../core/route.js";
import { matchRoutes } from "../../core/router.js";
import { trimGithubEvent } from "./trim.js";

const marker = "<!-- handoff: implementer -> reviewer -->";
function payload() {
  return {
    action: "created",
    repository: { full_name: "acme/api", private: true },
    sender: { id: 123, login: "trusted", email: "private@example.invalid" },
    issue: { number: 42, user: { id: 999 }, pull_request: {} },
    comment: {
      id: 456,
      user: { id: 123, login: "trusted" },
      body: `${marker}\nReview this commit.`,
      html_url: "https://github.com/acme/api/issues/42#issuecomment-456",
    },
  };
}
function route(): Route {
  const parsed = RouteInputSchema.parse({
    name: "trusted handoffs",
    source: "github",
    match: {
      repo: "acme/api",
      events: ["issue_comment.created"],
      senderIds: ["123"],
      commentAuthorIds: ["123"],
      commentMarker: marker,
    },
    target: { type: "thread", threadId: "synthetic-thread" },
  });
  return {
    ...parsed,
    id: "route-1",
    promptTemplate: null,
    rateLimitPerMinute: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
}
function matches(raw: Record<string, unknown>, eventName = "issue_comment") {
  const event = trimGithubEvent({ eventName, deliveryId: "delivery-1", payload: raw });
  return event ? matchRoutes([route()], event).length : 0;
}

describe("trusted GitHub comment handoffs", () => {
  it("preserves configured trust filters and accepts a complete trusted handoff", () => {
    expect(route().match).toMatchObject({
      senderIds: ["123"],
      commentAuthorIds: ["123"],
      commentMarker: marker,
    });
    expect(matches(payload())).toBe(1);
  });
  it("rejects an untrusted sender even with copied trusted login and marker", () => {
    const raw = payload();
    raw.sender.id = 999;
    expect(matches(raw)).toBe(0);
  });
  it("rejects a trusted editor of an untrusted comment", () => {
    const raw = payload();
    raw.comment.user.id = 999;
    expect(matches(raw)).toBe(0);
  });
  it("rejects missing sender or comment author", () => {
    expect(matches({ ...payload(), sender: undefined })).toBe(0);
    expect(matches({ ...payload(), comment: { ...payload().comment, user: undefined } })).toBe(0);
  });
  it("requires a standalone marker, not a substring", () => {
    const raw = payload();
    raw.comment.body = `quoted ${marker}`;
    expect(matches(raw)).toBe(0);
  });
  it("rejects unrelated events and repositories", () => {
    expect(matches(payload(), "issues")).toBe(0);
    expect(matches({ ...payload(), repository: { full_name: "other/api" } })).toBe(0);
  });
  it("keeps only bounded comment metadata and does not use issue author as commenter", () => {
    const raw = payload();
    raw.comment.body = "x".repeat(9000);
    const event = trimGithubEvent({ eventName: "issue_comment", deliveryId: "d", payload: raw });
    expect(event?.payload).toMatchObject({
      senderId: "123",
      commentAuthorId: "123",
      commentId: "456",
      number: 42,
      isPullRequest: true,
    });
    expect(String(event?.payload.commentBody).length).toBeLessThanOrEqual(4030);
    expect(JSON.stringify(event)).not.toContain("private@example.invalid");
  });
  it("rejects malformed identity filters instead of silently weakening them", () => {
    const input = { name: "bad", source: "github", target: { type: "thread", threadId: "t" } };
    for (const value of [[], [""], ["123x"], ["0"]]) {
      expect(
        RouteInputSchema.safeParse({ ...input, match: { repo: "acme/api", senderIds: value } })
          .success,
      ).toBe(false);
    }
  });
});
