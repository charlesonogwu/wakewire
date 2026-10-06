import type { KeyObject } from "node:crypto";
import DatabaseConstructor, { type Database } from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { verifySignature } from "./crypto.js";
import { openDeployJournal } from "./journal.js";
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

export interface ReviewHostOptions {
  db?: Database;
  remember?(requestId: string): void;
}

export type RoleAuthority = KeyObject | { author: KeyObject; reviewer: KeyObject };

export interface ReviewHostRouter {
  wake(request: WakeRequest): Promise<void>;
  ingestVerdict(verdict: SignedVerdict): SignedVerdict;
}

export function createReviewHostRouter(
  lanes: LaneRecord[],
  transport: T3Transport,
  authority: RoleAuthority,
  options?: ReviewHostOptions,
): ReviewHostRouter {
  const byLane = new Map(lanes.map((lane) => [lane.laneId, lane]));
  const database = options?.db ?? new DatabaseConstructor(":memory:");
  migrate(database);
  const journal = openDeployJournal(database);
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
      if (request.role !== "author" && request.role !== "reviewer") {
        throw new Error("wake role is not a lane role");
      }
      if (journal.issuedWake(request.requestId)) {
        throw new Error(`duplicate request ${request.requestId}`);
      }
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
      journal.issueWake({
        requestId: request.requestId,
        repositoryId: request.repositoryId,
        laneId: request.laneId,
        role: request.role,
        pr: request.pr,
        headSha: request.headSha,
        baseSha: request.baseSha,
        treeHash: request.treeHash,
      });
      options?.remember?.(request.requestId);
    },
    ingestVerdict(verdict) {
      const lane = byLane.get(verdict.laneId);
      if (!lane || lane.repositoryId !== verdict.repositoryId) {
        throw new Error("verdict repository does not match the lane");
      }
      const issued = journal.issuedWake(verdict.requestId);
      if (
        !issued ||
        issued.repositoryId !== verdict.repositoryId ||
        issued.laneId !== verdict.laneId ||
        issued.role !== verdict.role ||
        issued.pr !== verdict.pr ||
        issued.headSha !== verdict.headSha ||
        issued.baseSha !== verdict.baseSha ||
        issued.treeHash !== verdict.treeHash
      ) {
        throw new Error("verdict does not match the issued request");
      }
      const { signature, ...body } = verdict;
      if (!verifySignature(body, signature, keyFor(authority, issued.role))) {
        throw new Error("verdict signature is invalid");
      }
      return verdict;
    },
  };
}

function keyFor(authority: RoleAuthority, role: Role): KeyObject {
  if (!("author" in authority) || !("reviewer" in authority)) return authority;
  return authority[role];
}

function assertClean(request: WakeRequest): void {
  const text = JSON.stringify(request);
  if (SECRET.test(text)) throw new Error("wake record contains secret material");
}
