import { chmod, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrepushCandidate } from "../coordination/prepush.js";
import { command, gitEnvironment, hostEnvironment } from "./process.js";

const noHooks = process.platform === "win32" ? "NUL" : "/dev/null";
export async function git(repo: string, args: string[]): Promise<string> {
  const result = await command(
    "git",
    [
      "--git-dir",
      repo,
      "-c",
      `core.hooksPath=${noHooks}`,
      "-c",
      "core.autocrlf=false",
      "-c",
      `core.attributesFile=${noHooks}`,
      ...args,
    ],
    { env: gitEnvironment() },
  );
  if (result.code !== 0) throw new Error("git-validation");
  return result.stdout.trim();
}

export interface Remote {
  fetch(repo: string, branch: string): Promise<void>;
  head(branch: string): Promise<string>;
  push(repo: string, candidate: PrepushCandidate): Promise<void>;
}

/** URL is fixed by the production caller. Host credential helpers stay on host.
 * Local validation never inherits global Git config; remote operations may use
 * operator-provisioned host authentication, but always override hooks.
 */
export class GitRemote implements Remote {
  constructor(private readonly url: string) {}
  private async run(args: string[]) {
    const result = await command(
      "git",
      ["-c", `core.hooksPath=${noHooks}`, "-c", "protocol.ext.allow=never", ...args],
      {
        env: { ...hostEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
      },
    );
    if (result.code !== 0) throw new Error("git-remote");
    return result.stdout.trim();
  }
  async head(branch: string) {
    const output = await this.run([
      "ls-remote",
      "--refs",
      "--exit-code",
      this.url,
      `refs/heads/${branch}`,
    ]);
    const match = /^([a-f0-9]{40})\t([^\r\n]+)$/.exec(output);
    if (!match || match[2] !== `refs/heads/${branch}`) throw new Error("remote-head");
    return match[1] as string;
  }
  async fetch(repo: string, branch: string) {
    await this.run([
      "--git-dir",
      repo,
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      this.url,
      `refs/heads/${branch}:refs/prepush/expected`,
    ]);
  }
  async push(repo: string, candidate: PrepushCandidate) {
    // A lease is not an ancestry check. The runner independently checks both.
    await this.run([
      "--git-dir",
      repo,
      "push",
      "--porcelain",
      "--no-verify",
      "--recurse-submodules=no",
      `--force-with-lease=refs/heads/${candidate.branch}:${candidate.expectedHead}`,
      this.url,
      `${candidate.candidateSha}:refs/heads/${candidate.branch}`,
    ]);
  }
}

export async function validateCandidate(
  repo: string,
  bundle: string,
  request: PrepushCandidate,
  email: string,
) {
  await git(repo, ["bundle", "verify", bundle]);
  const heads = await git(repo, ["bundle", "list-heads", bundle]);
  if (heads !== `${request.candidateSha} refs/heads/${request.branch}`)
    throw new Error("bundle-refs");
  await git(repo, [
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    bundle,
    `refs/heads/${request.branch}:refs/prepush/candidate`,
  ]);
  if ((await git(repo, ["rev-parse", "refs/prepush/candidate^{commit}"])) !== request.candidateSha)
    throw new Error("candidate-sha");
  await git(repo, ["merge-base", "--is-ancestor", request.expectedHead, request.candidateSha]);
  const tree = await git(repo, ["ls-tree", "-r", "-z", request.candidateSha]);
  if (tree.split("\0").some((entry) => /^(120000|160000) /.test(entry)))
    throw new Error("unsafe-tree");
  const scripts = async (sha: string) => {
    const value: unknown = JSON.parse(await git(repo, ["show", `${sha}:package.json`]));
    if (
      !value ||
      typeof value !== "object" ||
      !("scripts" in value) ||
      !value.scripts ||
      typeof value.scripts !== "object" ||
      Array.isArray(value.scripts)
    )
      throw new Error("scripts");
    const entries = Object.entries(value.scripts).sort(([a], [b]) => a.localeCompare(b));
    if (
      entries.some(([, v]) => typeof v !== "string") ||
      !["test", "build", "verify:push"].every((key) => entries.some(([k]) => k === key))
    )
      throw new Error("scripts");
    return JSON.stringify(entries);
  };
  if ((await scripts(request.expectedHead)) !== (await scripts(request.candidateSha)))
    throw new Error("changed-scripts");
  const guard = "ops/verify-vercel-push.mjs";
  if (
    (await git(repo, ["rev-parse", `${request.expectedHead}:${guard}`])) !==
    (await git(repo, ["rev-parse", `${request.candidateSha}:${guard}`]))
  )
    throw new Error("changed-guard");
  await git(repo, ["config", "vercel.authorEmail", email]);
  await git(repo, ["symbolic-ref", "HEAD", "refs/prepush/candidate"]);
  await mkdir(join(repo, "info"), { recursive: true });
  // Archive the whole tree without candidate export-ignore/export-subst rules.
  await writeFile(join(repo, "info", "attributes"), "* -export-ignore -export-subst\n", {
    flag: "wx",
    mode: 0o644,
  });
  // /git is bound directly into a uid1000 container; the outer state directory
  // remains private. Make only this secret-free, owned bare repo readable.
  async function readable(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("private-repo-symlink");
    if (process.platform !== "win32") await chmod(path, info.isDirectory() ? 0o755 : 0o644);
    if (info.isDirectory())
      for (const name of await readdir(path)) await readable(join(path, name));
  }
  await readable(repo);
}
