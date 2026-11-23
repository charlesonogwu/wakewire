import type { CompletionJobStatus } from "../coordination/completion.js";
import type { WakeEvent } from "../core/event.js";
import type { SandboxPolicy } from "../core/route.js";

export interface DeliveryOptions {
  /** Original persisted event, required by fresh-snapshot coordination gates. */
  event?: WakeEvent | undefined;
  /** Durable queue identity, required by owner-routed Desktop delivery. */
  deliveryId?: string | undefined;
  sandbox: SandboxPolicy;
  /** Working directory override (used for new threads; ignored for resume by some adapters). */
  cwd?: string | undefined;
}

export interface DeliveryResult {
  threadId: string;
  turnId?: string | undefined;
  /** Final agent message when the adapter runs the turn to completion (SDK/exec adapters). */
  finalResponse?: string | undefined;
}

/**
 * The one seam between wakewire and any coding agent. v1 ships Codex
 * implementations only; a Claude Code adapter would implement this interface.
 */
export interface AgentAdapter {
  readonly name: string;
  readonly supportsCoalescing?: boolean;
  readonly supportsNewThreads?: boolean;
  /** Append a turn to an existing thread. */
  deliverToThread(threadId: string, prompt: string, opts: DeliveryOptions): Promise<DeliveryResult>;
  /** Start a new thread in opts.cwd and send the prompt as its first turn. */
  startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult>;
  /** Cheap reachability check — used to decide held-vs-failed and for status reporting. */
  probe(): Promise<boolean>;
  /** Sanitized metadata; never exposes prompts or task identifiers. */
  coordinationJobs?(): CompletionJobStatus[];
  /** Self-test: per-target reachability plus token expiry; null when the adapter has no such view. */
  operatorHealth?(): Promise<OperatorHealth | null>;
  /** Self-test: one short operator notice (idempotent per clientRequestId); false when unsupported. */
  notifyOperator?(message: string, clientRequestId: string): Promise<boolean>;
  /** Release connections/child processes on daemon shutdown. */
  close?(): void | Promise<void>;
}

/**
 * Why a registered target could not be verified. "auth" needs Charles to re-approve
 * (`wakewire t3 login`); "api-changed" needs a code change; neither is ever self-healed.
 */
export type TargetProblem = "auth" | "api-changed" | "mismatch" | "unreachable";

export interface OperatorHealth {
  targets: { threadId: string; ok: boolean; problem?: TargetProblem }[];
  /** Expiry of the stored access token (never the token); null when there is none. */
  tokenExpiresAt: string | null;
}

/** The target thread has a turn in flight. Retry later; never a failure. */
export class BusyError extends Error {}

/** Codex (app-server or CLI) is not reachable. Retry with backoff, forever. */
export class UnreachableError extends Error {}

/** Delivery can never succeed (unknown thread, invalid target). Fail immediately. */
export class PermanentError extends Error {}
