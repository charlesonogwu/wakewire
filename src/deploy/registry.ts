import fs from "node:fs";
import path from "node:path";
import type { LaneRecord, Role } from "./types.js";

const ROLES: Role[] = ["author", "reviewer"];

export function loadRegistry(registryPath: string): LaneRecord[] {
  const stat = fs.statSync(registryPath);
  const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { lanes?: LaneRecord[] };
  const lanes = parsed.lanes ?? [];
  assertIsolated(lanes);
  assertOwnerOnly(stat, registryPath);
  return lanes;
}

function assertOwnerOnly(stat: fs.Stats, registryPath: string): void {
  if (process.platform === "win32") {
    throw new Error(`registry owner isolation is linux-only: ${registryPath}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`registry must be owner-only: ${registryPath}`);
  }
}

function assertIsolated(lanes: LaneRecord[]): void {
  const threads = new Set<string>();
  const roots: string[] = [];
  const repositories = new Set<string>();
  for (const lane of lanes) {
    if (repositories.has(lane.repositoryId)) {
      throw new Error(`duplicate repositoryId ${lane.repositoryId}`);
    }
    repositories.add(lane.repositoryId);
    for (const role of ROLES) {
      const threadId = lane.threads[role].threadId;
      if (threads.has(threadId)) throw new Error(`shared threadId ${threadId}`);
      threads.add(threadId);
    }
    roots.push(lane.roots.checkout, lane.roots.worktree, lane.roots.cache);
  }
  const normalized = roots.map((root) => canonicalRoot(root));
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const left = normalized[i];
      const right = normalized[j];
      if (left === undefined || right === undefined) continue;
      if (
        left === right ||
        left.startsWith(`${right}${path.sep}`) ||
        right.startsWith(`${left}${path.sep}`)
      ) {
        throw new Error(`lane roots overlap: ${left} ${right}`);
      }
    }
  }
}

function canonicalRoot(root: string): string {
  if (/^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\") || root.startsWith("//")) {
    throw new Error(`windows absolute root ${root}`);
  }
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  if (stat?.isSymbolicLink()) throw new Error(`symlink lane root ${root}`);
  if (stat) return fs.realpathSync(root);
  const normalized = path.posix.normalize(root.replaceAll("\\", "/"));
  return path.resolve(normalized);
}
