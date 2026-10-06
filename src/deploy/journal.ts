import type { KeyObject } from "node:crypto";
import type { Database } from "better-sqlite3";
import { verifySignature } from "./crypto.js";
import {
  tryAcquire as acquireFence,
  type FenceResult,
  type FenceState,
  release as releaseFence,
  retain as retainFence,
} from "./fence.js";
import { type GenesisAdapterRecord, verifyGenesisAdapterRecord } from "./genesis.js";
import type { EngineeringOwnerRecord, MergeDecision } from "./types.js";

export interface RawReceipt {
  deliveryId: string;
  repositoryId: string;
  kind: "pull_request" | "review" | "check" | "merge";
  eventId: string;
  mergeSha?: string;
}

export interface OwnerChange {
  repositoryId: string;
  expectedGeneration: number;
  next: EngineeringOwnerRecord;
  genesis: GenesisAdapterRecord | null;
  publicKey: KeyObject;
  rollback: boolean;
  keyId?: string;
}

export interface IntentRecord {
  id: string;
  repositoryId: string;
  mergeSha: string;
  treeHash: string;
  phase: string;
  repairId: string | null;
  previousManifest: string | null;
  targetManifest: string | null;
}

export interface FenceScope {
  repositoryId: string;
  intentId: string;
}

export interface DeployJournal {
  intake(receipt: RawReceipt): void;
  applyDecision(decision: MergeDecision): void;
  pause(repositoryId: string): { repairId: string; notice: string } | null;
  intentId(deliveryId: string): string | null;
  intentRecord(intentId: string): IntentRecord | null;
  beginActivation(intentId: string): void;
  prepareActivation(intentId: string, previousManifest: string, targetManifest: string): void;
  markSettled(intentId: string, phase: string): void;
  pauseForRepair(repositoryId: string, repairId: string, notice: string): void;
  phases(intentId: string): string[];
  enqueueReceipt(id: string, intentId: string | null, kind: string): void;
  acknowledge(receiptId: string): void;
  pendingReceipts(): string[];
  receipt(id: string): { kind: string; acknowledged: boolean } | null;
  tryAcquire(token: number, scope?: FenceScope): FenceResult;
  release(token: number): void;
  retain(token: number, reason: string): void;
  clearFence(): never;
  seedOwner(owner: EngineeringOwnerRecord, pinnedKeyId?: string): void;
  acquireLease(lease: {
    id: string;
    repositoryId: string;
    generation: number;
    kind: "job" | "deployment";
  }): void;
  releaseLease(id: string): void;
  activeDeploymentLease(repositoryId: string): boolean;
  beginDrain(repositoryId: string, expectedGeneration: number): void;
  setActiveDeploys(repositoryId: string, count: number): void;
  completeOwnerChange(change: OwnerChange): void;
  owner(repositoryId: string): EngineeringOwnerRecord | null;
  cursor(repositoryId: string): number;
  disposition(repositoryId: string, eventId: string): string | null;
  recordManifest(intentId: string, hash: string): void;
  currentManifest(repositoryId: string): string | null;
  consumedGenesis(repositoryId: string): {
    mergeEventId: string;
    targetGeneration: number;
    adapterDigest: string | null;
    adapterVersion: string | null;
  } | null;
  advanceCursor(repositoryId: string): number;
}

