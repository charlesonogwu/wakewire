import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoordinationSnapshot } from "../coordination/policy.js";
import { PrepushConfigSchema } from "./config.js";
import { GitRemote } from "./git.js";
import { type RunnerDependencies, runPrepush } from "./runner.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(change = "normal") {
  const root = await mkdtemp(join(tmpdir(), "prepush-test-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", source, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=hermes/example");
  git("config", "user.name", "Synthetic");
  git("config", "user.email", "test@example.invalid");
  await mkdir(join(source, "ops"));
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ scripts: { test: "test", build: "build", "verify:push": "guard" } }),
  );
  await writeFile(join(source, "ops/verify-vercel-push.mjs"), "// trusted guard\n");
  git("add", ".");
  git("commit", "-m", "base");
  const expectedHead = git("rev-parse", "HEAD");
  const remotePath = join(root, "remote.git");
  git("clone", "--bare", source, remotePath);
  if (change === "nonancestor") git("checkout", "--orphan", "other");
  await writeFile(join(source, "candidate.txt"), "candidate\n");
  if (change === "attributes")
    await writeFile(join(source, ".gitattributes"), "candidate.txt export-ignore\n");
  if (change === "scripts")
    await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { test: "bypass" } }));
  if (change === "guard")
    await writeFile(join(source, "ops/verify-vercel-push.mjs"), "// bypass\n");
  git("add", ".");
  if (change === "symlink") {
    const blob = git("hash-object", "-w", "candidate.txt");
    git("update-index", "--add", "--cacheinfo", `120000,${blob},link`);
  }
  if (change === "submodule")
    git("update-index", "--add", "--cacheinfo", `160000,${expectedHead},module`);
  git("commit", "-m", "candidate");
  const candidateSha = git("rev-parse", "HEAD");
  if (change === "nonancestor") git("branch", "-f", "hermes/example", candidateSha);
  const bundle = join(root, "input.bundle");
  if (change === "multiple") {
    git("branch", "extra");
    git("bundle", "create", bundle, "--branches");
  } else git("bundle", "create", bundle, "refs/heads/hermes/example");
  const bundleSha256 = createHash("sha256")
    .update(await readFile(bundle))
    .digest("hex");
  const config = PrepushConfigSchema.parse({
    coordination: {
      expectedRepository: "example/project",
      localAgent: "codex",
      trustedAuthorIds: { codex: ["101"], hermes: ["202"] },
      waitingLabel: "waiting:operator",
      prepushEnabled: true,
    },
    exportHost: "agent@export.example",
    exportRoot: "/exports",
    stateRoot: join(root, "state"),
    image: `node@sha256:${"a".repeat(64)}`,
    trustedAuthorEmail: "agent@example.invalid",
  });
  await mkdir(config.stateRoot, { mode: 0o700 });
  const snapshot: CoordinationSnapshot = {
    repository: "example/project",
    headRepository: "example/project",
    state: "open",
    headSha: expectedHead,
    headBranch: "hermes/example",
    labels: ["agent:hermes"],
    checks: "pending",
    body: "<!-- agent-handoff:v1\norigin: hermes\nowner: hermes\nreviewer: codex\nimpacts: website\n-->",
    comments: [
      {
        id: 1,
        authorId: "202",
        updatedAt: "2026-09-10T00:00:00Z",
        body: `<!-- agent-prepush:v1\nowner: hermes\nbranch: hermes/example\nexpected-head: ${expectedHead}\ncandidate-sha: ${candidateSha}\nbundle-sha256: ${bundleSha256}\n-->`,
      },
    ],
  };
  let transfers = 0;
  let containers = 0;
  let pushes = 0;
  const remote = new GitRemote(remotePath);
  const deps: RunnerDependencies = {
    snapshot: async () => structuredClone(snapshot),
    transfer: async (host, path, target) => {
      expect(host).toBe("agent@export.example");
      expect(path).toBe(`/exports/${bundleSha256}.bundle`);
      transfers++;
      await copyFile(bundle, target);
    },
    verify: async () => {
      containers++;
      return { tests: 0, build: 0, guard: 0, integrity: 0 };
    },
    remote: {
      fetch: (...args) => remote.fetch(...args),
      head: (...args) => remote.head(...args),
      push: async (...args) => {
        pushes++;
        await remote.push(...args);
      },
    },
  };
  return {
    root,
    config,
    deps,
    snapshot,
    expectedHead,
    candidateSha,
    bundle,
    remote,
    remotePath,
    counts: () => ({ transfers, containers, pushes }),
  };
}

