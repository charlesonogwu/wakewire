import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  type AgentAdapter,
  BusyError,
  type DeliveryOptions,
  PermanentError,
  UnreachableError,
} from "./types.js";

export interface DesktopToolClient {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
}
export interface DesktopConfig {
  threadId: string;
  cwd: string;
  stateFile: string;
  inheritPermissions: boolean;
}
const Readback = z.object({
  thread: z.object({
    id: z.string(),
    kind: z.literal("codex"),
    hostId: z.literal("local"),
    cwd: z.string(),
    status: z.object({ type: z.string() }),
  }),
});
const Receipt = z.object({ hash: z.string(), state: z.enum(["sending", "sent"]) });
function unpack(raw: unknown): unknown {
  const result = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    })
    .parse(raw);
  if (result.isError) throw new Error("Desktop tool rejected the request");
  const parts = result.content.filter((x) => x.type === "text");
  if (parts.length !== 1 || !parts[0]?.text) throw new Error("Invalid Desktop response");
  return JSON.parse(parts[0].text);
}
function canonicalCwd(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Experimental: uses the installed Desktop owner, never a private app-server. */
export class CodexDesktopAdapter implements AgentAdapter {
  readonly name = "codex-desktop";
  readonly supportsCoalescing = false;
  readonly supportsNewThreads = false;
  private readonly db: Database.Database;
  constructor(
    private readonly config: DesktopConfig,
    private readonly client: DesktopToolClient,
  ) {
    if (
      !config.threadId ||
      !path.isAbsolute(config.cwd) ||
      !path.isAbsolute(config.stateFile) ||
      !config.inheritPermissions
    )
      throw new PermanentError(
        "Desktop needs an explicit target, absolute paths, and inherited-permissions opt-in",
      );
    this.db = new Database(config.stateFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS desktop_receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('sending','sent')))",
    );
  }
  async deliverToThread(threadId: string, prompt: string, opts: DeliveryOptions) {
    if (
      threadId !== this.config.threadId ||
      opts.sandbox !== "workspace-write" ||
      !opts.deliveryId ||
      !prompt.trim()
    )
      throw new PermanentError("Invalid Desktop target, permissions, or delivery identity");
    const hash = createHash("sha256")
      .update(JSON.stringify([threadId, prompt]))
      .digest("hex");
    const existing = this.db
      .prepare("SELECT hash,state FROM desktop_receipts WHERE id=?")
      .get(opts.deliveryId);
    if (existing) {
      const receipt = Receipt.parse(existing);
      if (receipt.hash !== hash)
        throw new PermanentError("Delivery identity reused with different content");
      if (receipt.state === "sent") return { threadId };
      throw new PermanentError(
        "Uncertain Desktop delivery: reconciliation required; refusing to resend",
      );
    }
    let state: z.infer<typeof Readback>;
    try {
      state = Readback.parse(
        unpack(
          await this.client.call("read_thread", {
            threadId,
            hostId: "local",
            turnLimit: 1,
            includeOutputs: false,
            maxOutputCharsPerItem: 0,
          }),
        ),
      );
    } catch {
      throw new UnreachableError("Cannot verify Desktop conversation");
    }
    if (
      state.thread.id !== threadId ||
      canonicalCwd(state.thread.cwd) !== canonicalCwd(this.config.cwd)
    )
      throw new PermanentError("Desktop conversation identity or workspace mismatch");
    if (state.thread.status.type !== "idle")
      throw new BusyError("Desktop conversation is busy or its idle state is unverified");
    // Durable fence precedes submission. A crash or lost response never permits
    // another POST merely because the queue retries or the daemon restarts.
    const claimed = this.db
      .prepare("INSERT OR IGNORE INTO desktop_receipts(id,hash,state) VALUES (?,?,'sending')")
      .run(opts.deliveryId, hash);
    if (claimed.changes !== 1) throw new BusyError("Another delivery owner holds this receipt");
    try {
      const response = z
        .object({ threadId: z.literal(threadId) })
        .parse(
          unpack(
            await this.client.call("send_message_to_thread", { threadId, prompt, hostId: "local" }),
          ),
        );
      this.db
        .prepare(
          "UPDATE desktop_receipts SET state='sent' WHERE id=? AND hash=? AND state='sending'",
        )
        .run(opts.deliveryId, hash);
      return { threadId: response.threadId };
    } catch {
      throw new PermanentError(
        "Uncertain Desktop delivery: reconciliation required; refusing to resend",
      );
    }
  }
  async startThread(): Promise<never> {
    throw new PermanentError(
      "Desktop delivery only supports the explicitly registered existing conversation",
    );
  }
  async probe() {
    try {
      const state = Readback.parse(
        unpack(
          await this.client.call("read_thread", {
            threadId: this.config.threadId,
            hostId: "local",
            turnLimit: 1,
            includeOutputs: false,
            maxOutputCharsPerItem: 0,
          }),
        ),
      );
      return (
        state.thread.id === this.config.threadId &&
        canonicalCwd(state.thread.cwd) === canonicalCwd(this.config.cwd)
      );
    } catch {
      return false;
    }
  }
  close() {
    this.client.close();
    if (this.db.open) this.db.close();
  }
}
