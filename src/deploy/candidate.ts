import type { Candidate, CandidateId, Verdict } from "./types.js";

export type CandidateEvent =
  | { type: "evidence" }
  | { type: "verdict"; verdict: Verdict }
  | { type: "base-changed"; baseSha: string }
  | { type: "head-changed"; headSha: string }
  | { type: "checks"; checks: Candidate["checks"] }
  | { type: "findings"; count: number }
  | { type: "timeout" }
  | { type: "unknown" }
  | { type: "blocked"; reason: string }
  | { type: "not-worth-merging"; reason: string };

export function blankCandidate(id: CandidateId): Candidate {
  return {
    id,
    draft: false,
    state: "triage",
    verdicts: [],
    unresolvedFindings: 0,
    checks: "pending",
    summaryId: null,
    blockReason: null,
  };
}

export function advanceCandidate(candidate: Candidate, event: CandidateEvent): Candidate {
  if (event.type === "base-changed") return invalidate(candidate, { baseSha: event.baseSha });
  if (event.type === "head-changed") return invalidate(candidate, { headSha: event.headSha });
  if (candidate.state === "not-worth-merging") return candidate;
  if (candidate.state === "blocked" && event.type !== "not-worth-merging") return candidate;
  if (event.type === "evidence") return { ...candidate, state: "challenging" };
  if (event.type === "checks") {
    const next = { ...candidate, checks: event.checks };
    if (event.checks === "cancelled" || event.checks === "failed" || event.checks === "unknown") {
      return block(next, `checks ${event.checks}`);
    }
    return promote(next);
  }
  if (event.type === "findings") {
    const next = { ...candidate, unresolvedFindings: event.count };
    return event.count > 0 ? block(next, "unresolved findings") : promote(next);
  }
  if (event.type === "timeout" || event.type === "unknown") return block(candidate, event.type);
  if (event.type === "blocked") return block(candidate, event.reason);
  if (event.type === "not-worth-merging") {
    return { ...candidate, state: "not-worth-merging", blockReason: event.reason };
  }
  const verdicts = candidate.verdicts.filter((item) => item.role !== event.verdict.role);
  return promote({ ...candidate, verdicts: [...verdicts, event.verdict] });
}

function invalidate(candidate: Candidate, patch: Partial<CandidateId>): Candidate {
  return {
    ...candidate,
    id: { ...candidate.id, ...patch, treeHash: "" },
    state: "invalidated",
    verdicts: [],
    checks: "pending",
    unresolvedFindings: 0,
    summaryId: null,
    blockReason: null,
  };
}

function block(candidate: Candidate, reason: string): Candidate {
  return { ...candidate, state: "blocked", blockReason: reason };
}

function promote(candidate: Candidate): Candidate {
  if (!canReady(candidate)) {
    if (
      candidate.state === "triage" ||
      candidate.state === "invalidated" ||
      candidate.state === "merge-ready"
    ) {
      return { ...candidate, state: "challenging" };
    }
    return candidate;
  }
  return { ...candidate, state: "merge-ready", blockReason: null };
}

function canReady(candidate: Candidate): boolean {
  if (
    candidate.id.headSha.length === 0 ||
    candidate.id.baseSha.length === 0 ||
    candidate.id.treeHash.length === 0
  ) {
    return false;
  }
  if (candidate.draft || candidate.unresolvedFindings > 0 || candidate.checks !== "success")
    return false;
  const approved = (role: Verdict["role"]) =>
    candidate.verdicts.some(
      (verdict) =>
        verdict.role === role &&
        verdict.decision === "approve" &&
        verdict.headSha === candidate.id.headSha &&
        verdict.baseSha === candidate.id.baseSha &&
        verdict.treeHash === candidate.id.treeHash,
    );
  return approved("author") && approved("reviewer");
}
