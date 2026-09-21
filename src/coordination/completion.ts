import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { AgentAdapter } from "../sinks/types.js";
import { BusyError, PermanentError, UnreachableError } from "../sinks/types.js";
import type { CoordinationConfig, CoordinationSnapshot } from "./policy.js";
import { evaluateCoordination } from "./policy.js";
import { parseReview } from "./review.js";

type Action = "fix" | "review" | "verify";
type JobState = "pending" | "complete" | "superseded" | "needs-attention";
export interface CompletionJobInput {
  repository: string;
  number: number;
  headSha: string;
  action: Action;
  threadId: string;
  firstPrompt: string;
  firstDeliveryId: string;
  baselineVote: string | null;
}
export interface CompletionJobStatus {
  id: string;
  number: number;
  headSha: string;
  action: Action;
  state: JobState;
  acceptedWakes: number;
  createdAt: string;
  updatedAt: string;
  reason: string | null;
}
type Row = {
  id: string;
  repository: string;
  number: number;
  head_sha: string;
  action: Action;
  thread_id: string;
  first_prompt: string;
  first_delivery_id: string;
  state: JobState;
  accepted_wakes: number;
  next_check_at: string;
  created_at: string;
  updated_at: string;
  reason: string | null;
  attention_sent: number;
  read_failures: number;
  baseline_vote: string | null;
  inactive_checks: number;
};
type SnapshotReader = Pick<import("./github.js").GithubSnapshotClient, "read">;

const sha = /^[a-f0-9]{40}$/;
const keyFor = (job: CompletionJobInput) =>
  createHash("sha256")
    .update(JSON.stringify([job.repository, job.number, job.headSha, job.action]))
    .digest("hex");

export function latestTrustedVote(snapshot: CoordinationSnapshot, config: CoordinationConfig) {
  const latest: { time: number; id: number; decision: string; ordering: string }[] = [];
  for (const comment of snapshot.comments) {
    if (!config.trustedAuthorIds.codex.includes(comment.authorId)) continue;
    const review = parseReview(comment.body);
    if (
      review.kind !== "review" ||
      review.reviewer !== "codex" ||
      review.headSha !== snapshot.headSha
    )
      continue;
    const time = Date.parse(comment.updatedAt);
    if (Number.isFinite(time) && Number.isSafeInteger(comment.id) && comment.id > 0)
      latest.push({
        time,
        id: comment.id,
        decision: review.decision,
        ordering: JSON.stringify([time, comment.id]),
      });
  }
  latest.sort((a, b) => b.time - a.time || b.id - a.id);
  return latest[0];
}

