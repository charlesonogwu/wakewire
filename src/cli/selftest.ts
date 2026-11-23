import { apiFetch, inspectDaemonState, readDaemonState } from "../client.js";
import type { CheckResult, SelftestReport } from "../selftest/checks.js";

/** The checks run inside the daemon (it holds the webhook secret and the T3 client), so allow for slow probes. */
export const SELFTEST_TIMEOUT_MS = 90_000;

const LABEL: Record<CheckResult["name"], string> = {
  t3: "T3 reachable",
  "t3-token": "T3 access",
  "local-listener": "local listener",
  "public-route": "public route",
};

/** One line per check, plus what a human must do. Never includes tokens or secrets. */
export function formatReport(report: Pick<SelftestReport, "checks">): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${check.status.toUpperCase().padEnd(4)}  ${LABEL[check.name]}: ${check.reason}`);
    if (check.status === "fail" && check.human) lines.push(`      next: ${check.human}`);
  }
  return lines.join("\n");
}

/** True when nothing failed (warnings and skips pass). */
export function reportPassed(report: Pick<SelftestReport, "checks">): boolean {
  return report.checks.every((check) => check.status !== "fail");
}

const daemonDown = (why: string): Pick<SelftestReport, "checks"> => ({
  checks: [
    {
      name: "local-listener",
      status: "fail",
      reason: `the WakeWire daemon is not reachable (${why})`,
      human: "Start it with `wakewire start -d` or its scheduled task.",
    },
    { name: "t3", status: "skip", reason: "needs the daemon" },
    { name: "t3-token", status: "skip", reason: "needs the daemon (see `wakewire t3 status`)" },
    { name: "public-route", status: "skip", reason: "needs the daemon" },
  ],
});

export async function selftest(opts: { json?: boolean }): Promise<boolean> {
  let report: Pick<SelftestReport, "checks">;
  const state = readDaemonState();
  const inspection = state ? await inspectDaemonState(state) : null;
  if (!state || inspection?.status !== "reachable") {
    report = daemonDown(state ? `${inspection?.status ?? "unknown"}` : "not running");
  } else {
    try {
      const result = await apiFetch<SelftestReport>("/api/selftest", {
        timeoutMs: SELFTEST_TIMEOUT_MS,
      });
      if (result.status !== 200 || !Array.isArray(result.body.checks))
        report = daemonDown(`self-test answered ${result.status}`);
      else report = result.body;
    } catch {
      report = daemonDown("self-test request failed");
    }
  }
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return reportPassed(report);
}
