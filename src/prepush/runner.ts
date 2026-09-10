import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GithubSnapshotClient } from "../coordination/github.js";
import type { CoordinationSnapshot } from "../coordination/policy.js";
import { type PrepushCandidate, selectPrepushRequest } from "../coordination/prepush.js";
import { type PrepushConfig, PrepushConfigSchema } from "./config.js";
import { type VerificationInput, type VerificationOutcomes, verifyInDocker } from "./docker.js";
import { GitRemote, git, type Remote, validateCandidate } from "./git.js";
import { command, gitEnvironment, hostEnvironment } from "./process.js";

export interface RunnerDependencies {
  snapshot(pr: number): Promise<CoordinationSnapshot>;
  transfer(host: string, path: string, target: string): Promise<void>;
  verify(input: VerificationInput): Promise<VerificationOutcomes>;
  remote: Remote;
}
export interface PrepushResult extends VerificationOutcomes {
  pr: number;
  candidateSha: string | null;
  state: "skipped" | "fetching" | "verified" | "pushing" | "pushed" | "failed" | "uncertain";
  readback: "not-run" | "candidate" | "other" | "unavailable";
  reason: string | null;
  directory: string | null;
  logPath: string | null;
}
export function candidateKey(repository: string, pr: number, request: PrepushCandidate) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        repository,
        pr,
        request.branch,
        request.expectedHead,
        request.candidateSha,
        request.bundleSha256,
      ]),
    )
    .digest("hex");
}
async function journal(directory: string, result: PrepushResult) {
  const temporary = join(directory, "journal.next");
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(result)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(directory, "journal.json"));
  // POSIX directory fsync makes the rename durable before any network push.
  if (process.platform !== "win32") {
    const dir = await open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
async function privateDirectory(root: string, key: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    resolve(await realpath(root)) !== resolve(root) ||
    (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))
  )
    throw new Error("state-root-not-private");
  const directory = join(root, key);
  // Existing directories and uncertain locks are never recovered automatically.
  await mkdir(directory, { mode: 0o700 });
  const lock = await open(join(directory, "lock"), "wx", 0o600);
  try {
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
  } finally {
    await lock.close();
  }
  return directory;
}
function defaults(config: PrepushConfig): RunnerDependencies {
  const github = new GithubSnapshotClient(config.coordination.expectedRepository);
  return {
    snapshot: (pr) => github.read(pr),
    remote: new GitRemote(`https://github.com/${config.coordination.expectedRepository}.git`),
    transfer: async (host, path, target) => {
      const result = await command(
        "scp",
        [
          "-B",
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ConnectTimeout=20",
          "--",
          `${host}:${path}`,
          target,
        ],
        { env: hostEnvironment() },
      );
      if (result.code !== 0) throw new Error("transfer");
    },
    verify: verifyInDocker,
  };
}

export async function runPrepush(
  raw: PrepushConfig,
  pr: number,
  injected?: RunnerDependencies,
): Promise<PrepushResult> {
  const config = PrepushConfigSchema.parse(raw);
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error("invalid-pr");
  const deps = injected ?? defaults(config);
  const request = selectPrepushRequest(await deps.snapshot(pr), config.coordination);
  const result: PrepushResult = {
    pr,
    candidateSha: request?.candidateSha ?? null,
    state: "skipped",
    tests: null,
    build: null,
    guard: null,
    integrity: null,
    readback: "not-run",
    reason: null,
    directory: null,
    logPath: null,
  };
  if (!request) return result;
  const key = candidateKey(config.coordination.expectedRepository, pr, request);
  const directory = await privateDirectory(config.stateRoot, key);
  result.directory = directory;
  result.logPath = join(directory, "verification.log");
  const log = await open(result.logPath, "wx", 0o600);
  await log.close();
  const repo = join(directory, "repo.git");
  let pushStarted = false;
  let phase = "fetching";
  try {
    result.state = "fetching";
    await journal(directory, result);
    const bundle = join(directory, "candidate.bundle");
    await deps.transfer(
      config.exportHost,
      `${config.exportRoot.replace(/\/$/, "")}/${request.bundleSha256}.bundle`,
      bundle,
    );
    phase = "bundle-digest";
    const info = await lstat(bundle);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024 * 1024)
      throw new Error(phase);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(bundle)) digest.update(chunk);
    if (digest.digest("hex") !== request.bundleSha256) throw new Error(phase);
    phase = "git-validation";
    const init = await command("git", ["init", "--bare", "--template=", repo], {
      env: gitEnvironment(),
    });
    if (init.code !== 0) throw new Error(phase);
    await git(repo, ["config", "core.hooksPath", "/dev/null"]);
    await deps.remote.fetch(repo, request.branch);
    if (
      (await git(repo, ["rev-parse", "refs/prepush/expected"])) !== request.expectedHead ||
      (await deps.remote.head(request.branch)) !== request.expectedHead
    )
      throw new Error("expected-head");
    await validateCandidate(repo, bundle, request, config.trustedAuthorEmail);
    const archive = join(directory, "candidate.tar");
    await git(repo, ["archive", "--format=tar", `--output=${archive}`, request.candidateSha]);
    if ((await stat(archive)).size > 1024 * 1024 * 1024) throw new Error("archive-limit");
    phase = "verification";
    Object.assign(
      result,
      await deps.verify({
        repo,
        archive,
        image: config.image,
        key,
        candidateSha: request.candidateSha,
        logPath: result.logPath,
      }),
    );
    if (
      result.tests !== 0 ||
      result.build !== 0 ||
      result.guard !== 0 ||
      result.integrity !== 0 ||
      (result.exitCode !== undefined && result.exitCode !== 0)
    )
      throw new Error(phase);
    result.state = "verified";
    await journal(directory, result);
    phase = "authorization-changed";
    const current = selectPrepushRequest(await deps.snapshot(pr), config.coordination);
    if (!current || candidateKey(config.coordination.expectedRepository, pr, current) !== key)
      throw new Error(phase);
    phase = "remote-head-changed";
    if ((await deps.remote.head(request.branch)) !== request.expectedHead) throw new Error(phase);
    await git(repo, ["merge-base", "--is-ancestor", request.expectedHead, request.candidateSha]);
    result.state = "pushing";
    await journal(directory, result);
    pushStarted = true;
    try {
      await deps.remote.push(repo, request);
    } catch {
      /* Read-only reconciliation; never retry a push. */
    }
    try {
      result.readback =
        (await deps.remote.head(request.branch)) === request.candidateSha ? "candidate" : "other";
    } catch {
      result.readback = "unavailable";
    }
    result.state = result.readback === "candidate" ? "pushed" : "uncertain";
    result.reason = result.state === "uncertain" ? "push-readback" : null;
    await journal(directory, result);
  } catch {
    result.state = pushStarted ? "uncertain" : "failed";
    result.reason = phase;
    await journal(directory, result);
  }
  return result;
}
