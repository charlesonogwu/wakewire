import type { KeyObject } from "node:crypto";
import { verifySignature } from "./crypto.js";
import type { ExecuteRequest, ExecuteResult } from "./executor.js";
import type { DeployJournal, OpenIntent, OwnerChange, RawReceipt } from "./journal.js";
import { type FreshMerge, scan } from "./reconcile.js";
import { type RuntimeObserverProvider, trustedRuntimeObservation } from "./runtime-observer.js";
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
  ) => Omit<ExecuteRequest, "journal" | "intentId" | "token" | "receiptId" | "replay">;
  nextToken?: () => number;
  deliverReceipt?: (receiptId: string) => boolean;
  runtimeObserverFor?: RuntimeObserverProvider;
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
      const interrupted = deps.journal.interruptedDeployment(repositoryId);
      if (interrupted) {
        const observe = trustedRuntimeObservation(
          deps.journal,
          repositoryId,
          deps.runtimeObserverFor,
        );
        const result = deps.journal.reconcileInterrupted(interrupted, observe);
        if (result === "fenced") return { decisions: 0, executions: 0 };
        if (result === "idle")
          throw new Error("interrupted deployment changed during reconciliation");
      }
      let decisions = 0;
      let executions = 0;
      if (deps.deliverReceipt) {
        for (const receiptId of deps.journal.pendingReceipts()) {
          if (deps.deliverReceipt(receiptId)) deps.journal.acknowledge(receiptId);
        }
      }
      const executed = new Set<string>();
      const run = (decision: Extract<MergeDecision, { kind: "intent" }>, intentId: string) => {
        if (executed.has(intentId)) return;
        executed.add(intentId);
        const built = deps.artifactFor?.(decision);
        const result = deps.execute(
          built
            ? {
                ...built,
                journal: deps.journal,
                intentId,
                token: deps.nextToken
                  ? deps.nextToken()
                  : deps.journal.nextToken(decision.repositoryId),
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
        if (
          (result.status === "deployed" || result.status === "nothing-to-deploy") &&
          decision.repairId
        ) {
          const pause = deps.journal.pause(decision.repositoryId);
          if (pause?.repairId === decision.repairId) {
            deps.journal.clearPause(decision.repositoryId, pause.repairId);
          }
        }
        executions += 1;
      };
      const merges = deps.freshMerges(repositoryId);
      for (const merge of merges) {
        if (merge.repositoryId !== repositoryId) {
          throw new Error("scan repository does not match the tick repository");
        }
      }
      for (const decision of scan(merges)) {
        if (decision.repositoryId !== repositoryId) {
          throw new Error("scan repository does not match the tick repository");
        }
        if (
          decision.eventId &&
          deps.journal.disposition(repositoryId, decision.eventId) === "bootstrap-consumed"
        ) {
          continue;
        }
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
      for (const open of deps.journal.openIntents(repositoryId)) {
        if (executed.has(open.id) || !openPhase(open.phase)) continue;
        run(intentFromOpen(open), open.id);
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

function intentFromOpen(open: OpenIntent): Extract<MergeDecision, { kind: "intent" }> {
  return {
    kind: "intent",
    repositoryId: open.repositoryId,
    repairId: open.repairId,
    notice: null,
    deliveryId: open.deliveryId,
    mergeSha: open.mergeSha,
    treeHash: open.treeHash,
    headSha: open.headSha,
    baseSha: open.baseSha,
    pr: open.pr,
  };
}

function openPhase(phase: string): boolean {
  return (
    phase === "recorded" || phase === "prepared" || phase === "activating" || phase === "pending"
  );
}
