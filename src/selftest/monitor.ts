import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "../logging.js";
import type { CheckName, CheckResult, SelftestReport } from "./checks.js";
import type { Funnel } from "./route.js";
import type { ToggleResult } from "./tailscale.js";

/** A reboot leaves Tailscale and T3 still starting, so the first check waits a little. */
export const STARTUP_DELAY_MS = 2 * 60_000;
/** A failing first check is looked at again this long after start before anyone is told. */
export const STARTUP_RETRY_MS = 5 * 60_000;
export const HEARTBEAT_MS = 60 * 60_000;
export const RUNTIME_POLL_MS = 60_000;
/** T3 has just restarted; give it a moment before checking. */
export const T3_SETTLE_MS = 30_000;
export const HEAL_RECHECK_MS = 3 * 60_000;

export type Trigger = "startup" | "startup-retry" | "heartbeat" | "t3-changed";

const KEYS = {
  reported: "selftest.reported",
  heal: "selftest.heal",
  runtime: "selftest.t3runtime",
  notice: "selftest.t3notice",
  /** What a heal did, kept until a message carrying it is actually sent. */
  healNote: "selftest.healnote",
} as const;

const LABEL: Record<CheckName, string> = {
  t3: "T3",
  "t3-token": "T3 access",
  "local-listener": "local listener",
  "public-route": "public route",
};

export interface T3Runtime {
  serverVersion: string;
  startedAt: string;
}

const Runtime = z.object({ serverVersion: z.string().min(1), startedAt: z.string().min(1) });

/** serverVersion and startedAt from T3's own runtime file; nothing else is read. */
export function readT3Runtime(
  file = path.join(os.homedir(), ".t3", "userdata", "server-runtime.json"),
): T3Runtime | null {
  try {
    const parsed = Runtime.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success
      ? { serverVersion: parsed.data.serverVersion, startedAt: parsed.data.startedAt }
      : null;
  } catch {
    return null;
  }
}

export interface MonitorDeps {
  checks(): Promise<SelftestReport>;
  /** Sends to the orchestrator thread; idempotent per clientRequestId. */
  notify(message: string, clientRequestId: string): Promise<boolean>;
  toggle(funnel: Funnel): Promise<ToggleResult>;
  readRuntime(): T3Runtime | null;
  settings: { get(key: string): string | null; set(key: string, value: string): void };
  logger: Logger;
  sleep?(ms: number): Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
const failing = (report: SelftestReport, name: CheckName) =>
  report.checks.find((check) => check.name === name)?.status === "fail";
const signature = (check: CheckResult) => `${check.status}:${check.reason}`;

/**
 * Runs the self-test after start, after T3 updates or restarts, and hourly. One run
 * at a time: a trigger that fires during a run waits for the next one, and triggers
 * that pile up while waiting share it, so two heals can never overlap.
 */
export class SelftestMonitor {
  private current: Promise<void> | null = null;
  private queued: { triggers: Set<Trigger>; promise: Promise<void>; done: () => void } | null =
    null;
  private readonly timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(private readonly deps: MonitorDeps) {}

  start(): void {
    // A T3 change seen while the daemon was down is reported by the startup run.
    this.observeRuntime();
    this.later(() => void this.trigger("startup"), STARTUP_DELAY_MS);
    this.repeat(() => void this.trigger("heartbeat"), HEARTBEAT_MS);
    this.repeat(() => {
      if (this.observeRuntime()) this.later(() => void this.trigger("t3-changed"), T3_SETTLE_MS);
    }, RUNTIME_POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
  }

  trigger(trigger: Trigger): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.current) {
      this.current = this.launch(new Set([trigger]));
      return this.current;
    }
    if (!this.queued) {
      let done = () => {};
      const promise = new Promise<void>((resolve) => {
        done = resolve;
      });
      this.queued = { triggers: new Set(), promise, done };
    }
    this.queued.triggers.add(trigger);
    return this.queued.promise;
  }

  private launch(triggers: Set<Trigger>): Promise<void> {
    return this.run(triggers).finally(() => {
      this.current = null;
      const next = this.queued;
      this.queued = null;
      if (next && !this.stopped) {
        this.current = this.launch(next.triggers);
        void this.current.then(next.done);
      } else next?.done();
    });
  }

  private later(fn: () => void, ms: number) {
    const timer = setTimeout(fn, ms);
    timer.unref();
    this.timers.push(timer);
  }

  private repeat(fn: () => void, ms: number) {
    const timer = setInterval(fn, ms);
    timer.unref();
    this.timers.push(timer);
  }

