import { describe, expect, it } from "vitest";
import type { OperatorHealth } from "../sinks/types.js";
import { type CheckDeps, runChecks } from "./checks.js";
import type { ProbeOutcome } from "./route.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const PING = { deliveryId: "wakewire-selftest-x", body: "{}", signature: "sha256=synthetic" };
const SERVE = {
  Web: { "host.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8769" } } } },
  AllowFunnel: { "host.example.ts.net:8443": true },
};
const healthy: OperatorHealth = {
  targets: [
    { threadId: "primary", ok: true },
    { threadId: "orchestrator", ok: true },
  ],
  tokenExpiresAt: new Date(NOW + 30 * DAY).toISOString(),
};

function deps(overrides: Partial<CheckDeps> & { outcomes?: ProbeOutcome[] } = {}): CheckDeps {
  const outcomes = overrides.outcomes ?? ["pong", "pong"];
  return {
    operatorHealth: async () => healthy,
    ingress: { port: 8769, ping: async () => PING },
    tailscale: async () => ({ ok: true, stdout: JSON.stringify(SERVE) }),
    resolve4: async () => outcomes.map((_, index) => `203.0.113.${index + 1}`),
    probe: async (address) => outcomes[Number(address.split(".")[3]) - 1] ?? "pong",
    probeLocal: async () => "pong",
    now: () => NOW,
    ...overrides,
  };
}
const check = (report: Awaited<ReturnType<typeof runChecks>>, name: string) =>
  report.checks.find((item) => item.name === name);

describe("runChecks", () => {
  it("passes every check when T3, the token, the listener and every public address answer", async () => {
    const report = await runChecks(deps());
    expect(report.checks.map((item) => [item.name, item.status])).toEqual([
      ["t3", "pass"],
      ["t3-token", "pass"],
      ["local-listener", "pass"],
      ["public-route", "pass"],
    ]);
    expect(report.healable).toBe(false);
    expect(report.funnel).toEqual({
      host: "host.example.ts.net",
      port: 8443,
      target: "http://127.0.0.1:8769",
    });
  });

  it("says who must act when T3 needs Charles or a code change, and never heals either", async () => {
    const auth = await runChecks(
      deps({
        operatorHealth: async () => ({
          ...healthy,
          targets: [{ threadId: "primary", ok: false, problem: "auth" }],
        }),
      }),
    );
    expect(check(auth, "t3")).toMatchObject({
      status: "fail",
      human: expect.stringContaining("wakewire t3 login"),
    });
    const api = await runChecks(
      deps({
        operatorHealth: async () => ({
          ...healthy,
          targets: [{ threadId: "primary", ok: false, problem: "api-changed" }],
        }),
      }),
    );
    expect(check(api, "t3")?.human).toContain("code change");
    expect(auth.healable || api.healable).toBe(false);
  });

  it("reports T3 access that is missing, expired or close to expiry", async () => {
    const missing = await runChecks(
      deps({ operatorHealth: async () => ({ ...healthy, tokenExpiresAt: null }) }),
    );
    expect(check(missing, "t3-token")?.status).toBe("fail");
    const expired = await runChecks(
      deps({
        operatorHealth: async () => ({
          ...healthy,
          tokenExpiresAt: new Date(NOW - DAY).toISOString(),
        }),
      }),
    );
    expect(check(expired, "t3-token")).toMatchObject({
      status: "fail",
      reason: expect.stringContaining("expired"),
    });
    const soon = await runChecks(
      deps({
        operatorHealth: async () => ({
          ...healthy,
          tokenExpiresAt: new Date(NOW + 2 * DAY).toISOString(),
        }),
      }),
    );
    expect(check(soon, "t3-token")?.status).toBe("warn");
  });

  it("is healable only when every failing address shows connect-then-close and the listener works", async () => {
    const reboot = await runChecks(deps({ outcomes: ["closed-before-tls", "pong"] }));
    expect(check(reboot, "public-route")).toMatchObject({
      status: "fail",
      reason: expect.stringContaining("203.0.113.1 connected, then closed before any TLS reply"),
    });
    expect(reboot.healable).toBe(true);
    for (const other of [
      "connect-timeout",
      "tls-timeout",
      "connect-failed",
      "tls-failed",
      "wrong-reply",
    ] as const)
      expect((await runChecks(deps({ outcomes: ["closed-before-tls", other] }))).healable).toBe(
        false,
      );
    const listenerDown = await runChecks(
      deps({ outcomes: ["closed-before-tls"], probeLocal: async () => "refused" }),
    );
    expect(listenerDown.healable).toBe(false);
    expect(check(listenerDown, "local-listener")?.status).toBe("fail");
  });

  it("reports, without healing, a missing CLI, funnel or DNS answer", async () => {
    const noCli = await runChecks(deps({ tailscale: async () => ({ ok: false, stdout: "" }) }));
    expect(check(noCli, "public-route")?.reason).toContain("tailscale command");
    const noFunnel = await runChecks(deps({ tailscale: async () => ({ ok: true, stdout: "{}" }) }));
    expect(check(noFunnel, "public-route")?.reason).toContain(
      "no Tailscale Funnel points at 127.0.0.1:8769",
    );
    const noDns = await runChecks(
      deps({ resolve4: async () => Promise.reject(new Error("ENOTFOUND")) }),
    );
    expect(check(noDns, "public-route")?.reason).toContain("public DNS has no IPv4 address");
    expect([noCli, noFunnel, noDns].some((report) => report.healable)).toBe(false);
  });

  it("skips what does not apply and never sends a ping it cannot sign", async () => {
    const noIngress = await runChecks(deps({ ingress: null }));
    expect(check(noIngress, "public-route")?.status).toBe("skip");
    let probed = false;
    const noSecret = await runChecks(
      deps({
        ingress: { port: 8769, ping: async () => null },
        probe: async () => {
          probed = true;
          return "pong";
        },
      }),
    );
    expect(check(noSecret, "local-listener")?.status).toBe("fail");
    expect(probed).toBe(false);
    const notT3 = await runChecks(deps({ operatorHealth: async () => null }));
    expect(check(notT3, "t3")?.status).toBe("skip");
  });
});