export function openDeployJournal(db: Database): DeployJournal {
  return {
    intake(receipt) {
      db.prepare(
        "INSERT OR IGNORE INTO deploy_raw_receipts (delivery_id, repository_id, kind, event_id) VALUES (?, ?, ?, ?)",
      ).run(receipt.deliveryId, receipt.repositoryId, receipt.kind, receipt.eventId);
      if (receipt.kind !== "merge") return;
      const row = db
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS max FROM deploy_merges WHERE repository_id = ?",
        )
        .get(receipt.repositoryId) as { max: number };
      db.prepare(
        "INSERT OR IGNORE INTO deploy_merges (repository_id, event_id, sequence, merge_sha) VALUES (?, ?, ?, ?)",
      ).run(receipt.repositoryId, receipt.eventId, row.max + 1, receipt.mergeSha ?? "");
    },
    applyDecision(decision) {
      const run = db.transaction(() => {
        const eventId = decision.eventId ?? decision.deliveryId;
        if (decision.kind === "refuse") {
          db.prepare(
            "INSERT OR REPLACE INTO deploy_pauses (repository_id, repair_id, notice) VALUES (?, ?, ?)",
          ).run(decision.repositoryId, decision.repairId, decision.notice);
          db.prepare(
            `INSERT INTO deploy_dispositions (repository_id, event_id, disposition) VALUES (?, ?, 'refused')
             ON CONFLICT(repository_id, event_id) DO UPDATE SET disposition = excluded.disposition`,
          ).run(decision.repositoryId, eventId);
          return;
        }
        const id = `intent-${decision.deliveryId}`;
        db.prepare(
          `INSERT INTO deploy_intents (id, delivery_id, repository_id, merge_sha, tree_hash, phase, manifest_hash, created_at, repair_id)
           VALUES (?, ?, ?, ?, ?, 'recorded', NULL, ?, ?)`,
        ).run(
          id,
          decision.deliveryId,
          decision.repositoryId,
          decision.mergeSha,
          decision.treeHash,
          new Date().toISOString(),
          decision.repairId,
        );
        db.prepare(
          "INSERT INTO deploy_phases (intent_id, phase, at) VALUES (?, 'recorded', ?)",
        ).run(id, new Date().toISOString());
        db.prepare(
          `INSERT INTO deploy_dispositions (repository_id, event_id, disposition) VALUES (?, ?, 'intent')
           ON CONFLICT(repository_id, event_id) DO UPDATE SET disposition = excluded.disposition`,
        ).run(decision.repositoryId, eventId);
      });
      run();
    },
    pause(repositoryId) {
      const row = db
        .prepare("SELECT repair_id AS repairId, notice FROM deploy_pauses WHERE repository_id = ?")
        .get(repositoryId) as { repairId: string; notice: string } | undefined;
      return row ?? null;
    },
    intentId(deliveryId) {
      const row = db
        .prepare("SELECT id FROM deploy_intents WHERE delivery_id = ?")
        .get(deliveryId) as { id: string } | undefined;
      return row?.id ?? null;
    },
    intentRecord(intentId) {
      const row = db
        .prepare(
          `SELECT id, repository_id, merge_sha, tree_hash, phase, repair_id, previous_manifest, target_manifest
           FROM deploy_intents WHERE id = ?`,
        )
        .get(intentId) as
        | {
            id: string;
            repository_id: string;
            merge_sha: string;
            tree_hash: string;
            phase: string;
            repair_id: string | null;
            previous_manifest: string | null;
            target_manifest: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        repositoryId: row.repository_id,
        mergeSha: row.merge_sha,
        treeHash: row.tree_hash,
        phase: row.phase,
        repairId: row.repair_id,
        previousManifest: row.previous_manifest,
        targetManifest: row.target_manifest,
      };
    },
    prepareActivation(intentId, previousManifest, targetManifest) {
      const row = db.prepare("SELECT id FROM deploy_intents WHERE id = ?").get(intentId);
      if (!row) throw new Error("intent must exist before activation");
      db.prepare(
        `UPDATE deploy_intents SET previous_manifest = ?, target_manifest = ?, phase = 'prepared' WHERE id = ?`,
      ).run(previousManifest, targetManifest, intentId);
      db.prepare("INSERT INTO deploy_phases (intent_id, phase, at) VALUES (?, 'prepared', ?)").run(
        intentId,
        new Date().toISOString(),
      );
    },
    markSettled(intentId, phase) {
      db.prepare("UPDATE deploy_intents SET phase = ? WHERE id = ?").run(phase, intentId);
      db.prepare("INSERT INTO deploy_phases (intent_id, phase, at) VALUES (?, ?, ?)").run(
        intentId,
        phase,
        new Date().toISOString(),
      );
    },
    pauseForRepair(repositoryId, repairId, notice) {
      db.prepare(
        "INSERT OR REPLACE INTO deploy_pauses (repository_id, repair_id, notice) VALUES (?, ?, ?)",
      ).run(repositoryId, repairId, notice);
    },
    beginActivation(intentId) {
      const row = db.prepare("SELECT id FROM deploy_intents WHERE id = ?").get(intentId);
      if (!row) throw new Error("intent must exist before activation");
      db.prepare("UPDATE deploy_intents SET phase = 'activating' WHERE id = ?").run(intentId);
      db.prepare(
        "INSERT INTO deploy_phases (intent_id, phase, at) VALUES (?, 'activating', ?)",
      ).run(intentId, new Date().toISOString());
    },
    phases(intentId) {
      return (
        db
          .prepare("SELECT phase FROM deploy_phases WHERE intent_id = ? ORDER BY rowid")
          .all(intentId) as Array<{
          phase: string;
        }>
      ).map((row) => row.phase);
    },
    enqueueReceipt(id, intentId, kind) {
      db.prepare(
        "INSERT INTO deploy_outbox (id, intent_id, kind, acknowledged) VALUES (?, ?, ?, 0)",
      ).run(id, intentId, kind);
    },
    acknowledge(receiptId) {
      db.prepare("UPDATE deploy_outbox SET acknowledged = 1 WHERE id = ?").run(receiptId);
    },
    pendingReceipts() {
      return (
        db
          .prepare("SELECT id FROM deploy_outbox WHERE acknowledged = 0 ORDER BY rowid")
          .all() as Array<{ id: string }>
      ).map((row) => row.id);
    },
    receipt(id) {
      const row = db.prepare("SELECT kind, acknowledged FROM deploy_outbox WHERE id = ?").get(id) as
        | { kind: string; acknowledged: number }
        | undefined;
      return row ? { kind: row.kind, acknowledged: row.acknowledged === 1 } : null;
    },
    tryAcquire(token, scope) {
      const run = db.transaction(() => {
        const state = readFence(db);
        const next = acquireFence(state, token);
        writeFence(db, next.state);
        if (next.result === "acquired" && scope) {
          db.prepare("UPDATE deploy_fence SET repository_id = ?, intent_id = ? WHERE id = 1").run(
            scope.repositoryId,
            scope.intentId,
          );
        }
        return next.result;
      });
      return run();
    },
    release(token) {
      writeFence(db, releaseFence(readFence(db), token));
    },
    retain(token, reason) {
      writeFence(db, retainFence(readFence(db), token, reason));
    },
    clearFence() {
      throw new Error("fence clear forbidden");
    },
    seedOwner(owner, pinnedKeyId) {
      db.prepare(
        `INSERT INTO deploy_owners
         (repository_id, owner, phase, generation, deployment_activation_enabled, active_jobs, active_deploys, signature, updated_at, pinned_key_id)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      ).run(
        owner.repositoryId,
        owner.owner,
        owner.phase,
        owner.generation,
        owner.deploymentActivationEnabled ? 1 : 0,
        owner.signature,
        owner.updatedAt,
        pinnedKeyId ?? null,
      );
    },
    acquireLease(lease) {
      db.prepare(
        "INSERT INTO deploy_leases (id, repository_id, generation, kind, released) VALUES (?, ?, ?, ?, 0)",
      ).run(lease.id, lease.repositoryId, lease.generation, lease.kind);
    },
    releaseLease(id) {
      db.prepare("UPDATE deploy_leases SET released = 1 WHERE id = ?").run(id);
    },
    activeDeploymentLease(repositoryId) {
      const row = db
        .prepare(
          "SELECT id FROM deploy_leases WHERE repository_id = ? AND kind = 'deployment' AND released = 0",
        )
        .get(repositoryId) as { id: string } | undefined;
      return Boolean(row);
    },
    beginDrain(repositoryId, expectedGeneration) {
      const owner = readOwner(db, repositoryId);
      if (!owner || owner.generation !== expectedGeneration)
        throw new Error("stale owner generation");
      db.prepare("UPDATE deploy_owners SET phase = 'draining' WHERE repository_id = ?").run(
        repositoryId,
      );
    },
    setActiveDeploys(repositoryId, count) {
      db.prepare("UPDATE deploy_owners SET active_deploys = ? WHERE repository_id = ?").run(
        count,
        repositoryId,
      );
    },
    completeOwnerChange(change) {
      const run = db.transaction(() => {
        const owner = readOwner(db, change.repositoryId);
        if (!owner || owner.generation !== change.expectedGeneration)
          throw new Error("stale owner generation");
        if (owner.phase !== "draining") throw new Error("owner change requires draining");
        if (owner.active_deploys > 0 || owner.active_jobs > 0) {
          throw new Error("active transaction blocking ownership change");
        }
        if (change.rollback && readFence(db).fenced)
          throw new Error("uncertainty fence blocking rollback");
        const { signature, ...body } = change.next;
        if (!verifySignature(body, signature, change.publicKey))
          throw new Error("owner signature is invalid");
        if (owner.pinned_key_id && change.keyId !== owner.pinned_key_id) {
          throw new Error("pinned key mismatch");
        }
        if (change.genesis) {
          if (change.genesis.targetGeneration !== change.next.generation) {
            throw new Error("genesis target generation mismatch");
          }
          if (change.genesis.targetGeneration === owner.generation) {
            throw new Error("genesis accepted against the prior generation");
          }
          const consumed = db.prepare("SELECT merge_event_id FROM deploy_genesis").all() as Array<{
            merge_event_id: string;
          }>;
          verifyGenesisAdapterRecord(
            change.genesis,
            change.publicKey,
            new Set(consumed.map((row) => row.merge_event_id)),
            change.repositoryId,
          );
          db.prepare(
            `INSERT INTO deploy_genesis
             (repository_id, merge_event_id, target_generation, adapter_digest, adapter_version)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(
            change.repositoryId,
            change.genesis.mergeEventId,
            change.genesis.targetGeneration,
            change.genesis.adapterDigest,
            change.genesis.adapterVersion,
          );
          db.prepare(
            "INSERT OR REPLACE INTO deploy_dispositions (repository_id, event_id, disposition) VALUES (?, ?, 'bootstrap-consumed')",
          ).run(change.repositoryId, change.genesis.mergeEventId);
        }
        db.prepare(
          `UPDATE deploy_owners
           SET owner = ?, phase = 'stable', generation = ?, deployment_activation_enabled = ?, signature = ?, updated_at = ?, pinned_key_id = COALESCE(?, pinned_key_id)
           WHERE repository_id = ?`,
        ).run(
          change.next.owner,
          change.next.generation,
          change.next.deploymentActivationEnabled ? 1 : 0,
          change.next.signature,
          change.next.updatedAt,
          change.keyId ?? null,
          change.repositoryId,
        );
      });
      run();
    },
    owner(repositoryId) {
      const row = readOwner(db, repositoryId);
      if (!row) return null;
      return {
        repositoryId: row.repository_id,
        owner: row.owner as EngineeringOwnerRecord["owner"],
        phase: row.phase as EngineeringOwnerRecord["phase"],
        generation: row.generation,
        deploymentActivationEnabled: row.deployment_activation_enabled === 1,
        updatedAt: row.updated_at,
        signature: row.signature,
      };
    },
    cursor(repositoryId) {
      const row = db
        .prepare("SELECT sequence FROM deploy_cursors WHERE repository_id = ?")
        .get(repositoryId) as { sequence: number } | undefined;
      return row?.sequence ?? 0;
    },
    disposition(repositoryId, eventId) {
      const row = db
        .prepare(
          "SELECT disposition FROM deploy_dispositions WHERE repository_id = ? AND event_id = ?",
        )
        .get(repositoryId, eventId) as { disposition: string } | undefined;
      return row?.disposition ?? null;
    },
    recordManifest(intentId, hash) {
      db.prepare(
        "UPDATE deploy_intents SET manifest_hash = ?, phase = 'deployed' WHERE id = ?",
      ).run(hash, intentId);
    },
    currentManifest(repositoryId) {
      const row = db
        .prepare(
          "SELECT manifest_hash FROM deploy_intents WHERE repository_id = ? AND manifest_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        )
        .get(repositoryId) as { manifest_hash: string } | undefined;
      return row?.manifest_hash ?? null;
    },
    consumedGenesis(repositoryId) {
      const row = db
        .prepare(
          `SELECT merge_event_id, target_generation, adapter_digest, adapter_version
           FROM deploy_genesis WHERE repository_id = ?`,
        )
        .get(repositoryId) as
        | {
            merge_event_id: string;
            target_generation: number;
            adapter_digest: string | null;
            adapter_version: string | null;
          }
        | undefined;
      return row
        ? {
            mergeEventId: row.merge_event_id,
            targetGeneration: row.target_generation,
            adapterDigest: row.adapter_digest,
            adapterVersion: row.adapter_version,
          }
        : null;
    },
    advanceCursor(repositoryId) {
      const merges = db
        .prepare(
          "SELECT event_id, sequence FROM deploy_merges WHERE repository_id = ? ORDER BY sequence",
        )
        .all(repositoryId) as Array<{ event_id: string; sequence: number }>;
      let cursor = 0;
      for (const merge of merges) {
        const disposition = db
          .prepare(
            "SELECT disposition FROM deploy_dispositions WHERE repository_id = ? AND event_id = ?",
          )
          .get(repositoryId, merge.event_id) as { disposition: string } | undefined;
        if (!disposition) break;
        cursor = merge.sequence;
      }
      db.prepare(
        "INSERT INTO deploy_cursors (repository_id, sequence) VALUES (?, ?) ON CONFLICT(repository_id) DO UPDATE SET sequence = excluded.sequence",
      ).run(repositoryId, cursor);
      return cursor;
    },
  };
}

interface OwnerRow {
  repository_id: string;
  owner: string;
  phase: string;
  generation: number;
  deployment_activation_enabled: number;
  active_jobs: number;
  active_deploys: number;
  signature: string;
  updated_at: string;
  pinned_key_id: string | null;
}

function readOwner(db: Database, repositoryId: string): OwnerRow | undefined {
  return db.prepare("SELECT * FROM deploy_owners WHERE repository_id = ?").get(repositoryId) as
    | OwnerRow
    | undefined;
}

function readFence(db: Database): FenceState {
  const row = db
    .prepare("SELECT token, held, fenced, reason FROM deploy_fence WHERE id = 1")
    .get() as {
    token: number;
    held: number;
    fenced: number;
    reason: string | null;
  };
  return { token: row.token, held: row.held === 1, fenced: row.fenced === 1, reason: row.reason };
}

function writeFence(db: Database, state: FenceState): void {
  db.prepare(
    "UPDATE deploy_fence SET token = ?, held = ?, fenced = ?, reason = ? WHERE id = 1",
  ).run(state.token, state.held ? 1 : 0, state.fenced ? 1 : 0, state.reason);
}
