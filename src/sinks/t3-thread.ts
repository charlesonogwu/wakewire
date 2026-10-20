import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { Logger } from "../logging.js";
import { T3ExpiryMonitor } from "./t3-expiry.js";
import { T3NotSubmittedError } from "./t3-mcp.js";
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
  /** "bridge" (default): pinned third-party bridge. "official": T3 Code's own /mcp tools. */
  readonly dialect?: "bridge" | "official";
  /** Official transport only: expiry of the stored access token (never the token). */
  tokenExpiresAt?(): string | null;
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
// T3 Code's own MCP shapes (t3_thread_read / t3_project_list / t3_thread_list).
const OfficialRead = z.object({
  thread: z.object({
    threadId: z.string(),
    projectId: z.string(),
    status: z.string(),
    archived: z.boolean(),
    settled: z.boolean(),
    pendingRequestCount: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative().optional(),
  }),
  items: z.array(z.object({ type: z.string(), text: z.string().nullable().optional() })),
  nextPosition: z.number().int().nullable().optional(),
  hasMore: z.boolean().optional(),
});
const OfficialProjects = z.object({
  projects: z.array(z.object({ id: z.string(), workspaceRoot: z.string() })),
  nextCursor: z.number().int().nullable().optional(),
});
const OfficialThreads = z.object({ threads: z.array(z.object({ threadId: z.string() })) });
/** Idle and finished threads take a new turn; running ones queue it behind the current turn. */
const OFFICIAL_READY = ["idle", "running", "completed", "interrupted", "cancelled"];
type Readiness = "human" | "failed" | "ready" | "unverified";
interface Verified {
  readiness: Readiness;
  itemCount?: number | undefined;
}
const Receipt = z.object({
  hash: z.string(),
  state: z.enum(["sending", "sent"]),
  target_thread_id: z.string().nullable(),
});
/** Deterministic per delivery: T3 deduplicates sends by clientRequestId, so retries never double-send. */
export function t3ClientRequestId(deliveryId: string, hash: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([deliveryId, hash]))
    .digest("hex");
  return `wakewire-${digest.slice(0, 48)}`;
}
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
  private readonly official: boolean;
  private readonly expiry: T3ExpiryMonitor | null = null;
  private readonly expiryTimer: NodeJS.Timeout | null = null;
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
    this.official = client.dialect === "official";
    if (client.tokenExpiresAt) {
      this.expiry = new T3ExpiryMonitor(this.db, {
        expiresAt: () => client.tokenExpiresAt?.() ?? null,
        logger,
        notify: (message, clientRequestId) => this.notify(message, clientRequestId),
      });
      this.expiryTimer = setInterval(() => void this.expiry?.check(), 60 * 60 * 1000);
      this.expiryTimer.unref();
    }
  }
  /** Daily expiry warning plus a single notice per expiry (official transport only). */
  checkExpiry(): Promise<void> {
    return this.expiry?.check() ?? Promise.resolve();
  }
  /** Operator notice to the routing fallback (orchestrator), else the primary. */
  private async notify(message: string, clientRequestId: string) {
    const target = this.config.fallbackTargets[0] ?? this.config;
    await this.verify(target);
    unpack(
      await this.client.call("send_message", {
        threadId: target.threadId,
        message,
        mode: "queue",
        clientRequestId,
      }),
    );
  }
  private async verify(target: T3Target): Promise<Verified> {
    try {
      return this.official ? await this.verifyOfficial(target) : await this.verifyBridge(target);
    } catch (error) {
      // Mismatches stay permanent; proven-unsent failures (bridge pin, T3 access)
      // keep their distinct class so the operator sees the real cause.
      if (error instanceof PermanentError || error instanceof T3NotSubmittedError) throw error;
      throw new UnreachableError("Cannot verify T3 thread/project");
    }
  }
  private async verifyBridge(target: T3Target): Promise<Verified> {
    const thread = Thread.parse(
      unpack(
        await this.client.call("get_thread", {
          threadId: target.threadId,
          turnLimit: 1,
          includeActivities: false,
        }),
      ),
    );
    const projects = Projects.parse(unpack(await this.client.call("list_projects", {})));
    const threads = Threads.parse(
      unpack(await this.client.call("list_threads", { projectId: target.projectId, limit: 100 })),
    );
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
    if (["needs-approval", "needs-input", "plan-ready"].includes(thread.attention))
      return { readiness: "human" };
    if (
      thread.session.status === "error" ||
      thread.attention === "error" ||
      thread.latestTurn?.state === "error"
    )
      return { readiness: "failed" };
    if (
      ["working", "done", "idle"].includes(thread.attention) &&
      ["running", "ready", "stopped"].includes(thread.session.status)
    )
      return { readiness: "ready" };
    return { readiness: "unverified" };
  }
  /** The official /mcp serves one T3 environment (its origin), so identity is
   * thread + project + canonical workspace; environmentId applies to the bridge only. */
  private async verifyOfficial(target: T3Target): Promise<Verified> {
    const { thread } = OfficialRead.parse(
      unpack(
        await this.client.call("get_thread", {
          threadId: target.threadId,
          view: "messages",
          limit: 1,
          maxCharsPerItem: 1,
        }),
      ),
    );
    const projects: z.infer<typeof OfficialProjects>["projects"] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 20; page++) {
      const result = OfficialProjects.parse(
        unpack(
          await this.client.call("list_projects", {
            limit: 100,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ),
      );
      projects.push(...result.projects);
      if (result.nextCursor == null || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    // Settled threads leave T3's active list, so ask for the list the thread is in.
    const threads = OfficialThreads.parse(
      unpack(
        await this.client.call("list_threads", {
          projectId: target.projectId,
          limit: 100,
          settled: thread.settled,
        }),
      ),
    );
    const project = projects.filter((p) => p.id === target.projectId);
    if (
      thread.threadId !== target.threadId ||
      thread.projectId !== target.projectId ||
      thread.archived ||
      project.length !== 1 ||
      cwd(project[0]?.workspaceRoot ?? "") !== cwd(target.cwd) ||
      threads.threads.filter((t) => t.threadId === target.threadId).length !== 1
    ) {
      throw new PermanentError("T3 thread, project or workspace mismatch");
    }
    let readiness: Readiness = "unverified";
    if (thread.pendingRequestCount > 0 || thread.status === "waiting") readiness = "human";
    else if (thread.status === "failed") readiness = "failed";
    else if (OFFICIAL_READY.includes(thread.status)) readiness = "ready";
    return { readiness, itemCount: thread.itemCount };
  }
  async deliverToThread(threadId: string, prompt: string, opts: DeliveryOptions) {
    void this.checkExpiry();
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
      if (await this.reconcile(opts.deliveryId, hash, targetId)) return { threadId: targetId };
      throw this.uncertain(opts.deliveryId, targetId);
    }
    let selected: T3Target | undefined;
    for (const target of [this.config, ...this.config.fallbackTargets]) {
      const { readiness } = await this.verify(target);
      // Human requests take precedence over provider failure: do not bypass an
      // approval or input request by sending the same work to a fallback.
      if (readiness === "human") throw new BusyError("T3 is busy with a human request");
      if (readiness === "failed") {
        this.logger.warn(
          { threadId: target.threadId },
          "T3 target failed; checking next registered fallback",
        );
        continue;
      }
      if (readiness !== "ready")
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
    const message = `[wakewire-delivery:${JSON.stringify(opts.deliveryId)}]\n\n${prompt}`;
    try {
      if (this.official) await this.sendOfficial(selected, message, opts.deliveryId, hash);
      else await this.sendBridge(selected, message);
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
    } catch (error) {
      if (error instanceof T3NotSubmittedError) {
        // The client proves the call never reached T3 (bridge pin rejected before
        // a transport opened, or T3 refused the access token). Release only our
        // own unsent claim; ambiguous calls never take this path and keep their fence.
        this.db
          .prepare("DELETE FROM t3_receipts WHERE id=? AND hash=? AND state='sending'")
          .run(opts.deliveryId, hash);
        throw error;
      }
      if (await this.reconcile(opts.deliveryId, hash, selected.threadId))
        return { threadId: selected.threadId };
      throw this.uncertain(opts.deliveryId, selected.threadId);
    }
  }
  private async sendBridge(target: T3Target, message: string) {
    z.object({
      sent: z.literal(true),
      verified: z.literal(true),
      threadId: z.literal(target.threadId),
      environmentId: z.literal(target.environmentId),
      deliveryMode: z.literal("after-current"),
    }).parse(
      unpack(
        await this.client.call("send_message", {
          threadId: target.threadId,
          message,
          deliveryMode: "after-current",
        }),
      ),
    );
  }
  /** Queue mode is T3's equivalent of the bridge's after-current delivery. */
  private async sendOfficial(target: T3Target, message: string, deliveryId: string, hash: string) {
    const result = z.record(z.string(), z.unknown()).parse(
      unpack(
        await this.client.call("send_message", {
          threadId: target.threadId,
          message,
          mode: "queue",
          clientRequestId: t3ClientRequestId(deliveryId, hash),
        }),
      ),
    );
    if (typeof result.threadId === "string" && result.threadId !== target.threadId)
      throw new Error("T3 acknowledged a different thread");
  }
  /** Reconciliation only reads the recorded target. An absent marker NEVER
   * authorizes another send or a fallback, including a crash before submission. */
  private async reconcile(deliveryId: string, hash: string, threadId: string): Promise<boolean> {
    const target = [this.config, ...this.config.fallbackTargets].find(
      (candidate) => candidate.threadId === threadId,
    );
    if (!target) return false;
    try {
      const verified = await this.verify(target);
      const marker = `[wakewire-delivery:${JSON.stringify(deliveryId)}]`;
      const found = this.official
        ? await this.findMarkerOfficial(target, marker, verified.itemCount)
        : await this.findMarkerBridge(target, marker);
      if (!found) return false;
      this.db
        .prepare("UPDATE t3_receipts SET state='sent' WHERE id=? AND hash=? AND state='sending'")
        .run(deliveryId, hash);
      this.logger.info(
        { deliveryId, threadId, status: "sent" },
        "T3 delivery reconciled from projected user marker; no resend",
      );
      return true;
    } catch {
      /* A read failure is not evidence of delivery or permission to resend. */
    }
    return false;
  }
  private async findMarkerBridge(target: T3Target, marker: string): Promise<boolean> {
    const seen = new Set<string>();
    let beforeCursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = z
        .object({
          threadId: z.literal(target.threadId),
          environmentId: z.literal(target.environmentId),
          messages: z.array(z.object({ role: z.string(), text: z.string() })),
          page: z
            .object({
              hasMore: z.boolean().optional(),
              beforeCursor: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
        })
        .parse(
          unpack(
            await this.client.call("get_thread", {
              threadId: target.threadId,
              turnLimit: 50,
              includeActivities: false,
              ...(beforeCursor ? { beforeCursor } : {}),
            }),
          ),
        );
      if (result.messages.some((m) => m.role === "user" && m.text.includes(marker))) return true;
      const next = result.page?.beforeCursor;
      if (!result.page?.hasMore || !next || seen.has(next)) return false;
      seen.add(next);
      beforeCursor = next;
    }
    return false;
  }
  /** T3 item positions are global and read forward, so scan the most recent 1000 items. */
  private async findMarkerOfficial(
    target: T3Target,
    marker: string,
    itemCount: number | undefined,
  ): Promise<boolean> {
    let after = itemCount !== undefined && itemCount > 1000 ? itemCount - 1001 : undefined;
    const seen = new Set<number>();
    for (let page = 0; page < 20; page++) {
      const result = OfficialRead.parse(
        unpack(
          await this.client.call("get_thread", {
            threadId: target.threadId,
            view: "messages",
            limit: 50,
            maxCharsPerItem: 500,
            ...(after === undefined ? {} : { afterPosition: after }),
          }),
        ),
      );
      if (result.thread.threadId !== target.threadId) return false;
      if (result.items.some((item) => item.type === "user_message" && item.text?.includes(marker)))
        return true;
      const next = result.nextPosition;
      if (!result.hasMore || next == null || seen.has(next)) return false;
      seen.add(next);
      after = next;
    }
    return false;
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
    void this.checkExpiry();
    try {
      await this.verify(this.config);
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    try {
      await this.client.close();
    } finally {
      if (this.db.open) this.db.close();
    }
  }
}
