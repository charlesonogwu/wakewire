import { describe, expect, it } from "vitest";
import { type ApiContext, createApi } from "./api.js";

describe("coordination completion status", () => {
  it("requires the management token and exposes only bounded job metadata", async () => {
    const app = createApi({
      config: { apiToken: "test-token" },
      adapter: {
        coordinationJobs: () => [
          {
            id: "job-1",
            number: 7,
            headSha: "a".repeat(40),
            action: "fix",
            state: "pending",
            acceptedWakes: 2,
            createdAt: "2026-09-21T00:00:00Z",
            updatedAt: "2026-09-21T00:05:00Z",
            reason: "Codex task busy",
          },
        ],
      },
    } as unknown as ApiContext);
    const unauthorized = await app.request("/api/coordination/jobs");
    expect(unauthorized.status).toBe(401);
    const authorized = await app.request("/api/coordination/jobs", {
      headers: { authorization: "Bearer test-token" },
    });
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as { jobs: Record<string, unknown>[] };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({ number: 7, state: "pending", acceptedWakes: 2 });
    expect(JSON.stringify(body)).not.toMatch(/firstPrompt|threadId|comment|secret|token/);
  });
});
