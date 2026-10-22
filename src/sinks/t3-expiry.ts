import type Database from "better-sqlite3";
import type { Logger } from "../logging.js";
import { daysLeft } from "./t3-token.js";

/** Warn (and notify once) when fewer than this many days of T3 access remain. */
export const T3_EXPIRY_WARNING_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface T3ExpiryDeps {
  expiresAt(): string | null;
  /** Sends one short notice via the normal T3 send path; must be idempotent per clientRequestId. */
  notify(message: string, clientRequestId: string): Promise<void>;
  logger: Logger;
  now?: () => number;
}

/**
 * Daily warning plus ONE in-thread notice per token expiry. State lives in the
 * adapter's receipt database so restarts do not repeat the notice.
 */
export class T3ExpiryMonitor {
  private running: Promise<void> | null = null;
  constructor(
    private readonly db: Database.Database,
    private readonly deps: T3ExpiryDeps,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS t3_expiry_notices(expires_at TEXT PRIMARY KEY,warned_day TEXT,notice TEXT CHECK(notice IN ('sending','sent')))",
    );
  }

  /** Never throws: an expiry reminder must not affect delivery. */
  check(): Promise<void> {
    this.running ??= this.run()
      .catch(() => {})
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async run(): Promise<void> {
    const expiresAt = this.deps.expiresAt();
    if (!expiresAt) return;
    const now = (this.deps.now ?? Date.now)();
    const remaining = Date.parse(expiresAt) - now;
    if (!(remaining < T3_EXPIRY_WARNING_DAYS * DAY_MS)) return;
    const date = new Date(expiresAt).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    this.db
      .prepare("INSERT OR IGNORE INTO t3_expiry_notices(expires_at) VALUES (?)")
      .run(expiresAt);
    const warned = this.db
      .prepare(
        "UPDATE t3_expiry_notices SET warned_day=? WHERE expires_at=? AND warned_day IS NOT ?",
      )
      .run(today, expiresAt, today);
    if (warned.changes === 1)
      this.deps.logger.warn(
        { adapter: "t3-thread", expiresAt, daysLeft: daysLeft(expiresAt, now) },
        remaining > 0
          ? `T3 access expires on ${date}; run \`wakewire t3 login\` to re-approve`
          : "T3 access has expired; run `wakewire t3 login` to re-approve",
      );
    if (remaining <= 0) return;
    const claimed = this.db
      .prepare(
        "UPDATE t3_expiry_notices SET notice='sending' WHERE expires_at=? AND notice IS NULL",
      )
      .run(expiresAt);
    if (claimed.changes !== 1) return;
    try {
      await this.deps.notify(
        `WakeWire: T3 access expires on ${date}. Charles should run \`wakewire t3 login\` and approve it in T3 so wake-ups keep arriving.`,
        `wakewire-t3-expiry-${expiresAt}`,
      );
      this.db
        .prepare("UPDATE t3_expiry_notices SET notice='sent' WHERE expires_at=?")
        .run(expiresAt);
      this.deps.logger.info({ adapter: "t3-thread", expiresAt }, "T3 expiry notice sent");
    } catch {
      // The send is idempotent per clientRequestId, so retrying later cannot duplicate it.
      this.db
        .prepare("UPDATE t3_expiry_notices SET notice=NULL WHERE expires_at=? AND notice='sending'")
        .run(expiresAt);
      this.deps.logger.warn({ adapter: "t3-thread", expiresAt }, "T3 expiry notice not sent yet");
    }
  }
}
