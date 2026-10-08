import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { CoordinationConfigSchema } from "../coordination/adapter.js";
import type { Logger } from "../logging.js";
import {
  type AgentAdapter,
  type DeliveryOptions,
  PermanentError,
  UnreachableError,
} from "./types.js";

const AbsolutePath = z.string().min(1).refine(path.isAbsolute, "Expected an absolute path");
export const T3RegistrationSchema = z
  .object({
    threadIds: z
      .array(z.uuid())
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate thread IDs"),
    bridgePath: AbsolutePath,
    stateFile: AbsolutePath,
    inheritPermissions: z.literal(true),
    coordination: CoordinationConfigSchema.optional(),
  })
  .strict();
type Registration = z.infer<typeof T3RegistrationSchema>;

const RuntimeMode = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const InteractionMode = z.enum(["default", "plan"]);
const Snapshot = z.object({
  thread: z.object({
    id: z.string(),
    runtimeMode: RuntimeMode,
    interactionMode: InteractionMode,
    archivedAt: z.string().nullable().optional(),
    session: z.object({ status: z.string() }).nullable().optional(),
    messages: z.array(z.object({ id: z.string(), role: z.string(), text: z.string() })),
  }),
  page: z
    .object({ hasMore: z.boolean().optional(), beforeCursor: z.string().nullable().optional() })
    .optional(),
});
const Command = z.object({
  type: z.literal("thread.turn.start"),
  commandId: z.string(),
  threadId: z.string(),
  message: z.object({
    messageId: z.string(),
    role: z.literal("user"),
    text: z.string(),
    attachments: z.array(z.never()),
  }),
  runtimeMode: RuntimeMode,
  interactionMode: InteractionMode,
  deliveryMode: z.literal("after-current"),
  createdAt: z.string(),
});
export type T3Command = z.infer<typeof Command>;
export interface T3Client {
  probe(): Promise<unknown>;
  thread(id: string, opts?: { turnLimit?: number; beforeCursor?: string }): Promise<unknown>;
  dispatch(command: T3Command): Promise<unknown>;
  environmentStatuses(): Promise<unknown>;
}

/** Load the installed bridge, which owns token discovery and authentication.
 * Recreate on failure so a daemon started before T3 can recover when T3 starts.
 * Never propagate bridge exception text: it may contain server response data.
 */
export class InstalledT3Client implements T3Client {
  private client: Promise<T3Client> | undefined;
  constructor(private readonly bridgePath: string) {}
  private async use<T>(call: (client: T3Client) => Promise<T>): Promise<T> {
    try {
      this.client ??= import(pathToFileURL(this.bridgePath).href).then(
        (module) => module.makeBridgeClient() as T3Client,
      );
      return await call(await this.client);
    } catch (error) {
      this.client = undefined;
      throw error;
    }
  }
  probe() {
    return this.use((client) => client.probe());
  }
  thread(id: string, opts?: { turnLimit?: number; beforeCursor?: string }) {
    return this.use((client) => client.thread(id, opts));
  }
  dispatch(command: T3Command) {
    return this.use((client) => client.dispatch(command));
  }
  environmentStatuses() {
    return this.use((client) => client.environmentStatuses());
  }
}

