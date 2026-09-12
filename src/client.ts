import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { DaemonState } from "./daemon/daemon.js";
import {
  acquireExclusiveOwnership,
  pidIsAlive,
  releaseExclusiveOwnership,
} from "./exclusive-ownership.js";
import { daemonLockFilePath, stateFilePath } from "./paths.js";

/** Shared by the CLI and the MCP server to talk to the daemon's localhost API. */

export class DaemonNotRunningError extends Error {
  constructor(detail = "") {
    super(
      `wakewire daemon is not running${detail ? ` (${detail})` : ""}. Start it with: wakewire start`,
    );
    this.name = "DaemonNotRunningError";
  }
}

export class DaemonIdentityError extends Error {
  constructor(detail: string) {
    super(`cannot verify wakewire daemon identity (${detail})`);
    this.name = "DaemonIdentityError";
  }
}

export class DaemonRequestUncertainError extends Error {
  constructor(detail: string) {
    super(
      `daemon mutation outcome is uncertain; it may have been applied (${detail}); not retrying`,
    );
    this.name = "DaemonRequestUncertainError";
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

function sameDaemonState(left: DaemonState, right: DaemonState): boolean {
  return (
    left.pid === right.pid &&
    left.port === right.port &&
    left.token === right.token &&
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt &&
    left.version === right.version
  );
}

/** Remove an inspected state only while exclusively excluding daemon publication. */
export function removeDaemonStateIfCurrent(inspected: DaemonState): boolean {
  const owner = { pid: process.pid, instanceId: `cleanup-${randomUUID()}` };
  let handle: number;
  try {
    handle = acquireExclusiveOwnership(daemonLockFilePath(), owner);
  } catch {
    return false;
  }
  try {
    const current = readDaemonState();
    if (!current || !sameDaemonState(current, inspected)) return false;
    fs.rmSync(stateFilePath());
    return true;
  } finally {
    releaseExclusiveOwnership(daemonLockFilePath(), handle, owner);
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type PidAlive = (pid: number) => boolean;

export type DaemonInspection =
  | { status: "reachable" }
  | { status: "stale"; detail: string }
  | { status: "foreign"; detail: string }
  | { status: "uncertain"; detail: string };

async function timedRequest<T>(
  request: FetchLike,
  url: string,
  init: RequestInit,
  readResponse: (response: Response, signal: AbortSignal) => Promise<T>,
  deadlineMs = 1_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await request(url, { ...init, signal: controller.signal });
    return await readResponse(response, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`request timed out after ${deadlineMs}ms`);
    throw error;
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
  pidAlive: PidAlive = pidIsAlive,
): Promise<DaemonInspection> {
  let alive: boolean;
  try {
    alive = pidAlive(state.pid);
  } catch (error) {
    alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (!alive) return { status: "stale", detail: "saved process no longer exists" };
  if (!state.instanceId) {
    return { status: "uncertain", detail: "legacy state has no verifiable instance identity" };
  }
  try {
    await verifyPublicIdentity(state, request);
    return { status: "reachable" };
  } catch (error) {
    if (error instanceof IdentityMismatchError) {
      return { status: "foreign", detail: "saved endpoint belongs to another process" };
    }
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
  } catch (error) {
    throw new DaemonIdentityError(error instanceof Error ? error.message : String(error));
  }
  const method = (init.method ?? "GET").toUpperCase();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  try {
    const result = await timedRequest(
      fetch,
      `http://127.0.0.1:${state.port}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${state.token}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      async (response, signal) => ({
        response,
        body: mutation ? await response.json() : await readJson(response, signal),
      }),
      mutation ? 2_000 : 5_000,
    );
    return { status: result.response.status, body: result.body as T };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (mutation) throw new DaemonRequestUncertainError(detail);
    throw new DaemonNotRunningError(detail);
  }
}