  /**
   * Records T3's current version and start time; true when either changed since last seen.
   * Any change re-runs the checks, but only a new version earns a message of its own.
   */
  private observeRuntime(): boolean {
    const runtime = this.deps.readRuntime();
    if (!runtime) return false;
    const key = `${runtime.serverVersion} started ${runtime.startedAt}`;
    const previous = this.deps.settings.get(KEYS.runtime);
    if (previous === key) return false;
    this.deps.settings.set(KEYS.runtime, key);
    if (previous === null) return false;
    const updated = !previous.startsWith(`${runtime.serverVersion} started `);
    // An unsent update notice survives a later same-version restart.
    if (updated || !this.pendingNotice()?.updated)
      this.deps.settings.set(KEYS.notice, JSON.stringify({ from: previous, to: key, updated }));
    return true;
  }

  private pendingNotice(): { from: string; to: string; updated: boolean } | null {
    try {
      return z
        .object({ from: z.string(), to: z.string(), updated: z.boolean().default(true) })
        .parse(JSON.parse(this.deps.settings.get(KEYS.notice) ?? ""));
    } catch {
      return null;
    }
  }

  private async run(triggers: Set<Trigger>): Promise<void> {
    try {
      let report = await this.deps.checks();
      const startupOnly = [...triggers].every((trigger) => trigger === "startup");
      if (startupOnly && (failing(report, "t3") || failing(report, "public-route"))) {
        this.deps.logger.info(
          { failing: report.checks.filter((c) => c.status === "fail").map((c) => c.name) },
          "self-test failed right after start; checking again before reporting",
        );
        this.later(() => void this.trigger("startup-retry"), STARTUP_RETRY_MS - STARTUP_DELAY_MS);
        return;
      }
      const heal = this.healState();
      if (!failing(report, "public-route") && heal.attempted) this.setHeal({ attempted: false });
      let healed: string | null = null;
      if (report.healable && report.funnel && !heal.attempted) {
        // One heal per failure episode; the episode ends only when the route passes again.
        this.setHeal({ attempted: true });
        const outcome = await this.heal(report.funnel);
        healed = outcome.note;
        // Kept until a message carrying it is sent: T3 is often still down right after a reboot.
        this.deps.settings.set(KEYS.healNote, healed);
        if (outcome.recheck) report = await this.deps.checks();
        if (!failing(report, "public-route")) this.setHeal({ attempted: false });
      }
      await this.report(report, healed ?? (this.deps.settings.get(KEYS.healNote) || null));
    } catch (error) {
      this.deps.logger.error(
        { err: error instanceof Error ? error.name : "unknown" },
        "self-test run failed",
      );
    }
  }

  private healState(): { attempted: boolean } {
    try {
      return z
        .object({ attempted: z.boolean() })
        .parse(JSON.parse(this.deps.settings.get(KEYS.heal) ?? ""));
    } catch {
      return { attempted: false };
    }
  }

  private setHeal(state: { attempted: boolean }) {
    this.deps.settings.set(KEYS.heal, JSON.stringify(state));
  }

  /** The proven fix, then a re-check after HEAL_RECHECK_MS. Urgent outcomes are sent at once. */
  private async heal(funnel: Funnel): Promise<{ note: string; recheck: boolean }> {
    const where = `${funnel.host}:${funnel.port}`;
    this.deps.logger.warn({ funnel: where }, "public route closes before TLS; toggling the funnel");
    const result = await this.deps.toggle(funnel);
    if (result.outcome === "status-unavailable")
      return {
        note: "WakeWire wanted to turn the funnel off and on, but could not read Tailscale's serve config, so it changed nothing.",
        recheck: false,
      };
    if (result.outcome === "not-running")
      return {
        note: `Tailscale is not running or not logged in (state ${result.state}), so WakeWire did not touch the funnel. For a human: log Tailscale back in.`,
        recheck: false,
      };
    if (result.outcome === "off-failed")
      return {
        note: `WakeWire tried to turn the funnel for ${where} off and on, but turning it off failed, so nothing changed.`,
        recheck: false,
      };
    if (result.outcome === "route-removed") {
      const urgent = [
        `URGENT from WakeWire: GitHub cannot reach WakeWire. To fix the public route it turned the Tailscale Funnel for ${where} off, but turning it back on failed twice.`,
        `For a human: run \`${result.restore}\`, then \`tailscale serve status --json\` and compare with the config before:`,
        result.before,
      ].join("\n");
      const sent = await this.send(urgent, `urgent-removed-${result.before}`);
      this.deps.logger.error({ funnel: where }, "funnel off but not back on; route removed");
      return {
        note: sent
          ? `WakeWire turned the funnel for ${where} off, but could not turn it back on (sent separately as URGENT).`
          : `WakeWire turned the funnel for ${where} off, but could not turn it back on. ${urgent}`,
        recheck: false,
      };
    }
    let changed = "serve config CHANGED, sent as URGENT";
    if (!result.identical) {
      const urgent = [
        `URGENT from WakeWire: it turned the Tailscale Funnel for ${where} off and on, and Tailscale's serve config is no longer identical.`,
        "For a human: compare the two and restore anything missing.",
        `Before: ${result.before}`,
        `After: ${result.after ?? "(could not be read)"}`,
      ].join("\n");
      if (!(await this.send(urgent, `urgent-changed-${result.before}-${result.after}`)))
        changed = `serve config CHANGED. ${urgent}`;
    }
    await (this.deps.sleep ?? sleep)(HEAL_RECHECK_MS);
    return {
      note: `WakeWire turned the Tailscale Funnel for ${where} off and on again (${result.identical ? "serve config unchanged" : changed}) and checked again 3 minutes later.`,
      recheck: true,
    };
  }

