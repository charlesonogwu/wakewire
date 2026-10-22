import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckResult, SelftestReport } from "./checks.js";
import {
  HEAL_RECHECK_MS,
  HEARTBEAT_MS,
  type MonitorDeps,
  RUNTIME_POLL_MS,
  SelftestMonitor,
  STARTUP_DELAY_MS,
  STARTUP_RETRY_MS,
  T3_SETTLE_MS,
  type T3Runtime,
} from "./monitor.js";
import type { Funnel } from "./route.js";
import type { ToggleResult } from "./tailscale.js";

const FUNNEL: Funnel = { host: "host.example.ts.net", port: 8443, target: "http://127.0.0.1:8769" };
const ROUTE_FAULT =
  "1 of 2 public addresses for host.example.ts.net:8443 failed: 203.0.113.1 connected, then closed before any TLS reply";

type State = "ok" | "t3-down" | "route-healable" | "route-timeout";
function report(state: State): SelftestReport {
  const checks: CheckResult[] = [
    state === "t3-down"
      ? {
          name: "t3",
          status: "fail",
          reason: "T3 did not answer (not running, or still starting) (2 of 2 registered threads)",
          human: "Check that T3 Code is running.",
        }
      : { name: "t3", status: "pass", reason: "T3 answered for all 2 registered threads" },
    { name: "t3-token", status: "pass", reason: "T3 access is valid until 2026-11-20 (30 days)" },
    { name: "local-listener", status: "pass", reason: "127.0.0.1:8769 answered the signed ping" },
    state === "route-healable"
      ? { name: "public-route", status: "fail", reason: ROUTE_FAULT, human: "None yet." }
      : state === "route-timeout"
        ? {
            name: "public-route",
            status: "fail",
            reason: "1 of 2 public addresses failed: 203.0.113.1 no connection within 10 seconds",
            human: "Check Tailscale Funnel and the network.",
          }
        : {
            name: "public-route",
            status: "pass",
            reason: "all 2 public addresses reached this daemon",
          },
  ];
  return {
    at: new Date().toISOString(),
    checks,
    healable: state === "route-healable",
    funnel: FUNNEL,
  };
}

