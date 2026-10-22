import { T3_EXPIRY_WARNING_DAYS } from "../sinks/t3-expiry.js";
import { daysLeft } from "../sinks/t3-token.js";
import type { OperatorHealth, TargetProblem } from "../sinks/types.js";
import {
  type Funnel,
  findFunnel,
  type ProbeOutcome,
  probeAddress,
  probeLocal,
  resolvePublicV4,
  type SignedPing,
} from "./route.js";
import { serveStatus, type Tailscale } from "./tailscale.js";

export type CheckName = "t3" | "t3-token" | "local-listener" | "public-route";
export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  /** Plain English: what is true now. */
  reason: string;
  /** Plain English: what a human must do, when WakeWire cannot. */
  human?: string;
}

export interface SelftestReport {
  at: string;
  checks: CheckResult[];
  /** The public route shows exactly the proven-fixable failure while the local listener works. */
  healable: boolean;
  funnel: Funnel | null;
}

export interface CheckDeps {
  operatorHealth(): Promise<OperatorHealth | null>;
  /** Null when no dedicated GitHub ingress is configured. */
  ingress: { port: number; ping(): Promise<SignedPing | null> } | null;
  tailscale: Tailscale;
  resolve4?(host: string): Promise<string[]>;
  probe?(address: string, funnel: Funnel, ping: SignedPing): Promise<ProbeOutcome>;
  probeLocal?(
    port: number,
    ping: SignedPing,
  ): Promise<"pong" | "refused" | "timeout" | "wrong-reply">;
  now?: () => number;
}

const PROBLEM: Record<TargetProblem, { reason: string; human: string }> = {
  auth: {
    reason: "T3 access is missing, expired or was revoked",
    human: "Charles runs `wakewire t3 login` and approves it in T3.",
  },
  "api-changed": {
    reason: "T3 no longer offers a tool WakeWire needs (a T3 API change)",
    human: "A WakeWire code change is needed; WakeWire never rewrites its own code.",
  },
  mismatch: {
    reason: "a registered thread or project no longer matches T3 (archived, moved or deleted)",
    human: "Re-register the thread in WakeWire's T3 registration.",
  },
  unreachable: {
    reason: "T3 did not answer (not running, or still starting)",
    human: "Check that T3 Code is running; WakeWire checks again on its own.",
  },
};

async function t3Checks(deps: CheckDeps): Promise<CheckResult[]> {
  let health: OperatorHealth | null;
  try {
    health = await deps.operatorHealth();
  } catch {
    health = { targets: [], tokenExpiresAt: null };
  }
  if (!health)
    return [
      { name: "t3", status: "skip", reason: "this adapter is not T3" },
      { name: "t3-token", status: "skip", reason: "this adapter is not T3" },
    ];
  const failing = health.targets.filter((target) => !target.ok);
  const problem =
    failing.find((target) => target.problem === "auth")?.problem ??
    failing.find((target) => target.problem === "api-changed")?.problem ??
    failing[0]?.problem ??
    (health.targets.length === 0 ? "unreachable" : undefined);
  const t3: CheckResult = problem
    ? {
        name: "t3",
        status: "fail",
        reason: `${PROBLEM[problem].reason} (${failing.length || 1} of ${health.targets.length || 1} registered threads)`,
        human: PROBLEM[problem].human,
      }
    : {
        name: "t3",
        status: "pass",
        reason: `T3 answered for all ${health.targets.length} registered threads`,
      };
  const now = (deps.now ?? Date.now)();
  const expires = health.tokenExpiresAt;
  let token: CheckResult;
  if (!expires)
    token = {
      name: "t3-token",
      status: "fail",
      reason: "there is no usable T3 access token",
      human: PROBLEM.auth.human,
    };
  else if (Date.parse(expires) <= now)
    token = {
      name: "t3-token",
      status: "fail",
      reason: `T3 access expired on ${expires.slice(0, 10)}`,
      human: PROBLEM.auth.human,
    };
  else
    token = {
      name: "t3-token",
      status: daysLeft(expires, now) < T3_EXPIRY_WARNING_DAYS ? "warn" : "pass",
      reason: `T3 access is valid until ${expires.slice(0, 10)} (${daysLeft(expires, now)} days)`,
    };
  return [t3, token];
}

const OUTCOME: Record<Exclude<ProbeOutcome, "pong">, string> = {
  "closed-before-tls": "connected, then closed before any TLS reply",
  "connect-failed": "refused or unreachable",
  "connect-timeout": "no connection within 10 seconds",
  "tls-timeout": "connected, but no TLS reply within 10 seconds",
  "tls-failed": "TLS handshake failed",
  "wrong-reply": "answered, but not with this daemon's pong",
};

