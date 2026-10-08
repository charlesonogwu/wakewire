import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { Logger } from "../logging.js";
import {
  type AgentAdapter,
  BusyError,
  type DeliveryOptions,
  PermanentError,
  UnreachableError,
} from "./types.js";

// Ported from the deployed MR T runtime's t3-thread.js. Primary fields retain
// its registration shape; only the explicitly registered fallbacks are new.
export const T3TargetSchema = z
  .object({
    threadId: z.string().min(1),
    environmentId: z.string().min(1),
    projectId: z.string().min(1),
    cwd: z.string().refine(path.isAbsolute),
  })
  .strict();
export const T3ConfigSchema = T3TargetSchema.extend({
  fallbackTargets: z.array(T3TargetSchema).max(19).default([]),
  stateFile: z.string().refine(path.isAbsolute),
  inheritPermissions: z.literal(true),
})
  .strict()
  .refine((config) => {
    const ids = [config.threadId, ...config.fallbackTargets.map((target) => target.threadId)];
    return new Set(ids).size === ids.length;
  }, "Duplicate T3 target thread IDs");
export type T3Config = z.infer<typeof T3ConfigSchema>;
export type T3Target = z.infer<typeof T3TargetSchema>;
export interface T3ToolClient {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void | Promise<void>;
}
const identity = { threadId: z.string(), environmentId: z.string() };
const Thread = z.object({
  ...identity,
  attention: z.string(),
  session: z.object({ status: z.string() }),
  latestTurn: z.object({ state: z.string() }).nullable().optional(),
});
const Projects = z.object({
  projects: z.array(
    z.object({ projectId: z.string(), environmentId: z.string(), workspaceRoot: z.string() }),
  ),
});
const Threads = z.object({ threads: z.array(z.object(identity)) });
const Receipt = z.object({
  hash: z.string(),
  state: z.enum(["sending", "sent"]),
  target_thread_id: z.string().nullable(),
});
function unpack(raw: unknown): unknown {
  const result = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    })
    .parse(raw);
  if (result.isError) {
    // Classify without propagating raw bridge output (which may contain secrets).
    if (
      result.content.some((part) =>
        /No thread with id .* exists|\/threads\/[^ ]+ failed: HTTP 404/.test(part.text ?? ""),
      )
    )
      throw new PermanentError("Unknown registered T3 thread");
    throw new UnreachableError("T3 tool rejected request");
  }
  const parts = result.content.filter((part) => part.type === "text");
  if (parts.length !== 1 || !parts[0]?.text) throw new Error("Invalid T3 response");
  return JSON.parse(parts[0].text);
}
const cwd = (value: string) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);

