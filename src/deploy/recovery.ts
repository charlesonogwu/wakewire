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
  const result = db
    .prepare(
      `UPDATE deploy_fence
       SET held = 0, fenced = 0, reason = NULL
       WHERE id = 1 AND fenced = 1 AND token = ? AND repository_id = ? AND intent_id = ?`,
    )
    .run(evidence.token, evidence.repositoryId, evidence.intentId);
  return result.changes === 1 ? "cleared" : "fenced";
}

export function recoverObserved(
  db: Database,
  evidence: RecoveryEvidence,
  observe: () => string,
): "cleared" | "fenced" {
  return recover(db, evidence, observe);
}
