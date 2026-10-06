import type { Database } from "better-sqlite3";

export interface RecoveryEvidence {
  repositoryId: string;
  intentId: string;
  token: number;
}

export function recover(
  db: Database,
  evidence: RecoveryEvidence,
  observe: () => string,
): "cleared" | "fenced" {
  const intent = db
    .prepare(
      "SELECT repository_id, manifest_hash, target_manifest FROM deploy_intents WHERE id = ?",
    )
    .get(evidence.intentId) as
    | { repository_id: string; manifest_hash: string | null; target_manifest: string | null }
    | undefined;
  if (!intent || intent.repository_id !== evidence.repositoryId) return "fenced";
  const observedRuntime = observe();
  const matches =
    observedRuntime.length > 0 &&
    (observedRuntime === intent.manifest_hash || observedRuntime === intent.target_manifest);
  if (!matches) return "fenced";
  const run = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE deploy_fence
         SET held = 0, fenced = 0, reason = NULL
         WHERE id = 1 AND fenced = 1 AND token = ? AND repository_id = ? AND intent_id = ?`,
      )
      .run(evidence.token, evidence.repositoryId, evidence.intentId);
    if (result.changes !== 1) return "fenced" as const;
    releaseMatchingDeploymentLease(db, evidence);
    return "cleared" as const;
  });
  return run();
}

export function recoverObserved(
  db: Database,
  evidence: RecoveryEvidence,
  observe: () => string,
): "cleared" | "fenced" {
  return recover(db, evidence, observe);
}

export function reconcileRestart(
  db: Database,
  evidence: RecoveryEvidence,
  observe: () => string,
): "finished" | "rolled-back" | "fenced" | "idle" {
  const fence = db
    .prepare("SELECT token, held, fenced, repository_id, intent_id FROM deploy_fence WHERE id = 1")
    .get() as {
    token: number;
    held: number;
    fenced: number;
    repository_id: string | null;
    intent_id: string | null;
  };
  if (
    fence.repository_id !== evidence.repositoryId ||
    fence.intent_id !== evidence.intentId ||
    fence.token !== evidence.token ||
    fence.held !== 1 ||
    fence.fenced !== 0
  )
    return "idle";
  const lease = db
    .prepare(
      "SELECT id FROM deploy_leases WHERE id = ? AND repository_id = ? AND kind = 'deployment' AND released = 0",
    )
    .get(`deployment:${evidence.intentId}:${evidence.token}`, evidence.repositoryId);
  if (!lease) throw new Error("interrupted deployment has no matching active lease");
  const intent = db
    .prepare(
      `SELECT id, repository_id, phase, previous_manifest, target_manifest, merge_sha, tree_hash
     FROM deploy_intents WHERE id = ? AND repository_id = ? AND phase IN ('activating', 'prepared')`,
    )
    .get(evidence.intentId, evidence.repositoryId) as
    | {
        id: string;
        repository_id: string;
        phase: string;
        previous_manifest: string | null;
        target_manifest: string | null;
        merge_sha: string;
        tree_hash: string;
      }
    | undefined;
  if (!intent) throw new Error("interrupted deployment intent is not open");
  const observed = observe();
  if (observed.length > 0 && observed === intent.target_manifest) {
    finishRestart(db, evidence, intent, "deployed", observed);
    return "finished";
  }
  if (
    observed.length > 0 &&
    intent.previous_manifest !== null &&
    observed === intent.previous_manifest
  ) {
    finishRestart(db, evidence, intent, "rolled-back", observed);
    return "rolled-back";
  }
  return fenceRestart(db, evidence);
}

function finishRestart(
  db: Database,
  evidence: RecoveryEvidence,
  intent: {
    id: string;
    repository_id: string;
    merge_sha: string;
    tree_hash: string;
    target_manifest: string | null;
  },
  phase: "deployed" | "rolled-back",
  observed: string,
): void {
  const run = db.transaction(() => {
    const lock = db
      .prepare(
        "SELECT token FROM deploy_fence WHERE id = 1 AND token = ? AND repository_id = ? AND intent_id = ? AND held = 1 AND fenced = 0",
      )
      .get(evidence.token, evidence.repositoryId, evidence.intentId);
    const lease = db
      .prepare(
        "SELECT id FROM deploy_leases WHERE id = ? AND repository_id = ? AND kind = 'deployment' AND released = 0",
      )
      .get(`deployment:${evidence.intentId}:${evidence.token}`, evidence.repositoryId);
    if (!lock || !lease)
      throw new Error("interrupted deployment identity changed during observation");
    const updated = db
      .prepare(
        "UPDATE deploy_intents SET phase = ?, manifest_hash = ? WHERE id = ? AND repository_id = ? AND phase IN ('activating', 'prepared')",
      )
      .run(phase, phase === "deployed" ? observed : null, intent.id, evidence.repositoryId);
    if (updated.changes !== 1)
      throw new Error("interrupted deployment intent changed during observation");
    db.prepare("INSERT INTO deploy_phases (intent_id, phase, at) VALUES (?, ?, ?)").run(
      intent.id,
      phase,
      new Date().toISOString(),
    );
    const existing = db
      .prepare("SELECT id FROM deploy_outbox WHERE intent_id = ?")
      .get(intent.id) as { id: string } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO deploy_outbox
         (id, intent_id, kind, acknowledged, repository_id, merge_sha, tree_hash, manifest_hash)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        `reconcile-${intent.id}`,
        intent.id,
        phase,
        intent.repository_id,
        intent.merge_sha,
        intent.tree_hash,
        observed,
      );
    }
    releaseMatchingDeploymentLease(db, evidence);
    db.prepare(
      `UPDATE deploy_fence
       SET held = 0, fenced = 0, reason = NULL
       WHERE id = 1 AND token = ? AND repository_id = ? AND intent_id = ?`,
    ).run(evidence.token, evidence.repositoryId, evidence.intentId);
  });
  run();
}

function fenceRestart(db: Database, evidence: RecoveryEvidence): "fenced" {
  const run = db.transaction(() => {
    db.prepare(
      `UPDATE deploy_fence
       SET held = 1, fenced = 1, reason = ?
       WHERE id = 1 AND token = ? AND repository_id = ? AND intent_id = ? AND held = 1 AND fenced = 0`,
    ).run(
      "restart observation does not match a durable manifest",
      evidence.token,
      evidence.repositoryId,
      evidence.intentId,
    );
  });
  run();
  return "fenced";
}

function releaseMatchingDeploymentLease(db: Database, evidence: RecoveryEvidence): void {
  const row = db
    .prepare(
      `SELECT id FROM deploy_leases WHERE id = ? AND repository_id = ? AND kind = 'deployment' AND released = 0`,
    )
    .get(`deployment:${evidence.intentId}:${evidence.token}`, evidence.repositoryId) as
    | { id: string }
    | undefined;
  if (row) {
    db.prepare(
      `UPDATE deploy_owners
       SET active_deploys = CASE WHEN active_deploys > 0 THEN active_deploys - 1 ELSE 0 END
       WHERE repository_id = ?`,
    ).run(evidence.repositoryId);
    db.prepare("UPDATE deploy_leases SET released = 1 WHERE id = ?").run(row.id);
  }
}