/** T3 owns the turn; WakeWire verifies ownership and conservatively fences sends. */
export class T3ThreadAdapter implements AgentAdapter {
  readonly name = "t3-thread";
  readonly supportsCoalescing = false;
  readonly supportsNewThreads = false;
  private readonly db: Database.Database;
  private readonly config: T3Config;
  constructor(
    config: z.input<typeof T3ConfigSchema>,
    private readonly client: T3ToolClient,
    private readonly logger: Logger,
  ) {
    this.config = T3ConfigSchema.parse(config);
    this.db = new Database(config.stateFile);
    this.db.pragma("journal_mode=WAL");
    this.db.pragma("synchronous=FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS t3_receipts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('sending','sent')))",
    );
    // Preserve deployed receipts. The selected target is needed to reconcile
    // fallback sends after restart; old single-target receipts use the primary.
    this.db.transaction(() => {
      const columns = this.db.prepare("PRAGMA table_info(t3_receipts)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "target_thread_id"))
        this.db.exec("ALTER TABLE t3_receipts ADD COLUMN target_thread_id TEXT");
    })();
  }
  private async verify(target: T3Target) {
    let thread: z.infer<typeof Thread>,
      projects: z.infer<typeof Projects>,
      threads: z.infer<typeof Threads>;
    try {
      thread = Thread.parse(
        unpack(
          await this.client.call("get_thread", {
            threadId: target.threadId,
            turnLimit: 1,
            includeActivities: false,
          }),
        ),
      );
      projects = Projects.parse(unpack(await this.client.call("list_projects", {})));
      threads = Threads.parse(
        unpack(await this.client.call("list_threads", { projectId: target.projectId, limit: 100 })),
      );
    } catch (error) {
      if (error instanceof PermanentError) throw error;
      throw new UnreachableError("Cannot verify T3 thread/project");
    }
    const project = projects.projects.filter(
      (p) => p.projectId === target.projectId && p.environmentId === target.environmentId,
    );
    if (
      thread.threadId !== target.threadId ||
      thread.environmentId !== target.environmentId ||
      project.length !== 1 ||
      cwd(project[0]?.workspaceRoot ?? "") !== cwd(target.cwd) ||
      threads.threads.filter(
        (t) => t.threadId === target.threadId && t.environmentId === target.environmentId,
      ).length !== 1
    ) {
      throw new PermanentError("T3 thread, environment or workspace mismatch");
    }
    return thread;
  }
  async deliverToThread(threadId: string, prompt: string, opts: DeliveryOptions) {
    if (
      threadId !== this.config.threadId ||
      opts.sandbox !== "workspace-write" ||
      !opts.deliveryId ||
      !prompt.trim()
    )
      throw new PermanentError("Invalid T3 target, permissions or delivery identity");
    const hash = createHash("sha256")
      .update(JSON.stringify([threadId, prompt]))
      .digest("hex");
    const existing = this.db
      .prepare("SELECT hash,state,target_thread_id FROM t3_receipts WHERE id=?")
      .get(opts.deliveryId);
    if (existing) {
      const receipt = Receipt.parse(existing);
      if (receipt.hash !== hash)
        throw new PermanentError("Delivery identity reused with different content");
      const targetId = receipt.target_thread_id ?? threadId;
      if (receipt.state === "sent") return { threadId: targetId };
      throw this.uncertain(opts.deliveryId, targetId);
    }
    let selected: T3Target | undefined;
    for (const target of [this.config, ...this.config.fallbackTargets]) {
      const thread = await this.verify(target);
      // Human requests take precedence over provider failure: do not bypass an
      // approval or input request by sending the same work to a fallback.
      if (["needs-approval", "needs-input", "plan-ready"].includes(thread.attention))
        throw new BusyError("T3 is busy with a human request");
      if (
        thread.session.status === "error" ||
        thread.attention === "error" ||
        thread.latestTurn?.state === "error"
      ) {
        this.logger.warn(
          { threadId: target.threadId },
          "T3 target failed; checking next registered fallback",
        );
        continue;
      }
      if (
        !["working", "done", "idle"].includes(thread.attention) ||
        !["running", "ready", "stopped"].includes(thread.session.status)
      )
        throw new BusyError("T3 is busy with a human request or its state is unverified");
      selected = target;
      break;
    }
    if (!selected) throw new UnreachableError("No registered T3 provider/session is usable");
    const claimed = this.db
      .prepare(
        "INSERT OR IGNORE INTO t3_receipts(id,hash,state,target_thread_id) VALUES (?,?,'sending',?)",
      )
      .run(opts.deliveryId, hash, selected.threadId);
    if (claimed.changes !== 1) throw new BusyError("Another owner holds delivery receipt");
    try {
      z.object({
        sent: z.literal(true),
        verified: z.literal(true),
        threadId: z.literal(selected.threadId),
        environmentId: z.literal(selected.environmentId),
        deliveryMode: z.literal("after-current"),
      }).parse(
        unpack(
          await this.client.call("send_message", {
            threadId: selected.threadId,
            message: `[wakewire-delivery:${JSON.stringify(opts.deliveryId)}]\n\n${prompt}`,
            deliveryMode: "after-current",
          }),
        ),
      );
      this.db
        .prepare("UPDATE t3_receipts SET state='sent' WHERE id=? AND hash=? AND state='sending'")
        .run(opts.deliveryId, hash);
      this.logger.info(
        {
          deliveryId: opts.deliveryId,
          threadId: selected.threadId,
          environmentId: selected.environmentId,
        },
        "WakeWire delivery projected in T3",
      );
      return { threadId: selected.threadId };
    } catch {
      throw this.uncertain(opts.deliveryId, selected.threadId);
    }
  }
  private uncertain(deliveryId: string, threadId: string) {
    this.logger.error(
      { deliveryId, threadId, status: "uncertain" },
      "Uncertain T3 delivery; inspect target and receipt manually; refusing resend",
    );
    // Existing queue handling persists status=failed and the error, logs it,
    // releases the FIFO slot and proceeds. Completion jobs become needs-attention.
    return new PermanentError(
      "Uncertain T3 delivery: inspect target and receipt before reconciliation; refusing resend",
    );
  }
  async startThread(): Promise<never> {
    throw new PermanentError("T3 supports only registered existing threads");
  }
  async probe() {
    try {
      await this.verify(this.config);
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    try {
      await this.client.close();
    } finally {
      if (this.db.open) this.db.close();
    }
  }
}
