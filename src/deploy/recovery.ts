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
