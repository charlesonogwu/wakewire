export type Role = "author" | "reviewer";
export type OwnerHost = "legacy" | "omarchy";
export type OwnerPhase = "stable" | "draining";

export interface ThreadRef {
  projectId: string;
  threadId: string;
}

export interface LaneRecord {
  laneId: string;
  repositoryId: string;
  github: { owner: string; name: string };
  roots: { checkout: string; worktree: string; cache: string };
  threads: Record<Role, ThreadRef>;
  adapterPath: string;
}

export interface EngineeringOwnerRecord {
  repositoryId: string;
  owner: OwnerHost;
  phase: OwnerPhase;
  generation: number;
  deploymentActivationEnabled: boolean;
  updatedAt: string;
  signature: string;
}

export interface CandidateId {
  repositoryId: string;
  pr: number;
  headSha: string;
  baseSha: string;
  treeHash: string;
}

export type CandidateStateName =
  | "triage"
  | "challenging"
  | "merge-ready"
  | "blocked"
  | "not-worth-merging"
  | "invalidated";

export interface Verdict {
  role: Role;
  decision: "approve" | "reject";
  headSha: string;
  baseSha: string;
  treeHash: string;
}

export interface Candidate {
  id: CandidateId;
  draft: boolean;
  state: CandidateStateName;
  verdicts: Verdict[];
  unresolvedFindings: number;
  checks: "success" | "pending" | "cancelled" | "failed" | "unknown";
  summaryId: string | null;
  blockReason: string | null;
}

export type MergeDecision =
  | {
      kind: "intent";
      repositoryId: string;
      repairId: string | null;
      notice: null;
      deliveryId: string;
      eventId?: string;
      mergeSha: string;
      treeHash: string;
      headSha: string;
      baseSha: string;
      pr: number;
    }
  | {
      kind: "refuse";
      repositoryId: string;
      repairId: string;
      notice: string;
      deliveryId: string;
      eventId?: string;
    };

export interface ArtifactFile {
  path: string;
  sha256: string;
  mode: number;
}

export interface ArtifactEnvelope {
  repositoryId: string;
  mergeSha: string;
  treeHash: string;
  adapterVersion: string;
  architecture: string;
  runtimeVersions: Record<string, string>;
  files: ArtifactFile[];
  compatibility: "reversible" | "irreversible";
  signature: string;
}
