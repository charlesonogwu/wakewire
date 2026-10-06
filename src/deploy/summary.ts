import { fenceSafeText } from "../core/envelope.js";
import type { Candidate } from "./types.js";

export interface OperatorSummary {
  id: string;
  text: string;
  stale: boolean;
  candidate: Candidate;
}

export function renderOperatorSummary(candidate: Candidate, previousId?: string): OperatorSummary {
  const id =
    candidate.summaryId ?? `summary-${candidate.id.pr}-${candidate.id.headSha.slice(0, 12)}`;
  const bound: Candidate = { ...candidate, summaryId: id };
  const text = fenceSafeText(render(bound));
  return { id, text, stale: previousId !== undefined, candidate: bound };
}

function render(candidate: Candidate): string {
  const { repositoryId, pr, headSha, baseSha, treeHash } = candidate.id;
  if (candidate.state === "blocked") {
    return `Blocked for ${repositoryId}#${pr}. missing evidence: ${candidate.blockReason ?? "unspecified"}.`;
  }
  if (candidate.state === "not-worth-merging") {
    return `Repository ${repositoryId} pull ${pr} is not worth merging. head ${headSha} base ${baseSha} tree ${treeHash}.`;
  }
  return `Repository ${repositoryId} pull ${pr} is merge-ready. head ${headSha} base ${baseSha} tree ${treeHash}.`;
}
