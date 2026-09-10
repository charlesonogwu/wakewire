import { describe, expect, it } from "vitest";
import { GithubSnapshotClient } from "./github.js";

const sha = "a".repeat(40);
function fixture() {
  const pr = {
    number: 7,
    state: "open",
    body: "handoff",
    labels: [{ name: "agent:codex" }],
    head: { sha, repo: { full_name: "example/project" } },
    base: { repo: { full_name: "example/project" } },
  };
  const data: Record<string, unknown> = {
    "pulls/7": pr,
    "issues/7/comments?per_page=100&page=1": [],
    [`commits/${sha}/status`]: { sha, state: "pending", total_count: 0, statuses: [] },
    [`commits/${sha}/check-runs?per_page=100&page=1`]: { total_count: 0, check_runs: [] },
  };
  const paths: string[] = [];
  const transport = async (url: string) => {
    paths.push(url);
    expect(url.startsWith("repos/example/project/")).toBe(true);
    const key = url.slice("repos/example/project/".length);
    if (!(key in data)) throw new Error(`Unexpected path ${url}`);
    return structuredClone(data[key]);
  };
  return {
    pr,
    data,
    paths,
    transport,
    client: new GithubSnapshotClient("example/project", transport),
  };
}
const comment = (id: number) => ({
  id,
  user: { id: 202 },
  body: "review",
  updated_at: "2026-09-10T10:00:00Z",
});
const check = (id: number, conclusion = "success", status = "completed") => ({
  id,
  head_sha: sha,
  status,
  conclusion,
});