function harness(
  initial: { states?: State[]; runtime?: T3Runtime | null; toggle?: ToggleResult } = {},
) {
  const settings = new Map<string, string>();
  const sent: { message: string; id: string }[] = [];
  const states = [...(initial.states ?? [])];
  let current: State = "ok";
  let notifyFails = false;
  let runtime = initial.runtime ?? null;
  const toggles: Funnel[] = [];
  const sleeps: number[] = [];
  let concurrentChecks = 0;
  let maxConcurrent = 0;
  let gate: Promise<void> | null = null;
  const deps: MonitorDeps = {
    checks: vi.fn(async () => {
      concurrentChecks++;
      maxConcurrent = Math.max(maxConcurrent, concurrentChecks);
      if (gate) await gate;
      concurrentChecks--;
      current = states.shift() ?? current;
      return report(current);
    }),
    notify: async (message, id) => {
      if (notifyFails) throw new Error("T3 unreachable");
      sent.push({ message, id });
      return true;
    },
    toggle: async (funnel) => {
      toggles.push(funnel);
      return initial.toggle ?? { outcome: "toggled", identical: true, before: "{}", after: "{}" };
    },
    readRuntime: () => runtime,
    settings: {
      get: (key) => settings.get(key) ?? null,
      set: (key, value) => settings.set(key, value),
    },
    logger: pino({ level: "silent" }),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  const monitor = new SelftestMonitor(deps);
  return {
    monitor,
    deps,
    sent,
    toggles,
    sleeps,
    settings,
    maxConcurrent: () => maxConcurrent,
    next: (...more: State[]) => states.push(...more),
    setRuntime: (next: T3Runtime) => {
      runtime = next;
    },
    failNotify: (fails: boolean) => {
      notifyFails = fails;
    },
    hold: () => {
      let release = () => {};
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SelftestMonitor triggers", () => {
  it("checks 2 minutes after start (Tailscale and T3 may still be starting), then hourly", async () => {
    const h = harness();
    h.monitor.start();
    expect(h.deps.checks).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(h.deps.checks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(h.deps.checks).toHaveBeenCalledTimes(2);
    expect(h.sent).toEqual([]);
    h.monitor.stop();
  });

  it("looks again before reporting a failure right after a reboot", async () => {
    const h = harness({ states: ["t3-down", "ok"] });
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(h.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(STARTUP_RETRY_MS - STARTUP_DELAY_MS);
    expect(h.deps.checks).toHaveBeenCalledTimes(2);
    expect(h.sent).toEqual([]);
    h.monitor.stop();
  });

  it("reports one result after a T3 update, and nothing for the first sighting", async () => {
    const h = harness({ runtime: { serverVersion: "0.1.0", startedAt: "2026-10-19T19:00:00Z" } });
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(h.sent).toEqual([]);
    h.setRuntime({ serverVersion: "0.1.1", startedAt: "2026-10-21T22:54:51Z" });
    await vi.advanceTimersByTimeAsync(RUNTIME_POLL_MS + T3_SETTLE_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toContain(
      "after T3 changed (was 0.1.0 started 2026-10-19T19:00:00Z; now 0.1.1",
    );
    expect(h.sent[0]?.message).toContain("All checks passed.");
    await vi.advanceTimersByTimeAsync(RUNTIME_POLL_MS * 3);
    expect(h.sent).toHaveLength(1);
    h.monitor.stop();
  });

  it("re-checks after a T3 restart on the same version but stays quiet when nothing changed", async () => {
    const h = harness({ runtime: { serverVersion: "0.1.1", startedAt: "2026-10-21T22:54:51Z" } });
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    h.setRuntime({ serverVersion: "0.1.1", startedAt: "2026-10-22T08:00:00Z" });
    await vi.advanceTimersByTimeAsync(RUNTIME_POLL_MS + T3_SETTLE_MS);
    expect(h.deps.checks).toHaveBeenCalledTimes(2);
    expect(h.sent).toEqual([]);
    // A real change after a same-version restart is still reported.
    h.next("route-timeout");
    h.setRuntime({ serverVersion: "0.1.1", startedAt: "2026-10-22T09:00:00Z" });
    await vi.advanceTimersByTimeAsync(RUNTIME_POLL_MS + T3_SETTLE_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toMatch(
      /^WakeWire self-test after T3 restarted \(now 0\.1\.1 started 2026-10-22T09:00:00Z\):\nFAILED, public route/,
    );
    h.monitor.stop();
  });

  it("reports a T3 change that happened while the daemon was down with the startup check", async () => {
    const h = harness({ runtime: { serverVersion: "0.1.1", startedAt: "2026-10-21T22:54:51Z" } });
    h.settings.set("selftest.t3runtime", "0.1.0 started 2026-10-19T19:00:00Z");
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toContain("now 0.1.1");
    h.monitor.stop();
  });
});

describe("SelftestMonitor reporting", () => {
  it("sends one message when a check fails, none while it keeps failing, and one when it recovers", async () => {
    const h = harness();
    h.next("route-timeout", "route-timeout", "ok");
    await h.monitor.trigger("heartbeat");
    await h.monitor.trigger("heartbeat");
    await h.monitor.trigger("heartbeat");
    expect(h.sent.map((item) => item.message.split("\n")[1])).toEqual([
      "FAILED, public route: 1 of 2 public addresses failed: 203.0.113.1 no connection within 10 seconds.",
      "RECOVERED, public route: all 2 public addresses reached this daemon.",
    ]);
    expect(h.sent[0]?.message).toContain(
      "Left for a human: Check Tailscale Funnel and the network.",
    );
    expect(h.toggles).toEqual([]);
  });

  it("tries again on the next run when the message could not be sent", async () => {
    const h = harness();
    h.next("route-timeout", "route-timeout");
    h.failNotify(true);
    await h.monitor.trigger("heartbeat");
    expect(h.sent).toEqual([]);
    h.failNotify(false);
    await h.monitor.trigger("heartbeat");
    expect(h.sent).toHaveLength(1);
  });

  it("runs one self-test at a time; triggers during a run share the next one", async () => {
    const h = harness();
    const release = h.hold();
    const first = h.monitor.trigger("heartbeat");
    const second = h.monitor.trigger("t3-changed");
    const third = h.monitor.trigger("heartbeat");
    expect(second).toBe(third);
    release();
    await Promise.all([first, second, third]);
    expect(h.deps.checks).toHaveBeenCalledTimes(2);
    expect(h.maxConcurrent()).toBe(1);
  });
});

describe("SelftestMonitor self-heal", () => {
  it("toggles the funnel once for the connect-then-close fault, re-checks 3 minutes later and reports", async () => {
    const h = harness();
    h.next("route-healable", "ok");
    await h.monitor.trigger("heartbeat");
    expect(h.toggles).toEqual([FUNNEL]);
    expect(h.sleeps).toEqual([HEAL_RECHECK_MS]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toContain("RECOVERED, public route");
    expect(h.sent[0]?.message).toContain(
      "turned the Tailscale Funnel for host.example.ts.net:8443 off and on again (serve config unchanged)",
    );
    expect(h.sent[0]?.message).toContain("Left for a human: nothing.");
  });

  it("does not loop: a heal that does not work is reported once and not repeated until the route recovers", async () => {
    const h = harness();
    h.next("route-healable", "route-healable", "route-healable", "ok", "route-healable", "ok");
    await h.monitor.trigger("heartbeat");
    expect(h.toggles).toHaveLength(1);
    expect(h.sent[0]?.message).toContain(
      "It still fails, and WakeWire will not try again until the route recovers.",
    );
    await h.monitor.trigger("heartbeat");
    expect(h.toggles).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    await h.monitor.trigger("heartbeat");
    expect(h.sent[1]?.message).toContain("RECOVERED, public route");
    // A new failure episode may heal again.
    await h.monitor.trigger("heartbeat");
    expect(h.toggles).toHaveLength(2);
  });

  it("keeps a heal done while T3 is down and reports it once T3 is back", async () => {
    const h = harness({ runtime: { serverVersion: "0.1.1", startedAt: "2026-10-21T22:30:00Z" } });
    h.failNotify(true);
    h.next("route-healable", "ok", "ok");
    await h.monitor.trigger("heartbeat");
    expect(h.toggles).toHaveLength(1);
    expect(h.sent).toEqual([]);
    // T3 comes up later; the route already passes, so only the kept note explains what happened.
    h.failNotify(false);
    await h.monitor.trigger("t3-changed");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.message).toContain("RECOVERED, public route");
    expect(h.sent[0]?.message).toContain(
      "What WakeWire did: WakeWire turned the Tailscale Funnel for host.example.ts.net:8443 off and on again",
    );
    await h.monitor.trigger("heartbeat");
    expect(h.sent).toHaveLength(1);
  });

  it("never heals any other failure", async () => {
    const h = harness();
    h.next("route-timeout", "t3-down");
    await h.monitor.trigger("heartbeat");
    await h.monitor.trigger("heartbeat");
    expect(h.toggles).toEqual([]);
  });

  it("sends URGENT at once, with the restore command, when the route could not be turned back on", async () => {
    const h = harness({
      toggle: {
        outcome: "route-removed",
        before: '{"TCP":{"8443":{}}}',
        restore: "tailscale funnel --bg --https=8443 http://127.0.0.1:8769",
      },
    });
    h.next("route-healable");
    await h.monitor.trigger("heartbeat");
    expect(h.sent[0]?.message).toMatch(/^URGENT from WakeWire: GitHub cannot reach WakeWire/);
    expect(h.sent[0]?.message).toContain(
      "run `tailscale funnel --bg --https=8443 http://127.0.0.1:8769`",
    );
    expect(h.sleeps).toEqual([]);
    expect(h.deps.checks).toHaveBeenCalledTimes(1);
  });

  it("sends URGENT with both versions when the serve config changed", async () => {
    const h = harness({
      toggle: { outcome: "toggled", identical: false, before: '{"a":1}', after: '{"a":2}' },
    });
    h.next("route-healable", "ok");
    await h.monitor.trigger("heartbeat");
    expect(h.sent[0]?.message).toContain("URGENT from WakeWire");
    expect(h.sent[0]?.message).toContain('Before: {"a":1}');
    expect(h.sent[0]?.message).toContain('After: {"a":2}');
    expect(h.sent[1]?.message).toContain("serve config CHANGED, sent as URGENT");
  });

  it("leaves the heal until the reboot re-check, and then heals", async () => {
    const h = harness({ states: ["route-healable", "route-healable", "ok"] });
    h.monitor.start();
    await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
    expect(h.toggles).toEqual([]);
    await vi.advanceTimersByTimeAsync(STARTUP_RETRY_MS - STARTUP_DELAY_MS);
    expect(h.toggles).toHaveLength(1);
    expect(h.sent[0]?.message).toContain("RECOVERED, public route");
    h.monitor.stop();
  });
});