const Receipt = z.object({
  hash: z.string(),
  command: z.string(),
  state: z.enum(["sending", "sent"]),
});
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class T3ThreadAdapter implements AgentAdapter {
  readonly name = "t3-thread";
  readonly supportsCoalescing = false;
  readonly supportsNewThreads = false;
  private readonly config: Registration;
  private readonly db: Database.Database;
  constructor(
    config: Registration,
    private readonly client: T3Client,
    private readonly logger: Logger,
  ) {
    this.config = T3RegistrationSchema.parse(config);
    this.db = new Database(config.stateFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS t3_receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('sending','sent')))",
    );
  }

  async deliverToThread(threadId: string, prompt: string, opts: DeliveryOptions) {
    if (
      threadId !== this.config.threadIds[0] ||
      !opts.deliveryId ||
      !prompt.trim() ||
      opts.sandbox !== "workspace-write"
    ) {
      throw new PermanentError(
        "Invalid T3 route, permissions, or delivery identity; route must target the registered primary",
      );
    }
    const id = opts.deliveryId;
    const hash = digest([threadId, prompt]);
    const marker = `[wakewire-delivery:${JSON.stringify(id)}]`;
    let row = this.db.prepare("SELECT hash,command,state FROM t3_receipts WHERE id=?").get(id);
    if (!row) {
      let selected: z.infer<typeof Snapshot>["thread"] | undefined;
      for (const target of this.config.threadIds) {
        const { thread } = await this.read(target);
        if (thread.archivedAt) throw new PermanentError("Registered T3 thread is archived");
        if (
          !thread.session ||
          ["idle", "starting", "running", "ready", "interrupted", "stopped"].includes(
            thread.session.status,
          )
        ) {
          selected = thread;
          break;
        }
      }
      if (!selected) throw new UnreachableError("No registered T3 session is usable");
      const command: T3Command = {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId: selected.id,
        message: {
          messageId: randomUUID(),
          role: "user",
          text: `${marker}\n\n${prompt}`,
          attachments: [],
        },
        runtimeMode: selected.runtimeMode,
        interactionMode: selected.interactionMode,
        deliveryMode: "after-current",
        createdAt: new Date().toISOString(),
      };
      // Persist the exact command and chosen target BEFORE dispatch. Concurrent
      // owners and restarts replay one commandId, using T3's durable command receipts.
      this.db
        .prepare(
          "INSERT OR IGNORE INTO t3_receipts(id,hash,command,state) VALUES (?,?,?,'sending')",
        )
        .run(id, hash, JSON.stringify(command));
      row = this.db.prepare("SELECT hash,command,state FROM t3_receipts WHERE id=?").get(id);
    }
    const receipt = Receipt.parse(row);
    if (receipt.hash !== hash)
      throw new PermanentError("Delivery identity reused with different content");
    const command = Command.parse(JSON.parse(receipt.command));
    if (!this.config.threadIds.includes(command.threadId))
      throw new PermanentError("Pending receipt target is no longer registered");
    if (receipt.state === "sent") return { threadId: command.threadId };

    if (!(await this.projected(command, marker))) {
      try {
        await this.client.dispatch(command);
      } catch {
        throw new UnreachableError(
          "Cannot reach T3 or confirm dispatch; retry will reconcile the durable command",
        );
      }
      let verified = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await this.projected(command, marker)) {
          verified = true;
          break;
        }
        if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!verified) throw new UnreachableError("T3 message projection is not yet confirmed");
    }
    this.db.prepare("UPDATE t3_receipts SET state='sent' WHERE id=? AND hash=?").run(id, hash);
    this.logger.info(
      { deliveryId: id, threadId: command.threadId, primaryThreadId: this.config.threadIds[0] },
      "WakeWire delivery projected in T3",
    );
    return { threadId: command.threadId };
  }

  private async read(id: string, beforeCursor?: string) {
    try {
      const snapshot = Snapshot.parse(
        await this.client.thread(id, { turnLimit: 50, ...(beforeCursor ? { beforeCursor } : {}) }),
      );
      if (snapshot.thread.id !== id) throw new PermanentError("T3 thread identity mismatch");
      return snapshot;
    } catch (error) {
      if (error instanceof PermanentError) throw error;
      if (
        error instanceof Error &&
        /No thread with id .* exists|\/threads\/[^ ]+ failed: HTTP 404/.test(error.message)
      ) {
        // The bridge's 'no thread' can also mean a remote environment is offline.
        // Only classify it permanently when discovery was complete and reachable.
        try {
          const status = z
            .object({
              environments: z.array(z.object({ reachable: z.boolean() })).min(1),
              discoveryError: z.string().optional(),
            })
            .parse(await this.client.environmentStatuses());
          if (!status.discoveryError && status.environments.every((env) => env.reachable))
            throw new PermanentError("Unknown registered T3 thread");
        } catch (statusError) {
          if (statusError instanceof PermanentError) throw statusError;
        }
      }
      throw new UnreachableError("Cannot reach T3 or verify thread state");
    }
  }

  private async projected(command: T3Command, marker: string): Promise<boolean> {
    let cursor: string | undefined;
    const visited = new Set<string>();
    for (let page = 0; page < 1000; page++) {
      const snapshot = await this.read(command.threadId, cursor);
      for (const message of snapshot.thread.messages) {
        if (message.role !== "user") continue;
        if (message.id === command.message.messageId || message.text.startsWith(`${marker}\n\n`)) {
          if (message.text !== command.message.text)
            throw new PermanentError("T3 delivery marker has conflicting content");
          return true;
        }
      }
      if (!snapshot.page?.hasMore) return false;
      const next = snapshot.page.beforeCursor;
      if (!next || visited.has(next))
        throw new UnreachableError("Cannot verify T3 message pagination");
      visited.add(next);
      cursor = next;
    }
    throw new UnreachableError("T3 projection history exceeds verification limit");
  }

  async startThread(): Promise<never> {
    throw new PermanentError("T3 delivery only supports registered existing threads");
  }
  async probe() {
    try {
      await this.client.probe();
      return true;
    } catch {
      return false;
    }
  }
  close() {
    if (this.db.open) this.db.close();
  }
}
