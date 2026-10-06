import type { Database } from "better-sqlite3";
import { openDeployJournal } from "./journal.js";

export function recover(
  db: Database,
  repositoryId: string,
  observedManifest: string,
): "cleared" | "fenced" {
  const journal = openDeployJournal(db);
  if (journal.currentManifest(repositoryId) !== observedManifest) return "fenced";
  db.prepare("UPDATE deploy_fence SET held = 0, fenced = 0, reason = NULL WHERE id = 1").run();
  return "cleared";
}

export function recoverObserved(db: Database, observedManifest: string): "cleared" | "fenced" {
  const journal = openDeployJournal(db);
  const rows = db.prepare("SELECT repository_id FROM deploy_owners").all() as Array<{
    repository_id: string;
  }>;
  const match = rows.find((row) => journal.currentManifest(row.repository_id) === observedManifest);
  if (!match) return "fenced";
  return recover(db, match.repository_id, observedManifest);
}
