import type { KeyObject } from "node:crypto";
import { verifySignature } from "./crypto.js";
import type { ExecuteRequest, ExecuteResult } from "./executor.js";
import type { DeployJournal, OwnerChange, RawReceipt } from "./journal.js";
import { type FreshMerge, scan } from "./reconcile.js";
import type { MergeDecision, OwnerHost } from "./types.js";

export interface SignedEvent extends RawReceipt {
  signature: string;
}

export interface DeploymentTick {
  decisions: number;
  executions: number;
}

export interface DeploymentServiceDeps {
  host: OwnerHost;
  publicKey: KeyObject;
  journal: DeployJournal;
  freshMerges: (repositoryId: string) => FreshMerge[];
  execute: (input?: ExecuteRequest) => ExecuteResult;
  artifactFor?: (
    decision: Extract<MergeDecision, { kind: "intent" }>,
  ) => Omit<
    ExecuteRequest,
    "publicKey" | "journal" | "intentId" | "token" | "receiptId" | "replay"
  >;
  nextToken?: () => number;
}

export interface DeploymentService {
  intake(event: SignedEvent): void;
  tick(repositoryId: string): DeploymentTick;
  bootstrap(change: OwnerChange): void;
}

export function createDeploymentService(deps: DeploymentServiceDeps): DeploymentService {
  return {
    intake(event) {
      const { signature, ...body } = event;
      if (!verifySignature(body, signature, deps.publicKey)) {
        throw new Error("event signature is invalid");
      }
      deps.journal.intake(body);
    },
    tick(repositoryId) {
      const owner = deps.journal.owner(repositoryId);
      if (
        owner?.phase !== "stable" ||
        owner?.owner !== deps.host ||
        !owner?.deploymentActivationEnabled
      ) {
        return { decisions: 0, executions: 0 };
      }
      let decisions = 0;
      let executions = 0;
      const run = (decision: Extract<MergeDecision, { kind: "intent" }>, intentId: string) => {
        const built = deps.artifactFor?.(decision);
        const result = deps.execute(
          built
            ? {
                ...built,
                publicKey: deps.publicKey,
                journal: deps.journal,
                intentId,
                token: (deps.nextToken ?? (() => 1))(),
                receiptId: `receipt-${decision.deliveryId}`,
                replay: false,
              }
            : undefined,
        );
        if (
          result.status === "deployed" ||
          result.status === "nothing-to-deploy" ||
          result.status === "rolled-back" ||
          result.status === "fenced"
        ) {
          deps.journal.markSettled(intentId, result.status);
        }
        executions += 1;
      };
      for (const decision of scan(deps.freshMerges(repositoryId))) {
        if (decision.kind === "intent") {
          const existingId = deps.journal.intentId(decision.deliveryId);
          const existing = existingId ? deps.journal.intentRecord(existingId) : null;
          if (existing && !openPhase(existing.phase)) continue;
          if (existing && existingId) {
            run(decision, existingId);
            deps.journal.advanceCursor(repositoryId);
            continue;
          }
        }
        if (
          decision.kind === "refuse" &&
          deps.journal.pause(decision.repositoryId)?.repairId === decision.repairId
        ) {
          continue;
        }
        deps.journal.applyDecision(decision);
        decisions += 1;
        deps.journal.advanceCursor(repositoryId);
        if (decision.kind !== "intent") continue;
        const intentId = deps.journal.intentId(decision.deliveryId);
        if (!intentId) throw new Error("intent is required");
        run(decision, intentId);
      }
      return { decisions, executions };
    },
    bootstrap(change) {
      const owner = deps.journal.owner(change.repositoryId);
      if (!owner || owner.generation !== change.expectedGeneration) {
        throw new Error("stale owner generation");
      }
      if (
        change.genesis &&
        deps.journal.consumedGenesis(change.repositoryId)?.mergeEventId ===
          change.genesis.mergeEventId
      ) {
        throw new Error("reused genesis record");
      }
      deps.journal.beginDrain(change.repositoryId, change.expectedGeneration);
      deps.journal.completeOwnerChange(change);
    },
  };
}

function openPhase(phase: string): boolean {
  return (
    phase === "recorded" || phase === "prepared" || phase === "activating" || phase === "pending"
  );
}
