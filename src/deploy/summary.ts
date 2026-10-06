import { fenceSafeText } from "../core/envelope.js";
import type { Candidate } from "./types.js";

export interface OperatorSummary {
  id: string;
  text: string;
  stale: boolean;
  candidate: Candidate;
}

export interface SummaryFacts {
  changes: string;
  challenges: string;
  tests: string;
  risks: string;
  deploymentContents: string;
}

export function renderOperatorSummary(
  candidate: Candidate,
  previousId?: string,
  facts?: SummaryFacts,
): OperatorSummary {
  const id =
    candidate.summaryId ?? `summary-${candidate.id.pr}-${candidate.id.headSha.slice(0, 12)}`;
  const bound: Candidate = { ...candidate, summaryId: id };
  const text = fenceSafeText(render(bound, facts));
  return { id, text, stale: previousId !== undefined, candidate: bound };
}

function render(candidate: Candidate, facts?: SummaryFacts): string {
  const { repositoryId, pr, headSha, baseSha, treeHash } = candidate.id;
  if (candidate.state === "blocked") {
    return `Blocked for ${repositoryId}#${pr}. missing evidence: ${candidate.blockReason ?? "unspecified"}.`;
  }
  if (candidate.state === "not-worth-merging") {
    return `Repository ${repositoryId} pull ${pr} is not worth merging. head ${headSha} base ${baseSha} tree ${treeHash}.`;
  }
  if (candidate.state !== "merge-ready") {
    return `Repository ${repositoryId} pull ${pr} is ${candidate.state}. head ${headSha} base ${baseSha} tree ${treeHash}.`;
  }
  if (
    !facts?.changes ||
    !facts.challenges ||
    !facts.tests ||
    !facts.risks ||
    !facts.deploymentContents
  ) {
    throw new Error(
      "merge-ready summary requires changes, challenges, tests, risks, and deployment contents",
    );
  }
  return `Repository ${repositoryId} pull ${pr} is merge-ready. changes ${facts.changes}. challenges ${facts.challenges}. tests ${facts.tests}. risks ${facts.risks}. deployment ${facts.deploymentContents}. head ${headSha} base ${baseSha} tree ${treeHash}.`;
}
