import type { KeyObject } from "node:crypto";
import { verifySignature } from "./crypto.js";
import type { LaneRecord, Role } from "./types.js";

const SECRET = /ghp_|github_pat_|gho_|BEGIN PRIVATE|\.env/i;

export interface WakeRequest {
  laneId: string;
  role: Role;
  requestId: string;
  repositoryId: string;
  pr: number;
  headSha: string;
  baseSha: string;
  treeHash: string;
}

export interface T3Transport {
  deliver(input: { threadId: string; record: Record<string, string | number> }): Promise<void>;
}

export interface SignedVerdict {
  laneId: string;
  role: Role;
  requestId: string;
  repositoryId: string;
  pr: number;
  decision: "approve" | "reject";
  headSha: string;
  baseSha: string;
  treeHash: string;
  signature: string;
}

export interface ReviewHostHooks {
  remember?(requestId: string): void;
}

export interface ReviewHostRouter {
  wake(request: WakeRequest): Promise<void>;
  ingestVerdict(verdict: SignedVerdict): SignedVerdict;
}

export function createReviewHostRouter(
  lanes: LaneRecord[],
  transport: T3Transport,
  reviewerKey: KeyObject,
  hooks?: ReviewHostHooks,
): ReviewHostRouter {
  const byLane = new Map(lanes.map((lane) => [lane.laneId, lane]));
  const seen = new Set<string>();
  return {
    async wake(request) {
      assertClean(request);
      const lane = byLane.get(request.laneId);
      if (!lane) throw new Error(`unknown lane ${request.laneId}`);
      if (lane.threads.author.threadId === lane.threads.reviewer.threadId) {
        throw new Error(`shared threadId ${lane.threads.author.threadId}`);
      }
      if (request.repositoryId !== lane.repositoryId) {
        throw new Error("wake repository does not match the lane");
      }
      if (seen.has(request.requestId)) throw new Error(`duplicate request ${request.requestId}`);
      const thread = lane.threads[request.role];
      await transport.deliver({
        threadId: thread.threadId,
        record: {
          laneId: request.laneId,
          role: request.role,
          requestId: request.requestId,
          repositoryId: request.repositoryId,
          pr: request.pr,
          headSha: request.headSha,
          baseSha: request.baseSha,
          treeHash: request.treeHash,
        },
      });
      seen.add(request.requestId);
      hooks?.remember?.(request.requestId);
    },
    ingestVerdict(verdict) {
      const { signature, ...body } = verdict;
      if (!verifySignature(body, signature, reviewerKey)) {
        throw new Error("verdict signature is invalid");
      }
      const lane = byLane.get(verdict.laneId);
      if (!lane || lane.repositoryId !== verdict.repositoryId) {
        throw new Error("verdict repository does not match the lane");
      }
      if (verdict.role !== "author" && verdict.role !== "reviewer") {
        throw new Error("verdict role is not a lane role");
      }
      if (!verdict.requestId || verdict.pr < 1) throw new Error("verdict request is unbound");
      return verdict;
    },
  };
}

function assertClean(request: WakeRequest): void {
  const text = JSON.stringify(request);
  if (SECRET.test(text)) throw new Error("wake record contains secret material");
}
