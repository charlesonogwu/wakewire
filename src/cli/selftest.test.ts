import { describe, expect, it } from "vitest";
import { formatReport, reportPassed } from "./selftest.js";

describe("selftest output", () => {
  it("prints one line per check, with the next step only for failures", () => {
    const report = {
      checks: [
        {
          name: "t3" as const,
          status: "pass" as const,
          reason: "T3 answered for all 2 registered threads",
        },
        {
          name: "t3-token" as const,
          status: "warn" as const,
          reason: "T3 access is valid until 2026-10-24 (2 days)",
        },
        {
          name: "local-listener" as const,
          status: "pass" as const,
          reason: "127.0.0.1:8769 answered the signed ping",
        },
        {
          name: "public-route" as const,
          status: "fail" as const,
          reason: "no Tailscale Funnel points at 127.0.0.1:8769",
          human: "Turn the funnel back on.",
        },
      ],
    };
    expect(formatReport(report)).toBe(
      [
        "PASS  T3 reachable: T3 answered for all 2 registered threads",
        "WARN  T3 access: T3 access is valid until 2026-10-24 (2 days)",
        "PASS  local listener: 127.0.0.1:8769 answered the signed ping",
        "FAIL  public route: no Tailscale Funnel points at 127.0.0.1:8769",
        "      next: Turn the funnel back on.",
      ].join("\n"),
    );
    expect(reportPassed(report)).toBe(false);
    expect(reportPassed({ checks: report.checks.slice(0, 3) })).toBe(true);
  });
});