async function routeChecks(
  deps: CheckDeps,
): Promise<{ checks: CheckResult[]; healable: boolean; funnel: Funnel | null }> {
  if (!deps.ingress)
    return {
      checks: [
        { name: "local-listener", status: "skip", reason: "no dedicated GitHub ingress is set up" },
        { name: "public-route", status: "skip", reason: "no dedicated GitHub ingress is set up" },
      ],
      healable: false,
      funnel: null,
    };
  const { port } = deps.ingress;
  const ping = await deps.ingress.ping().catch(() => null);
  if (!ping) {
    const reason = "the GitHub source has no webhook secret, so it cannot sign a test ping";
    const human = "Set the GitHub webhook secret with `wakewire auth webhook`.";
    return {
      checks: [
        { name: "local-listener", status: "fail", reason, human },
        { name: "public-route", status: "skip", reason },
      ],
      healable: false,
      funnel: null,
    };
  }
  const localOutcome = await (deps.probeLocal ?? probeLocal)(port, ping);
  const local: CheckResult =
    localOutcome === "pong"
      ? {
          name: "local-listener",
          status: "pass",
          reason: `127.0.0.1:${port} answered the signed ping`,
        }
      : {
          name: "local-listener",
          status: "fail",
          reason: `127.0.0.1:${port} did not answer the signed ping (${localOutcome})`,
          human: "Restart the WakeWire daemon.",
        };
  const status = await serveStatus(deps.tailscale);
  if (status === null)
    return {
      checks: [
        local,
        {
          name: "public-route",
          status: "fail",
          reason: "the tailscale command did not answer `serve status`",
          human: "Check that Tailscale is installed and running.",
        },
      ],
      healable: false,
      funnel: null,
    };
  const funnel = findFunnel(status, port);
  if (!funnel)
    return {
      checks: [
        local,
        {
          name: "public-route",
          status: "fail",
          reason: `no Tailscale Funnel points at 127.0.0.1:${port}`,
          human: `Turn the funnel back on (tailscale funnel --bg --https=<port> http://127.0.0.1:${port}).`,
        },
      ],
      healable: false,
      funnel: null,
    };
  let addresses: string[];
  try {
    addresses = await (deps.resolve4 ?? resolvePublicV4)(funnel.host);
  } catch {
    addresses = [];
  }
  if (addresses.length === 0)
    return {
      checks: [
        local,
        {
          name: "public-route",
          status: "fail",
          reason: `public DNS has no IPv4 address for ${funnel.host}`,
          human: "Usually DNS or Tailscale is still coming up; WakeWire checks again on its own.",
        },
      ],
      healable: false,
      funnel,
    };
  const probe = deps.probe ?? probeAddress;
  const outcomes = await Promise.all(
    addresses.map(async (address) => ({ address, outcome: await probe(address, funnel, ping) })),
  );
  // Sorted, so the same fault always reads the same and is reported once.
  const bad = outcomes
    .filter((item) => item.outcome !== "pong")
    .sort((a, b) => a.address.localeCompare(b.address));
  const where = `${funnel.host}:${funnel.port}`;
  if (bad.length === 0)
    return {
      checks: [
        local,
        {
          name: "public-route",
          status: "pass",
          reason: `all ${outcomes.length} public addresses for ${where} reached this daemon`,
        },
      ],
      healable: false,
      funnel,
    };
  const healable =
    local.status === "pass" && bad.every((item) => item.outcome === "closed-before-tls");
  return {
    checks: [
      local,
      {
        name: "public-route",
        status: "fail",
        reason: `${bad.length} of ${outcomes.length} public addresses for ${where} failed: ${bad
          .map((item) => `${item.address} ${OUTCOME[item.outcome as keyof typeof OUTCOME]}`)
          .join("; ")}`,
        human: healable
          ? "None yet: this is the known Tailscale Funnel fault WakeWire can fix itself."
          : "Check Tailscale Funnel and the network; this failure is reported, not self-healed.",
      },
    ],
    healable,
    funnel,
  };
}

/** Runs every check. Never throws; never sends anything except the signed pings. */
export async function runChecks(deps: CheckDeps): Promise<SelftestReport> {
  const [t3, route] = await Promise.all([t3Checks(deps), routeChecks(deps)]);
  return {
    at: new Date((deps.now ?? Date.now)()).toISOString(),
    checks: [...t3, ...route.checks],
    healable: route.healable,
    funnel: route.funnel,
  };
}
