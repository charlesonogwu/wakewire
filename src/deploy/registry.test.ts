import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRegistry } from "./registry.js";
import type { LaneRecord } from "./types.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeRegistry(lanes: LaneRecord[], mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-reg-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "registry.json");
  fs.writeFileSync(file, JSON.stringify({ lanes }));
  fs.chmodSync(file, mode);
  return file;
}

function lane(id: string, root: string, thread: string): LaneRecord {
  return {
    laneId: id,
    repositoryId: `repo-${id}`,
    github: { owner: "example", name: id },
    roots: {
      checkout: path.join(root, id, "checkout"),
      worktree: path.join(root, id, "worktree"),
      cache: path.join(root, id, "cache"),
    },
    threads: {
      author: { projectId: `${id}-author-project`, threadId: `${thread}-author` },
      reviewer: { projectId: `${id}-review-project`, threadId: `${thread}-review` },
    },
    adapterPath: path.join(root, id, "adapter.json"),
  };
}

describe("loadRegistry", () => {
  it("rejects shared contexts and overlapping roots", () => {
    const root = "/srv/lanes";
    const shared = lane("lane-a", root, "shared");
    shared.threads.reviewer.threadId = shared.threads.author.threadId;
    expect(() => loadRegistry(writeRegistry([shared, lane("lane-b", root, "b")]))).toThrow(
      /threadId/,
    );

    const left = lane("lane-a", root, "a");
    const right = lane("lane-b", root, "b");
    right.roots.cache = path.join(left.roots.checkout, "nested");
    expect(() => loadRegistry(writeRegistry([left, right]))).toThrow(/overlap/);
  });

  it("rejects a registry that is not owner-only", () => {
    const file = writeRegistry([lane("lane-a", "/srv/lanes", "a")], 0o644);
    const expected = process.platform === "win32" ? /linux-only/ : /owner-only/;
    expect(() => loadRegistry(file)).toThrow(expected);
  });
});
