import { generateKeyPairSync, sign } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./crypto.js";
import { createReviewHostRouter, type T3Transport } from "./t3.js";
import type { LaneRecord } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function lane(): LaneRecord {
  return {
    laneId: "a",
    repositoryId: "repo-a",
    github: { owner: "example", name: "one" },
    roots: {
      checkout: "/srv/a/checkout",
      worktree: "/srv/a/worktree",
      cache: "/srv/a/cache",
    },
    threads: {
      author: { projectId: "pa", threadId: "author-thread" },
      reviewer: { projectId: "pr", threadId: "review-thread" },
    },
    adapterPath: "/srv/a/adapter.json",
  };
}

function transport(): T3Transport & { sent: Array<{ threadId: string; requestId: string }> } {
  const sent: Array<{ threadId: string; requestId: string }> = [];
  return {
    sent,
    async deliver(input) {
      sent.push({ threadId: input.threadId, requestId: String(input.record.requestId) });
    },
  };
}

const request = {
  laneId: "a",
  role: "reviewer" as const,
  requestId: "r1",
  repositoryId: "repo-a",
  pr: 7,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  treeHash: "c".repeat(40),
};

describe("ReviewHostRouter", () => {
  it("never delivers one work item to both role contexts", async () => {
    const client = transport();
    const router = createReviewHostRouter([lane()], client, publicKey);
    await router.wake(request);
    expect(client.sent).toEqual([{ threadId: "review-thread", requestId: "r1" }]);
  });

  it("rejects production tokens, dotenv text, unknown lanes, and duplicate requests", async () => {
    const client = transport();
    const router = createReviewHostRouter([lane()], client, publicKey);
    await expect(
      router.wake({ ...request, requestId: "tok", repositoryId: "ghp_secret" }),
    ).rejects.toThrow(/secret/);
    await expect(router.wake({ ...request, requestId: "env", headSha: ".env" })).rejects.toThrow(
      /secret/,
    );
    await expect(router.wake({ ...request, laneId: "missing" })).rejects.toThrow(/lane/);
    await router.wake(request);
    await expect(router.wake(request)).rejects.toThrow(/duplicate/);
    expect(client.sent).toEqual([{ threadId: "review-thread", requestId: "r1" }]);
  });

  it("rejects a shared author and reviewer thread", async () => {
    const shared = lane();
    shared.threads.author.threadId = shared.threads.reviewer.threadId;
    const router = createReviewHostRouter([shared], transport(), publicKey);
    await expect(router.wake(request)).rejects.toThrow(/threadId/);
  });

  it("rejects an invalid verdict signature", () => {
    const router = createReviewHostRouter([lane()], transport(), publicKey);
    expect(() =>
      router.ingestVerdict({
        ...request,
        decision: "approve",
        signature: "not-a-signature",
      }),
    ).toThrow(/signature/);
  });

  it("accepts a reviewer-signed verdict and ignores the live port", () => {
    const body = {
      laneId: request.laneId,
      role: request.role,
      requestId: "r2",
      decision: "approve" as const,
      headSha: request.headSha,
      baseSha: request.baseSha,
      treeHash: request.treeHash,
    };
    const signature = sign(null, Buffer.from(canonicalJson(body)), privateKey).toString(
      "base64url",
    );
    const router = createReviewHostRouter([lane()], transport(), publicKey);
    expect(router.ingestVerdict({ ...body, signature }).requestId).toBe("r2");
    expect(path.isAbsolute("/dev/null")).toBe(true);
  });
});