describe("isolated candidate runner", () => {
  it.each([false, true])(
    "revalidates correction authorization before push (manual block: %s)",
    async (block) => {
      const f = await fixture();
      f.snapshot.labels = ["agent:hermes", "changes-requested:hermes"];
      f.snapshot.comments = [
        ...f.snapshot.comments,
        {
          id: 2,
          authorId: "101",
          updatedAt: "2026-09-09T23:00:00Z",
          body: `<!-- agent-review:v1\nreviewer: codex\ndecision: revise\nhead-sha: ${f.expectedHead}\n-->`,
        },
      ];
      const verify = f.deps.verify;
      f.deps.verify = async (...args) => {
        const result = await verify(...args);
        if (block) f.snapshot.labels = [...f.snapshot.labels, "blocked:coordination"];
        return result;
      };
      const result = await runPrepush(f.config, 7, f.deps);
      expect(result.state).toBe(block ? "failed" : "pushed");
      expect(await f.remote.head("hermes/example")).toBe(block ? f.expectedHead : f.candidateSha);
      expect(f.counts().pushes).toBe(block ? 0 : 1);
    },
  );
  it("parent directory sync failure prevents transfer, verification and push", async () => {
    const f = await fixture();
    f.deps.directorySync = async (path) => {
      if (path === f.config.stateRoot) throw new Error("parent-sync-failed");
    };
    await expect(runPrepush(f.config, 7, f.deps)).rejects.toThrow("parent-sync-failed");
    expect(f.counts()).toEqual({ transfers: 0, containers: 0, pushes: 0 });
  });
  it("syncs the parent fence before work and the pushing journal before remote push", async () => {
    const f = await fixture();
    const events: string[] = [];
    f.deps.directorySync = async (path) => {
      if (path === f.config.stateRoot) events.push("parent");
      else {
        try {
          events.push(JSON.parse(await readFile(join(path, "journal.json"), "utf8")).state);
        } catch {
          events.push("lock");
        }
      }
    };
    const transfer = f.deps.transfer;
    f.deps.transfer = async (...args) => {
      expect(events).toEqual(["lock", "parent", "fetching"]);
      await transfer(...args);
    };
    const push = f.deps.remote.push;
    f.deps.remote.push = async (...args) => {
      expect(events).toEqual(["lock", "parent", "fetching", "verified", "pushing"]);
      await push(...args);
    };
    expect((await runPrepush(f.config, 7, f.deps)).state).toBe("pushed");
    expect(events.at(-1)).toBe("pushed");
  });
  it("archives every tracked file despite candidate export-ignore attributes", async () => {
    const f = await fixture("attributes");
    f.deps.verify = async (input) => {
      const paths = execFileSync("tar", ["-tf", input.archive], { encoding: "utf8" }).split(
        /\r?\n/,
      );
      expect(paths).toContain("candidate.txt");
      return { tests: 0, build: 0, guard: 0, integrity: 0 };
    };
    expect((await runPrepush(f.config, 7, f.deps)).state).toBe("pushed");
  });
  it("exact old-head lease fences a remote branch deletion after final head check", async () => {
    const f = await fixture();
    f.deps.remote.push = async (...args) => {
      execFileSync("git", [
        "--git-dir",
        f.remotePath,
        "update-ref",
        "-d",
        "refs/heads/hermes/example",
      ]);
      await f.remote.push(...args);
    };
    expect((await runPrepush(f.config, 7, f.deps)).state).toBe("uncertain");
    await expect(f.remote.head("hermes/example")).rejects.toThrow();
  });
  it("stops before artifact work without authorization", async () => {
    const f = await fixture();
    f.snapshot.state = "closed";
    expect((await runPrepush(f.config, 7, f.deps)).state).toBe("skipped");
    expect(f.counts()).toEqual({ transfers: 0, containers: 0, pushes: 0 });
  });
  it("validates a real bundle, archives it and guarded-pushes with exact readback", async () => {
    const f = await fixture();
    f.deps.verify = async (input) => {
      expect((await readFile(input.archive)).length).toBeGreaterThan(0);
      expect(
        execFileSync("git", ["--git-dir", input.repo, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      ).toBe(f.candidateSha);
      expect(
        execFileSync("git", ["--git-dir", input.repo, "config", "vercel.authorEmail"], {
          encoding: "utf8",
        }).trim(),
      ).toBe("agent@example.invalid");
      return { tests: 0, build: 0, guard: 0, integrity: 0 };
    };
    const result = await runPrepush(f.config, 7, f.deps);
    expect(result).toMatchObject({
      state: "pushed",
      pr: 7,
      candidateSha: f.candidateSha,
      tests: 0,
      build: 0,
      guard: 0,
      readback: "candidate",
    });
    expect(await f.remote.head("hermes/example")).toBe(f.candidateSha);
    if (!result.directory) throw new Error("Missing journal directory");
    expect(JSON.parse(await readFile(join(result.directory, "journal.json"), "utf8")).state).toBe(
      "pushed",
    );
    await expect(runPrepush(f.config, 7, f.deps)).rejects.toThrow(/already|exist/i);
    expect(f.counts().pushes).toBe(1);
  });
  it.each(["multiple", "nonancestor", "scripts", "guard", "symlink", "submodule"])(
    "rejects %s before containers or push",
    async (change) => {
      const f = await fixture(change);
      const result = await runPrepush(f.config, 7, f.deps);
      expect(result.state).toBe("failed");
      expect(f.counts()).toEqual({ transfers: 1, containers: 0, pushes: 0 });
      expect(await f.remote.head("hermes/example")).toBe(f.expectedHead);
    },
  );
  it("rejects wrong digest before Git import", async () => {
    const f = await fixture();
    await writeFile(f.bundle, "corrupted");
    const result = await runPrepush(f.config, 7, f.deps);
    expect(result).toMatchObject({ state: "failed", reason: "bundle-digest" });
    expect(f.counts().pushes).toBe(0);
  });
  it("build failure prevents push and preserves actual outcomes", async () => {
    const f = await fixture();
    f.deps.verify = async () => ({ tests: 0, build: 19, guard: null, integrity: null });
    expect(await runPrepush(f.config, 7, f.deps)).toMatchObject({
      state: "failed",
      tests: 0,
      build: 19,
      guard: null,
    });
    expect(f.counts().pushes).toBe(0);
  });
  it("preserves the dependency stage's actual exit and never pushes", async () => {
    const f = await fixture();
    f.deps.verify = async () => ({
      tests: null,
      build: null,
      guard: null,
      integrity: null,
      failedStage: "install",
      exitCode: 7,
    });
    expect(await runPrepush(f.config, 7, f.deps)).toMatchObject({
      state: "failed",
      failedStage: "install",
      exitCode: 7,
    });
    expect(f.counts().pushes).toBe(0);
  });
  it("tracked source mutation prevents push even when tests, build and guard pass", async () => {
    const f = await fixture();
    f.deps.verify = async () => ({ tests: 0, build: 0, guard: 0, integrity: 1 });
    expect(await runPrepush(f.config, 7, f.deps)).toMatchObject({ state: "failed", integrity: 1 });
    expect(f.counts().pushes).toBe(0);
  });
  it("reselects current authorization before push", async () => {
    const f = await fixture();
    let reads = 0;
    f.deps.snapshot = async () => ({ ...f.snapshot, state: ++reads === 1 ? "open" : "closed" });
    expect((await runPrepush(f.config, 7, f.deps)).state).toBe("failed");
    expect(f.counts().pushes).toBe(0);
  });
  it("changed remote head prevents push", async () => {
    const f = await fixture();
    let reads = 0;
    f.deps.remote.head = async () => (++reads === 1 ? f.expectedHead : "c".repeat(40));
    expect((await runPrepush(f.config, 7, f.deps)).state).toBe("failed");
    expect(f.counts().pushes).toBe(0);
  });
  it.each([true, false])(
    "reconciles ambiguous push by exact remote readback (%s)",
    async (landed) => {
      const f = await fixture();
      f.deps.remote.push = async (...args) => {
        const journal = JSON.parse(await readFile(join(args[0], "../journal.json"), "utf8"));
        expect(journal.state).toBe("pushing");
        if (landed) await f.remote.push(...args);
        throw new Error("ambiguous secret failure");
      };
      const result = await runPrepush(f.config, 7, f.deps);
      expect(result.state).toBe(landed ? "pushed" : "uncertain");
      expect(JSON.stringify(result)).not.toContain("secret");
      await expect(runPrepush(f.config, 7, f.deps)).rejects.toThrow();
    },
  );
  it("fences an in-progress key", async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.deps.verify = async () => {
      entered?.();
      await waiting;
      return { tests: 0, build: 0, guard: 0, integrity: 0 };
    };
    const first = runPrepush(f.config, 7, f.deps);
    await ready;
    await expect(runPrepush(f.config, 7, f.deps)).rejects.toThrow();
    release?.();
    expect((await first).state).toBe("pushed");
  });
});
