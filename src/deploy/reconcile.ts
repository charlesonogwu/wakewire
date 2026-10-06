import type { MergeDecision } from "./types.js";

export interface FreshMerge {
  deliveryId: string;
  repositoryId: string;
  kind: "pull_request_merged" | "push";
  mergedBy: string;
  expectedOperator: string;
  pr: number | null;
  headSha: string;
  reviewedHeadSha: string;
  baseSha: string;
  reviewedBaseSha: string;
  treeHash: string;
  reviewedTreeHash: string;
  mergeSha: string;
  newerReleaseActivated: boolean;
  authorApproved?: boolean;
  reviewerApproved?: boolean;
  checks?: "success" | "pending" | "failed" | "cancelled" | "unknown";
  eventId?: string;
  repairId?: string | null;
}

export function scanMerge(
  merge: FreshMerge,
  seen = new Map<string, MergeDecision>(),
): MergeDecision {
  const previous = seen.get(merge.deliveryId);
  if (previous) return previous;
  const decision = decide(merge);
  seen.set(merge.deliveryId, decision);
  return decision;
}

export function scan(
  merges: readonly FreshMerge[],
  seen = new Map<string, MergeDecision>(),
): MergeDecision[] {
  return merges.map((merge) => scanMerge(merge, seen));
}

function decide(merge: FreshMerge): MergeDecision {
  const refuse = (notice: string): MergeDecision => ({
    kind: "refuse",
    repositoryId: merge.repositoryId,
    repairId: `repair-${merge.deliveryId}`,
    notice,
    deliveryId: merge.deliveryId,
  });
  if (merge.kind !== "pull_request_merged" || merge.pr === null)
    return refuse("direct push is not a reviewed merge");
  if (merge.mergedBy !== merge.expectedOperator) return refuse("operator actor mismatch");
  if (merge.headSha !== merge.reviewedHeadSha) return refuse("reviewed head mismatch");
  if (merge.baseSha !== merge.reviewedBaseSha) return refuse("reviewed base moved");
  if (merge.treeHash !== merge.reviewedTreeHash) return refuse("merge tree mismatch");
  if (merge.newerReleaseActivated) return refuse("older release suppressed");
  if (
    merge.authorApproved !== true ||
    merge.reviewerApproved !== true ||
    merge.checks !== "success"
  ) {
    return refuse("candidate approvals or checks are not current");
  }
  return {
    kind: "intent",
    repositoryId: merge.repositoryId,
    repairId: merge.repairId ?? null,
    notice: null,
    deliveryId: merge.deliveryId,
    ...(merge.eventId ? { eventId: merge.eventId } : {}),
    mergeSha: merge.mergeSha,
    treeHash: merge.treeHash,
    headSha: merge.headSha,
    baseSha: merge.baseSha,
    pr: merge.pr,
  };
}