/** A Desktop receipt is only acceptance. This journal tracks the GitHub result. */
export class CoordinationCompletionMonitor {
  private readonly db: Database.Database;
  private readonly checkDelayMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private tickPromise: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      dbFile: string;
      config: CoordinationConfig;
      snapshots: SnapshotReader;
      inner: AgentAdapter;
      now?: () => Date;
      checkDelayMs?: number;
      intervalMs?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.checkDelayMs = options.checkDelayMs ?? 5 * 60_000;
    this.db = new Database(options.dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS coordination_jobs (
      id TEXT PRIMARY KEY, repository TEXT NOT NULL, number INTEGER NOT NULL,
      head_sha TEXT NOT NULL, action TEXT NOT NULL, thread_id TEXT NOT NULL,
      first_prompt TEXT NOT NULL, first_delivery_id TEXT NOT NULL,
      state TEXT NOT NULL, accepted_wakes INTEGER NOT NULL DEFAULT 0,
      next_check_at TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, reason TEXT,
      attention_sent INTEGER NOT NULL DEFAULT 0,
      read_failures INTEGER NOT NULL DEFAULT 0,
      baseline_vote TEXT,
      inactive_checks INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS coordination_job_deliveries (
      job_id TEXT NOT NULL, delivery_id TEXT NOT NULL,
      PRIMARY KEY(job_id, delivery_id)
    )`);
  }

  register(input: CompletionJobInput): string {
    if (
      input.repository !== this.options.config.expectedRepository ||
      !Number.isSafeInteger(input.number) ||
      input.number <= 0 ||
      !sha.test(input.headSha) ||
      !["fix", "review", "verify"].includes(input.action) ||
      !input.threadId ||
      !input.firstPrompt ||
      !input.firstDeliveryId ||
      (input.baselineVote !== null && !/^\[\d+,\d+\]$/.test(input.baselineVote))
    )
      throw new PermanentError("Invalid coordination completion job");
    const id = keyFor(input);
    const at = this.now().toISOString();
    const next = new Date(this.now().getTime() + this.checkDelayMs).toISOString();
    this.db
      .prepare(`INSERT OR IGNORE INTO coordination_jobs
      (id,repository,number,head_sha,action,thread_id,first_prompt,first_delivery_id,
       state,accepted_wakes,next_check_at,created_at,updated_at,baseline_vote)
      VALUES (?,?,?,?,?,?,?,?,'pending',0,?,?,?,?)`)
      .run(
        id,
        input.repository,
        input.number,
        input.headSha,
        input.action,
        input.threadId,
        input.firstPrompt,
        input.firstDeliveryId,
        next,
        at,
        at,
        input.baselineVote,
      );
    const existing = this.db
      .prepare("SELECT thread_id FROM coordination_jobs WHERE id=?")
      .get(id) as { thread_id: string };
    if (existing.thread_id !== input.threadId)
      throw new PermanentError("Coordination job target changed");
    return id;
  }

  mayDeliver(id: string, deliveryId: string): boolean {
    const row = this.db
      .prepare("SELECT state,accepted_wakes FROM coordination_jobs WHERE id=?")
      .get(id) as Pick<Row, "state" | "accepted_wakes"> | undefined;
    if (row?.state !== "pending") return false;
    const accepted = this.db
      .prepare("SELECT 1 FROM coordination_job_deliveries WHERE job_id=? AND delivery_id=?")
      .get(id, deliveryId);
    return Boolean(accepted) || row.accepted_wakes < 4;
  }

  acknowledge(id: string, deliveryId?: string): void {
    const first = this.db
      .prepare("SELECT first_delivery_id FROM coordination_jobs WHERE id=?")
      .get(id) as Pick<Row, "first_delivery_id"> | undefined;
    if (!first) throw new PermanentError("Unknown coordination job");
    const receiptId = deliveryId ?? first.first_delivery_id;
    this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          "INSERT OR IGNORE INTO coordination_job_deliveries(job_id,delivery_id) VALUES (?,?)",
        )
        .run(id, receiptId);
      if (inserted.changes) {
        this.db
          .prepare(`UPDATE coordination_jobs SET accepted_wakes=accepted_wakes+1,
          next_check_at=?,updated_at=? WHERE id=? AND state='pending'`)
          .run(
            new Date(this.now().getTime() + this.checkDelayMs).toISOString(),
            this.now().toISOString(),
            id,
          );
      }
    })();
  }

  list(): CompletionJobStatus[] {
    return (
      this.db
        .prepare("SELECT * FROM coordination_jobs ORDER BY created_at DESC, id DESC LIMIT 100")
        .all() as Row[]
    ).map((row) => ({
      id: row.id,
      number: row.number,
      headSha: row.head_sha,
      action: row.action,
      state: row.state,
      acceptedWakes: row.accepted_wakes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reason: row.reason,
    }));
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => console.error("Coordination completion check failed"));
    }, this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
    void this.tick().catch(() => console.error("Coordination completion check failed"));
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.tickPromise) return this.tickPromise;
    const work = (async () => {
      const due = this.db
        .prepare(
          "SELECT * FROM coordination_jobs WHERE state IN ('pending','needs-attention') AND next_check_at<=? ORDER BY created_at,id",
        )
        .all(this.now().toISOString()) as Row[];
      for (const row of due) {
        if (row.state === "needs-attention") await this.notifyAttention(row);
        else await this.reconcile(row);
      }
    })();
    this.tickPromise = work;
    void work
      .finally(() => {
        this.tickPromise = undefined;
      })
      .catch(() => {});
    return work;
  }

  private async reconcile(row: Row): Promise<void> {
    let snapshot: CoordinationSnapshot;
    try {
      snapshot = await this.options.snapshots.read(row.number);
    } catch {
      if (row.read_failures >= 2) {
        this.finish(row.id, "needs-attention", "GitHub readback unavailable after three checks");
      } else {
        this.db
          .prepare("UPDATE coordination_jobs SET read_failures=read_failures+1 WHERE id=?")
          .run(row.id);
        this.defer(row.id, "GitHub readback unavailable");
      }
      return;
    }
    if (this.closed) return;
    if (row.read_failures) {
      this.db.prepare("UPDATE coordination_jobs SET read_failures=0 WHERE id=?").run(row.id);
    }
    if (snapshot.repository !== row.repository || snapshot.state !== "open") {
      this.finish(row.id, "superseded", "PR closed or repository changed");
      return;
    }
    const decision = evaluateCoordination(snapshot, this.options.config);
    if (decision.action === "blocked") {
      this.finish(row.id, "needs-attention", decision.reason);
      return;
    }
    const vote = latestTrustedVote(snapshot, this.options.config);
    let newVote = false;
    if (vote) {
      if (row.baseline_vote === null) {
        newVote = true;
      } else {
        let baseline: unknown;
        try {
          baseline = JSON.parse(row.baseline_vote);
        } catch {
          baseline = null;
        }
        if (
          !Array.isArray(baseline) ||
          baseline.length !== 2 ||
          !baseline.every((part) => Number.isSafeInteger(part))
        ) {
          this.finish(row.id, "needs-attention", "Invalid saved review ordering");
          return;
        }
        newVote = vote.time > baseline[0] || (vote.time === baseline[0] && vote.id > baseline[1]);
      }
    }
    if (
      row.action === "fix" &&
      snapshot.headSha !== row.head_sha &&
      newVote &&
      vote?.decision === "approve" &&
      snapshot.labels.includes("review:hermes")
    ) {
      this.finish(row.id, "complete", "New head attested and handed to peer review");
      return;
    }
    if (row.action !== "fix" && snapshot.headSha !== row.head_sha) {
      this.finish(row.id, "superseded", "Head changed before action completed");
      return;
    }
    if (row.action === "review" && newVote) {
      this.finish(row.id, "complete", "Trusted current-head review recorded");
      return;
    }
    if (row.action === "verify" && newVote && vote?.decision === "revise") {
      this.finish(row.id, "superseded", "Owner verification requested changes");
      return;
    }
    if (row.action === "verify" && newVote && vote?.decision === "approve") {
      this.finish(row.id, "complete", "Trusted owner verification approved");
      return;
    }
    if (decision.action !== row.action) {
      if (row.inactive_checks >= 2) {
        this.finish(row.id, "needs-attention", "Requested PR action is no longer active");
      } else {
        this.db
          .prepare("UPDATE coordination_jobs SET inactive_checks=inactive_checks+1 WHERE id=?")
          .run(row.id);
        this.defer(row.id, "Waiting for current PR handoff");
      }
      return;
    }
    if (row.inactive_checks) {
      this.db.prepare("UPDATE coordination_jobs SET inactive_checks=0 WHERE id=?").run(row.id);
    }
    if (row.accepted_wakes >= 4) {
      this.finish(
        row.id,
        "needs-attention",
        "Work remains unfinished after three accepted resumes",
      );
      await this.notifyAttention({ ...row, state: "needs-attention" });
      return;
    }

    const first = row.accepted_wakes === 0;
    const deliveryId = first ? row.first_delivery_id : `${row.id}:resume:${row.accepted_wakes}`;
    const prompt = first
      ? row.first_prompt
      : `Resume unfinished ${row.action} work for PR #${row.number} in ${row.repository}. ` +
        `The saved starting SHA was ${row.head_sha}; current readback is ${snapshot.headSha}. ` +
        "Re-fetch the PR and its trusted exact-SHA reviews before doing anything. " +
        "Finish the existing owner/reviewer handoff or report a blocker. No merge or deployment.";
    try {
      if (this.closed) return;
      if (!this.mayDeliver(row.id, deliveryId)) {
        this.finish(row.id, "needs-attention", "Wake allowance exhausted");
        return;
      }
      await this.options.inner.deliverToThread(row.thread_id, prompt, {
        sandbox: "workspace-write",
        deliveryId,
      });
      this.acknowledge(row.id, deliveryId);
      this.db.prepare("UPDATE coordination_jobs SET reason=NULL WHERE id=?").run(row.id);
    } catch (error) {
      if (error instanceof PermanentError) {
        this.finish(row.id, "needs-attention", "Desktop delivery uncertain or invalid");
      } else if (error instanceof BusyError || error instanceof UnreachableError) {
        this.defer(
          row.id,
          error instanceof BusyError ? "Codex task busy" : "Codex task unavailable",
        );
      } else {
        this.defer(row.id, "Desktop resume failed");
      }
    }
  }

  private defer(id: string, reason: string): void {
    this.db
      .prepare("UPDATE coordination_jobs SET next_check_at=?,updated_at=?,reason=? WHERE id=?")
      .run(
        new Date(this.now().getTime() + this.checkDelayMs).toISOString(),
        this.now().toISOString(),
        reason,
        id,
      );
  }

  private finish(id: string, state: JobState, reason: string): void {
    this.db
      .prepare(
        "UPDATE coordination_jobs SET state=?,next_check_at=?,updated_at=?,reason=? WHERE id=?",
      )
      .run(state, this.now().toISOString(), this.now().toISOString(), reason, id);
  }

  private async notifyAttention(row: Row): Promise<void> {
    if (row.attention_sent || this.closed) return;
    const message =
      `Coordination for PR #${row.number} in ${row.repository} needs attention. ` +
      `The ${row.action} work has not been verified complete. Tell the user that automatic work stopped; ` +
      "do not claim approval, merge, or deployment. Re-fetch the PR before suggesting next steps.";
    try {
      await this.options.inner.deliverToThread(row.thread_id, message, {
        sandbox: "workspace-write",
        deliveryId: `${row.id}:attention`,
      });
      this.db
        .prepare("UPDATE coordination_jobs SET attention_sent=1,updated_at=? WHERE id=?")
        .run(this.now().toISOString(), row.id);
    } catch (error) {
      // A permanent/uncertain send is never retried, including the attention receipt.
      if (error instanceof PermanentError) {
        this.db
          .prepare("UPDATE coordination_jobs SET attention_sent=1,reason=? WHERE id=?")
          .run("Attention delivery uncertain; inspect this job manually", row.id);
      } else {
        this.defer(row.id, "Attention delivery delayed");
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.tickPromise;
    this.db.close();
  }
}