  private reported(): Partial<Record<CheckName, string>> {
    try {
      return z
        .record(z.string(), z.string())
        .parse(JSON.parse(this.deps.settings.get(KEYS.reported) ?? "")) as Partial<
        Record<CheckName, string>
      >;
    } catch {
      return {};
    }
  }

  /** One message per run with every change; nothing when nothing changed. */
  private async report(report: SelftestReport, healed: string | null): Promise<void> {
    const previous = this.reported();
    const next: Partial<Record<CheckName, string>> = {};
    const lines: string[] = [];
    for (const check of report.checks) {
      const label = LABEL[check.name];
      if (check.status === "fail") {
        next[check.name] = signature(check);
        const healing = check.name === "public-route" && healed;
        if (previous[check.name] === signature(check) && !healing) continue;
        lines.push(`FAILED, ${label}: ${check.reason}.`);
        if (healing)
          lines.push(
            `  What WakeWire did: ${healed} It still fails, and WakeWire will not try again until the route recovers.`,
          );
        if (check.human)
          lines.push(
            `  Left for a human: ${healing ? "Check Tailscale Funnel by hand (`tailscale funnel status`, `tailscale serve status --json`)." : check.human}`,
          );
      } else if (previous[check.name] || (check.name === "public-route" && healed)) {
        lines.push(`RECOVERED, ${label}: ${check.reason}.`);
        if (check.name === "public-route" && healed) lines.push(`  What WakeWire did: ${healed}`);
        lines.push("  Left for a human: nothing.");
      }
    }
    const notice = this.pendingNotice();
    let header = "WakeWire self-test";
    if (notice && (notice.updated || lines.length > 0)) {
      header = notice.updated
        ? `WakeWire self-test after T3 changed (was ${notice.from}; now ${notice.to})`
        : `WakeWire self-test after T3 restarted (now ${notice.to})`;
      if (lines.length === 0)
        lines.push(
          report.checks.some((check) => check.status === "fail")
            ? "Nothing new: the failures below were already reported."
            : "All checks passed.",
        );
      for (const check of report.checks)
        if (check.status === "fail" && !lines.some((line) => line.includes(check.reason)))
          lines.push(`Still failing, ${LABEL[check.name]}: ${check.reason}.`);
    }
    if (lines.length === 0) {
      // A restart on the same version with nothing new to say is not worth a message.
      if (notice) this.deps.settings.set(KEYS.notice, "");
      return;
    }
    const message = [`${header}:`, ...lines].join("\n");
    if (await this.send(message, `${report.at}\n${message}`)) {
      this.deps.settings.set(KEYS.reported, JSON.stringify(next));
      this.deps.settings.set(KEYS.notice, "");
      this.deps.settings.set(KEYS.healNote, "");
    }
  }

  private async send(message: string, identity: string): Promise<boolean> {
    const id = `wakewire-selftest-${createHash("sha256").update(identity).digest("hex").slice(0, 40)}`;
    try {
      if (await this.deps.notify(message, id)) return true;
      this.deps.logger.warn("self-test result not sent: this adapter has no operator thread");
      return true;
    } catch {
      // T3 itself may be the failure; the next run tries again.
      this.deps.logger.warn({ message }, "self-test result not sent yet (T3 unreachable?)");
      return false;
    }
  }
}
