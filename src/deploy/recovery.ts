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
    releaseMatchingDeploymentLease(db, evidence.repositoryId, evidence.intentId);
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
  observe: () => string,
): "finished" | "rolled-back" | "fenced" | "idle" {
  const open = db
    .prepare(
      `SELECT id, repository_id, phase, previous_manifest, target_manifest, merge_sha, tree_hash
       FROM deploy_intents
       WHERE phase IN ('activating', 'prepared')
       ORDER BY created_at`,
    )
    .all() as Array<{
    id: string;
    repository_id: string;
    phase: string;
    previous_manifest: string | null;
    target_manifest: string | null;
    merge_sha: string;
    tree_hash: string;
  }>;
  const intent = open.length === 1 ? open[0] : undefined;
  if (!intent) return open.length === 0 ? "idle" : fenceRestart(db, null);
  const observed = observe();
  if (observed.length > 0 && observed === intent.target_manifest) {
    finishRestart(db, intent, "deployed", observed);
    return "finished";
  }
  if (
    observed.length > 0 &&
    intent.previous_manifest !== null &&
    observed === intent.previous_manifest
  ) {
    finishRestart(db, intent, "rolled-back", observed);
    return "rolled-back";
  }
  return fenceRestart(db, intent);
}

function finishRestart(
  db: Database,
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
    db.prepare("UPDATE deploy_intents SET phase = ?, manifest_hash = ? WHERE id = ?").run(
      phase,
      phase === "deployed" ? observed : null,
      intent.id,
    );
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
    releaseMatchingDeploymentLease(db, intent.repository_id, intent.id);
    db.prepare(
      `UPDATE deploy_fence
       SET held = 0, fenced = 0, reason = NULL
       WHERE id = 1 AND repository_id = ? AND intent_id = ?`,
    ).run(intent.repository_id, intent.id);
  });
  run();
}

function fenceRestart(
  db: Database,
  intent: { id: string; repository_id: string } | null,
): "fenced" {
  const run = db.transaction(() => {
    const fence = db.prepare("SELECT fenced FROM deploy_fence WHERE id = 1").get() as {
      fenced: number;
    };
    if (fence.fenced === 1) return;
    db.prepare(
      `UPDATE deploy_fence
       SET held = 1, fenced = 1, reason = ?, repository_id = COALESCE(?, repository_id), intent_id = COALESCE(?, intent_id)
       WHERE id = 1`,
    ).run(
      "restart observation does not match a durable manifest",
      intent?.repository_id ?? null,
      intent?.id ?? null,
    );
  });
  run();
  return "fenced";
}

function releaseMatchingDeploymentLease(
  db: Database,
  repositoryId: string,
  intentId: string,
): void {
  const rows = db
    .prepare(
      `SELECT id FROM deploy_leases
       WHERE repository_id = ? AND kind = 'deployment' AND released = 0 AND id LIKE ?`,
    )
    .all(repositoryId, `deployment:${intentId}:%`) as Array<{ id: string }>;
  for (const row of rows) {
    db.prepare(
      `UPDATE deploy_owners
       SET active_deploys = CASE WHEN active_deploys > 0 THEN active_deploys - 1 ELSE 0 END
       WHERE repository_id = ?`,
    ).run(repositoryId);
    db.prepare("UPDATE deploy_leases SET released = 1 WHERE id = ?").run(row.id);
  }
}
