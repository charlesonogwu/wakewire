import fs from "node:fs";
import type { DaemonState } from "./daemon/daemon.js";
import { stateFilePath } from "./paths.js";

/** Shared by the CLI and the MCP server to talk to the daemon's localhost API. */

export class DaemonNotRunningError extends Error {
  constructor(detail = "") {
    super(
      `wakewire daemon is not running${detail ? ` (${detail})` : ""}. Start it with: wakewire start`,
    );
  }
}

export function readDaemonState(): DaemonState | null {
  try {
    const state = JSON.parse(fs.readFileSync(stateFilePath(), "utf8")) as DaemonState;
    if (!state.port || !state.token) return null;
    return state;
  } catch {
    return null;
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type PidAlive = (pid: number) => boolean;

export type DaemonInspection =
  | { status: "reachable" }
  | { status: "stale"; detail: string }
  | { status: "foreign"; detail: string }
  | { status: "uncertain"; detail: string };

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function timedRequest<T>(
  request: FetchLike,
  url: string,
  init: RequestInit,
  readResponse: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await request(url, { ...init, signal: controller.signal });
    return await readResponse(response, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    return {};
  }
}

class IdentityMismatchError extends Error {}

class IdentityUnavailableError extends Error {}

async function verifyPublicIdentity(state: DaemonState, request: FetchLike): Promise<void> {
  if (!state.instanceId) {
    throw new IdentityUnavailableError("daemon state has no verifiable instance identity");
  }
  const identity = await timedRequest(
    request,
    `http://127.0.0.1:${state.port}/api/identity`,
    {},
    async (response) => ({ response, body: response.ok ? await response.json() : undefined }),
  );
  if (!identity.response.ok) {
    throw new IdentityUnavailableError("identity endpoint did not verify this daemon");
  }
  const body = identity.body as { service?: unknown; instanceId?: unknown; pid?: unknown };
  if (
    body.service !== "wakewire" ||
    body.instanceId !== state.instanceId ||
    body.pid !== state.pid
  ) {
    throw new IdentityMismatchError("daemon identity does not match the saved state");
  }
}

/**
 * A PID alone is not daemon identity: operating systems reuse PIDs after a
 * crash. Verify the non-secret instance identity first, then authenticate the
 * saved localhost endpoint before start/stop/status trusts the state file.
 */
export async function inspectDaemonState(
  state: DaemonState,
  request: FetchLike = fetch,
  pidAlive: PidAlive = processIsAlive,
): Promise<DaemonInspection> {
  if (!pidAlive(state.pid)) return { status: "stale", detail: "saved process no longer exists" };
  if (!state.instanceId) {
    return { status: "uncertain", detail: "legacy state has no verifiable instance identity" };
  }
  try {
    try {
      await verifyPublicIdentity(state, request);
    } catch (error) {
      if (error instanceof IdentityMismatchError) {
        return { status: "foreign", detail: "saved endpoint belongs to another process" };
      }
      throw error;
    }
    const health = await timedRequest(
      request,
      `http://127.0.0.1:${state.port}/api/health`,
      { headers: { authorization: `Bearer ${state.token}` } },
      async (response, signal) => ({ response, body: await readJson(response, signal) }),
    );
    if (!health.response.ok) {
      return { status: "uncertain", detail: "authenticated health was rejected" };
    }
    const body = health.body as { status?: unknown; instanceId?: unknown; pid?: unknown };
    return body.status === "ok" && body.instanceId === state.instanceId && body.pid === state.pid
      ? { status: "reachable" }
      : { status: "uncertain", detail: "authenticated health identity changed" };
  } catch {
    return { status: "uncertain", detail: "saved process is alive but its API did not respond" };
  }
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export async function apiFetch<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const state = readDaemonState();
  if (!state) throw new DaemonNotRunningError("no state file");
  try {
    await verifyPublicIdentity(state, fetch);
    const result = await timedRequest(
      fetch,
      `http://127.0.0.1:${state.port}${path}`,
      {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${state.token}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      async (response, signal) => ({ response, body: await readJson(response, signal) }),
    );
    return { status: result.response.status, body: result.body as T };
  } catch (err) {
    throw new DaemonNotRunningError(err instanceof Error ? err.message : String(err));
  }
}
