import { existsSync } from "node:fs";
import { type Command, command } from "../prepush/process.js";
import type { Funnel } from "./route.js";

const WINDOWS_DEFAULT = "C:\\Program Files\\Tailscale\\tailscale.exe";

/** WAKEWIRE_TAILSCALE_PATH, else the Windows install location, else `tailscale` on PATH. */
export function tailscaleBinary(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.WAKEWIRE_TAILSCALE_PATH) return env.WAKEWIRE_TAILSCALE_PATH;
  if (platform === "win32" && exists(WINDOWS_DEFAULT)) return WINDOWS_DEFAULT;
  return "tailscale";
}

/** Runs one tailscale command; only the exit status and stdout come back, never error text. */
export type Tailscale = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

export function createTailscale(binary = tailscaleBinary(), run: Command = command): Tailscale {
  return async (args) => {
    const result = await run(binary, args, { timeout: 30_000 });
    return { ok: result.code === 0, stdout: result.stdout };
  };
}

/** `tailscale serve status --json`, or null when the CLI is unavailable or the output is not JSON. */
export async function serveStatus(tailscale: Tailscale): Promise<unknown | null> {
  const result = await tailscale(["serve", "status", "--json"]);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/** BackendState from `tailscale status --json` ("Running", "NeedsLogin", ...), or null. */
export async function backendState(tailscale: Tailscale): Promise<string | null> {
  const result = await tailscale(["status", "--json"]);
  if (!result.ok) return null;
  try {
    const state = (JSON.parse(result.stdout) as { BackendState?: unknown }).BackendState;
    return typeof state === "string" && /^[A-Za-z]{1,32}$/.test(state) ? state : null;
  } catch {
    return null;
  }
}

/** Key-sorted JSON, so two serve configs compare by content rather than key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

export type ToggleResult =
  /** Off and on both succeeded; `identical` compares the whole serve config before and after. */
  | { outcome: "toggled"; identical: boolean; before: string; after: string | null }
  /** "off" failed, so nothing was changed. */
  | { outcome: "off-failed" }
  /** "off" worked but "on" failed twice: the public route is gone until someone restores it. */
  | { outcome: "route-removed"; before: string; restore: string }
  | { outcome: "status-unavailable" }
  /** Tailscale itself is down or logged out (e.g. key expiry): toggling could only make it worse. */
  | { outcome: "not-running"; state: string };

/**
 * The one proven fix: turn this port's funnel off and on again with the target
 * Tailscale already holds. Nothing else in the serve config is touched.
 */
export async function toggleFunnel(tailscale: Tailscale, funnel: Funnel): Promise<ToggleResult> {
  const state = await backendState(tailscale);
  if (state !== "Running") return { outcome: "not-running", state: state ?? "unknown" };
  const before = await serveStatus(tailscale);
  if (before === null) return { outcome: "status-unavailable" };
  const port = `--https=${funnel.port}`;
  if (!(await tailscale(["funnel", port, "off"])).ok) return { outcome: "off-failed" };
  const on = ["funnel", "--bg", port, funnel.target];
  if (!(await tailscale(on)).ok && !(await tailscale(on)).ok)
    return {
      outcome: "route-removed",
      before: canonicalJson(before),
      restore: `tailscale ${on.join(" ")}`,
    };
  const after = await serveStatus(tailscale);
  return {
    outcome: "toggled",
    identical: after !== null && canonicalJson(after) === canonicalJson(before),
    before: canonicalJson(before),
    after: after === null ? null : canonicalJson(after),
  };
}
