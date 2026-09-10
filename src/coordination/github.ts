import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { CoordinationSnapshot, ReviewComment } from "./policy.js";

export const RepositorySchema = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => ![".", ".."].includes(value.split("/")[1] ?? ""));
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const PositiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Repository = z.object({ full_name: RepositorySchema });
const Pull = z.object({
  number: PositiveId,
  state: z.enum(["open", "closed"]),
  body: z.string().nullable(),
  labels: z.array(z.object({ name: z.string() })),
  head: z.object({ sha: Sha, ref: z.string().optional(), repo: Repository.nullable() }),
  base: z.object({ repo: Repository }),
});
const Comment = z.object({
  id: PositiveId,
  user: z.object({ id: PositiveId }),
  body: z.string(),
  updated_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});
const Status = z.object({
  sha: Sha,
  state: z.string(),
  total_count: Count,
  statuses: z.array(z.object({ state: z.string() })),
});
const Check = z.object({
  id: PositiveId,
  head_sha: Sha,
  status: z.string(),
  conclusion: z.string().nullable(),
});
const CheckPage = z.object({ total_count: Count, check_runs: z.array(Check).max(100) });
const run = promisify(execFile);
export type GithubGetTransport = (path: string) => Promise<unknown>;

/** Only fixed, validated GET endpoints ever reach this process boundary. */
const ghGet: GithubGetTransport = async (path) => {
  const { stdout } = await run("gh", ["api", "--method", "GET", path], {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  return JSON.parse(stdout);
};

function pullIdentity(pr: z.infer<typeof Pull>) {
  return JSON.stringify([
    pr.number,
    pr.state,
    pr.body,
    pr.head.sha,
    pr.head.ref,
    pr.head.repo?.full_name,
    pr.base.repo.full_name,
    pr.labels.map((label) => label.name).sort(),
  ]);
}

export class GithubSnapshotClient {
  private readonly repository: string;
  constructor(
    repository: string,
    private readonly transport: GithubGetTransport = ghGet,
  ) {
    this.repository = RepositorySchema.parse(repository);
  }
  private get(endpoint: string) {
    return this.transport(`repos/${this.repository}/${endpoint}`);
  }
  async findPullRequestsForCommit(sha: string): Promise<number[]> {
    Sha.parse(sha);
    const candidates: number[] = [];
    const seen = new Set<number>();
    const matches = (pr: z.infer<typeof Pull>) =>
      pr.state === "open" &&
      pr.head.sha === sha &&
      pr.head.repo?.full_name === this.repository &&
      pr.base.repo.full_name === this.repository;
    // Finish pagination before yielding any work: errors cannot silently
    // produce a partial first-PR-only result. Association data is not authority.
    for (let page = 1; ; page++) {
      if (page > 100) throw new Error("GitHub commit association page limit exceeded");
      const batch = z
        .array(Pull)
        .max(100)
        .parse(await this.get(`commits/${sha}/pulls?per_page=100&page=${page}`));
      for (const pr of batch) {
        if (seen.has(pr.number)) throw new Error("Duplicate commit PR association");
        seen.add(pr.number);
        if (matches(pr)) candidates.push(pr.number);
      }
      if (batch.length < 100) break;
    }
    const result: number[] = [];
    for (const number of candidates.sort((a, b) => a - b)) {
      const current = Pull.parse(await this.get(`pulls/${number}`));
      if (current.number !== number) throw new Error("GitHub PR identity mismatch");
      if (matches(current)) result.push(number);
    }
    return result;
  }
  async read(number: number): Promise<CoordinationSnapshot> {
    PositiveId.parse(number);
    const pr = Pull.parse(await this.get(`pulls/${number}`));
    if (pr.number !== number || pr.base.repo.full_name !== this.repository)
      throw new Error("GitHub PR identity mismatch");
    const sha = pr.head.sha;
    const comments: ReviewComment[] = [];
    const commentIds = new Set<number>();
    for (let page = 1; ; page++) {
      if (page > 100) throw new Error("GitHub comment page limit exceeded");
      const batch = z
        .array(Comment)
        .max(100)
        .parse(await this.get(`issues/${number}/comments?per_page=100&page=${page}`));
      for (const comment of batch) {
        if (commentIds.has(comment.id)) throw new Error("Duplicate comment across pages");
        commentIds.add(comment.id);
        comments.push({
          id: comment.id,
          authorId: String(comment.user.id),
          body: comment.body,
          updatedAt: comment.updated_at,
        });
      }
      if (batch.length < 100) break;
    }
    const status = Status.parse(await this.get(`commits/${sha}/status`));
    if (status.sha !== sha || status.total_count !== status.statuses.length)
      throw new Error("Incomplete or mismatched GitHub status evidence");
    const checks: z.infer<typeof Check>[] = [];
    const checkIds = new Set<number>();
    let total: number | undefined;
    for (let page = 1; ; page++) {
      if (page > 100) throw new Error("GitHub check page limit exceeded");
      const batch = CheckPage.parse(
        await this.get(`commits/${sha}/check-runs?per_page=100&page=${page}`),
      );
      if (total !== undefined && total !== batch.total_count)
        throw new Error("Check count changed during pagination");
      total = batch.total_count;
      for (const check of batch.check_runs) {
        if (check.head_sha !== sha || checkIds.has(check.id))
          throw new Error("Mismatched or duplicate check evidence");
        checkIds.add(check.id);
        checks.push(check);
      }
      if (checks.length === total) break;
      if (checks.length > total || batch.check_runs.length < 100)
        throw new Error("Incomplete GitHub check evidence");
    }
    const states: CoordinationSnapshot["checks"][] = [];
    const statusState = (state: string): CoordinationSnapshot["checks"] =>
      state === "success"
        ? "success"
        : ["failure", "error"].includes(state)
          ? "failure"
          : "pending";
    // An empty combined-status response is normally pending. It must not veto
    // successful check-runs, but an unknown aggregate state still fails closed.
    if (status.total_count > 0 || !["pending", "success"].includes(status.state))
      states.push(statusState(status.state));
    states.push(...status.statuses.map((item) => statusState(item.state)));
    for (const check of checks) {
      const knownStatuses = [
        "queued",
        "in_progress",
        "completed",
        "waiting",
        "requested",
        "pending",
      ];
      const knownConclusions = [
        null,
        "success",
        "failure",
        "neutral",
        "cancelled",
        "skipped",
        "timed_out",
        "action_required",
        "stale",
        "startup_failure",
      ];
      if (!knownStatuses.includes(check.status) || !knownConclusions.includes(check.conclusion))
        states.push("pending");
      else if (check.status !== "completed") states.push("pending");
      else if (check.conclusion === "success") states.push("success");
      else if (
        [
          "failure",
          "cancelled",
          "timed_out",
          "action_required",
          "stale",
          "startup_failure",
        ].includes(check.conclusion ?? "")
      )
        states.push("failure");
      else states.push("pending");
    }
    const aggregate = states.includes("failure")
      ? "failure"
      : states.length > 0 && states.every((state) => state === "success")
        ? "success"
        : "pending";
    // This is the final awaited operation: stale snapshots are rejected and the
    // queue's next attempt must collect the entire snapshot again.
    const current = Pull.parse(await this.get(`pulls/${number}`));
    if (pullIdentity(current) !== pullIdentity(pr))
      throw new Error("GitHub PR changed during snapshot collection");
    return {
      repository: this.repository,
      state: pr.state,
      headSha: sha,
      ...(pr.head.ref === undefined ? {} : { headBranch: pr.head.ref }),
      headRepository: pr.head.repo?.full_name ?? "",
      body: pr.body ?? "",
      labels: pr.labels.map((label) => label.name),
      comments,
      checks: aggregate,
    };
  }
}
