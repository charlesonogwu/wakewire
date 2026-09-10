import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { integrityScript } from "./integrity.js";

it("compares exact extracted bytes and modes independent of Git filters and generated output", async () => {
  const root = await mkdtemp(join(tmpdir(), "prepush-integrity-"));
  try {
    const work = join(root, "work");
    await mkdir(work);
    const git = (args: string[], env = process.env) =>
      execFileSync("git", ["-C", work, "-c", "core.hooksPath=/dev/null", ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git(["init"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Synthetic"]);
    git(["config", "core.autocrlf", "true"]);
    await writeFile(join(work, "source.txt"), "original\r\n");
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    const sha = git(["rev-parse", "HEAD"]);
    const bare = join(root, "repo.git");
    git(["clone", "--bare", work, bare]);
    const env = {
      ...process.env,
      GIT_DIR: bare,
      GIT_WORK_TREE: work,
      GIT_INDEX_FILE: join(root, "temporary-index"),
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const check = () =>
      execFileSync(process.execPath, ["-e", integrityScript, sha], {
        cwd: work,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const baseline = check();
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    await mkdir(join(work, "dist"));
    await writeFile(join(work, "dist/generated.js"), "generated");
    await mkdir(join(work, "node_modules"));
    await writeFile(join(work, "node_modules/dependency"), "generated");
    expect(check()).toBe(baseline);
    await writeFile(join(work, "source.txt"), "original\n");
    expect(check()).not.toBe(baseline);
    await writeFile(join(work, "source.txt"), "original\r\n");
    expect(check()).toBe(baseline);
    if (process.platform !== "win32") {
      await chmod(join(work, "source.txt"), 0o755);
      expect(check()).not.toBe(baseline);
    }
    await writeFile(join(work, "source.txt"), "changed by test/build\n");
    expect(check()).not.toBe(baseline);
    await rm(join(work, "source.txt"));
    expect(check).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
