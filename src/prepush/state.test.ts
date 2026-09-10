import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCandidateDirectory } from "./state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "prepush-state-"));
  roots.push(value);
  return value;
}

it("requires a preprovisioned state root rather than creating unsynced ancestors", async () => {
  const parent = await root();
  const missing = join(parent, "missing", "state");
  await expect(createCandidateDirectory(missing, "a".repeat(64))).rejects.toThrow();
  await expect(lstat(join(parent, "missing"))).rejects.toThrow();
});
it("persists the locked child and then its parent entry before returning a candidate directory", async () => {
  const state = await root();
  const key = "a".repeat(64);
  const events: string[] = [];
  const candidate = await createCandidateDirectory(state, key, async (path) => {
    expect(await readFile(join(state, key, "lock"), "utf8")).toMatch(/^\d+\n$/);
    events.push(path);
  });
  expect(events).toEqual([join(state, key), state]);
  expect(candidate).toBe(join(state, key));
});
it("parent sync failure fails closed and keeps the uncertain exclusive fence", async () => {
  const state = await root();
  const key = "a".repeat(64);
  await expect(
    createCandidateDirectory(state, key, async (path) => {
      if (path === state) throw new Error("sync-failed");
    }),
  ).rejects.toThrow("sync-failed");
  expect((await lstat(join(state, key, "lock"))).isFile()).toBe(true);
  await expect(createCandidateDirectory(state, key)).rejects.toThrow();
});