describe("fresh GitHub snapshot", () => {
  it("reads optional head.ref while preserving snapshots without it", async () => {
    const f = fixture();
    expect(await f.client.read(7)).not.toHaveProperty("headBranch");
    f.data["pulls/7"] = { ...f.pr, head: { ...f.pr.head, ref: "hermes/example" } };
    expect(await f.client.read(7)).toMatchObject({ headBranch: "hermes/example" });
  });
  it("rejects a branch-only race during snapshot collection", async () => {
    const f = fixture();
    let reads = 0;
    const client = new GithubSnapshotClient("example/project", async (url) => {
      const raw = await f.transport(url);
      if (url.endsWith("pulls/7"))
        return {
          ...f.pr,
          head: { ...f.pr.head, ref: ++reads === 1 ? "hermes/example" : "hermes/other" },
        };
      return raw;
    });
    await expect(client.read(7)).rejects.toThrow(/changed/i);
  });
  it("resolves every exact open commit association in numeric order after current-PR validation", async () => {
    const f = fixture();
    f.data[`commits/${sha}/pulls?per_page=100&page=1`] = [
      { ...f.pr, number: 12 },
      f.pr,
      { ...f.pr, number: 9, state: "closed" },
      { ...f.pr, number: 10, head: { ...f.pr.head, sha: "b".repeat(40) } },
      { ...f.pr, number: 11, head: { ...f.pr.head, repo: { full_name: "fork/project" } } },
      { ...f.pr, number: 13, base: { repo: { full_name: "foreign/project" } } },
    ];
    f.data["pulls/12"] = { ...f.pr, number: 12 };
    expect(await f.client.findPullRequestsForCommit(sha)).toEqual([7, 12]);
    expect(f.paths.slice(1)).toEqual([
      "repos/example/project/pulls/7",
      "repos/example/project/pulls/12",
    ]);
  });
  it.each(["closed", "stale", "fork", "base"])(
    "ignores an association that is now %s",
    async (change) => {
      const f = fixture();
      f.data[`commits/${sha}/pulls?per_page=100&page=1`] = [structuredClone(f.pr)];
      f.data["pulls/7"] = {
        ...f.pr,
        ...(change === "closed" ? { state: "closed" } : {}),
        ...(change === "stale" ? { head: { ...f.pr.head, sha: "b".repeat(40) } } : {}),
        ...(change === "fork"
          ? { head: { ...f.pr.head, repo: { full_name: "fork/project" } } }
          : {}),
        ...(change === "base" ? { base: { repo: { full_name: "foreign/project" } } } : {}),
      };
      expect(await f.client.findPullRequestsForCommit(sha)).toEqual([]);
    },
  );
  it("reads all commit association pages before returning any matches", async () => {
    const f = fixture();
    f.data[`commits/${sha}/pulls?per_page=100&page=1`] = Array.from({ length: 100 }, (_, i) => ({
      ...f.pr,
      number: i + 20,
      state: "closed",
    }));
    f.data[`commits/${sha}/pulls?per_page=100&page=2`] = [f.pr];
    expect(await f.client.findPullRequestsForCommit(sha)).toEqual([7]);
    expect(f.paths).toContain(`repos/example/project/commits/${sha}/pulls?per_page=100&page=2`);
  });
  it.each(["", "ABC", "A".repeat(40), "a".repeat(41), "../x", `${"a".repeat(40)}\n`])(
    "rejects malformed commit SHA before transport: %s",
    async (value) => {
      const f = fixture();
      await expect(f.client.findPullRequestsForCommit(value)).rejects.toThrow();
      expect(f.paths).toEqual([]);
    },
  );
  it.each([{ number: 7 }, { number: 0 }, { state: "unknown" }, { head: { sha } }])(
    "fails closed on malformed association shapes: %j",
    async (invalid) => {
      const f = fixture();
      f.data[`commits/${sha}/pulls?per_page=100&page=1`] = [invalid];
      await expect(f.client.findPullRequestsForCommit(sha)).rejects.toThrow();
    },
  );
  it("rejects duplicate PR association identities", async () => {
    const f = fixture();
    f.data[`commits/${sha}/pulls?per_page=100&page=1`] = [f.pr, f.pr];
    await expect(f.client.findPullRequestsForCommit(sha)).rejects.toThrow(/duplicate/i);
  });
  it("caps endless commit association pagination without partial results", async () => {
    const f = fixture();
    let pages = 0;
    const client = new GithubSnapshotClient("example/project", async () => {
      pages++;
      return Array.from({ length: 100 }, (_, i) => ({
        ...f.pr,
        number: (pages - 1) * 100 + i + 1,
      }));
    });
    await expect(client.findPullRequestsForCommit(sha)).rejects.toThrow(/page.*limit/i);
    expect(pages).toBe(100);
  });
  it("never treats zero evidence as success and re-reads the PR last", async () => {
    const f = fixture();
    expect(await f.client.read(7)).toMatchObject({
      checks: "pending",
      headSha: sha,
      repository: "example/project",
    });
    expect(f.paths.at(-1)).toBe("repos/example/project/pulls/7");
    expect(f.paths.filter((p) => p.endsWith("pulls/7"))).toHaveLength(2);
  });
  it.each([
    { state: "success", statuses: ["success"], checks: [], want: "success" },
    { state: "success", statuses: ["success"], checks: ["success"], want: "success" },
    { state: "pending", statuses: [], checks: ["success"], want: "success" },
    { state: "success", statuses: [], checks: [], want: "pending" },
    { state: "pending", statuses: ["pending"], checks: ["success"], want: "pending" },
    { state: "failure", statuses: ["failure"], checks: ["success"], want: "failure" },
    { state: "success", statuses: ["success"], checks: ["failure"], want: "failure" },
    { state: "future", statuses: [], checks: ["success"], want: "pending" },
    { state: "success", statuses: ["future"], checks: ["success"], want: "pending" },
    { state: "pending", statuses: [], checks: ["neutral"], want: "pending" },
    { state: "pending", statuses: [], checks: ["future"], want: "pending" },
  ])(
    "aggregates statuses and check runs conservatively: %j",
    async ({ state, statuses, checks, want }) => {
      const f = fixture();
      f.data[`commits/${sha}/status`] = {
        sha,
        state,
        total_count: statuses.length,
        statuses: statuses.map((state) => ({ state, context: "Vercel" })),
      };
      f.data[`commits/${sha}/check-runs?per_page=100&page=1`] = {
        total_count: checks.length,
        check_runs: checks.map((state, i) => check(i + 1, state)),
      };
      expect((await f.client.read(7)).checks).toBe(want);
    },
  );
  it("requires known completed check states", async () => {
    const f = fixture();
    f.data[`commits/${sha}/check-runs?per_page=100&page=1`] = {
      total_count: 1,
      check_runs: [check(1, "success", "future")],
    };
    expect((await f.client.read(7)).checks).toBe("pending");
  });
  it("reads all comment and check pages, preserving author and ordering evidence", async () => {
    const f = fixture();
    f.data["issues/7/comments?per_page=100&page=1"] = Array.from({ length: 100 }, (_, i) =>
      comment(i + 1),
    );
    f.data["issues/7/comments?per_page=100&page=2"] = [comment(101)];
    f.data[`commits/${sha}/check-runs?per_page=100&page=1`] = {
      total_count: 101,
      check_runs: Array.from({ length: 100 }, (_, i) => check(i + 1)),
    };
    f.data[`commits/${sha}/check-runs?per_page=100&page=2`] = {
      total_count: 101,
      check_runs: [check(101, "failure")],
    };
    const result = await f.client.read(7);
    expect(result.comments).toHaveLength(101);
    expect(result.comments.at(-1)).toEqual({
      id: 101,
      authorId: "202",
      body: "review",
      updatedAt: "2026-09-10T10:00:00Z",
    });
    expect(result.checks).toBe("failure");
  });
  it.each([0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, NaN])(
    "rejects invalid PR number %s before transport",
    async (number) => {
      const f = fixture();
      await expect(f.client.read(number)).rejects.toThrow();
      expect(f.paths).toEqual([]);
    },
  );
  it.each(["../project", "example/../x", "--help", "a/b?x", "a/b/c", "a/..", "a/b\n"])(
    "rejects unsafe repo %s",
    (repo) => {
      expect(() => new GithubSnapshotClient(repo, async () => null)).toThrow();
    },
  );
  it.each(["head", "body", "labels", "state"])(
    "rejects concurrent PR %s changes",
    async (field) => {
      const f = fixture();
      let reads = 0;
      const client = new GithubSnapshotClient("example/project", async (url) => {
        const result = await f.transport(url);
        if (url.endsWith("pulls/7") && ++reads === 2) {
          return {
            ...f.pr,
            [field]:
              field === "head"
                ? { ...f.pr.head, sha: "b".repeat(40) }
                : field === "labels"
                  ? [{ name: "blocked:coordination" }]
                  : "closed",
          };
        }
        return result;
      });
      await expect(client.read(7)).rejects.toThrow(/changed/i);
    },
  );
  it.each([
    ["pulls/7", { number: 7 }],
    [
      `commits/${sha}/status`,
      { sha: "b".repeat(40), state: "success", statuses: [], total_count: 0 },
    ],
    [
      `commits/${sha}/status`,
      { sha, state: "success", statuses: [{ state: "success" }], total_count: 2 },
    ],
    [
      `commits/${sha}/check-runs?per_page=100&page=1`,
      { total_count: 1, check_runs: [{ ...check(1), head_sha: "b".repeat(40) }] },
    ],
    ["issues/7/comments?per_page=100&page=1", [{ ...comment(1), user: null }]],
    [`commits/${sha}/check-runs?per_page=100&page=1`, { total_count: 2, check_runs: [check(1)] }],
  ])("rejects malformed or incomplete response at %s", async (key, value) => {
    const f = fixture();
    f.data[key as string] = value;
    await expect(f.client.read(7)).rejects.toThrow();
  });
  it.each(["comments", "check-runs"])("caps endless %s pagination", async (endpoint) => {
    const f = fixture();
    let pages = 0;
    const client = new GithubSnapshotClient("example/project", async (url) => {
      if (url.includes(`${endpoint}?`)) {
        pages++;
        const items = Array.from({ length: 100 }, (_, i) =>
          endpoint === "comments"
            ? comment((pages - 1) * 100 + i + 1)
            : check((pages - 1) * 100 + i + 1),
        );
        return endpoint === "comments" ? items : { total_count: 100000, check_runs: items };
      }
      return f.transport(url);
    });
    await expect(client.read(7)).rejects.toThrow(/page|limit/i);
    expect(pages).toBeGreaterThanOrEqual(10);
    expect(pages).toBeLessThanOrEqual(100);
  });
});
