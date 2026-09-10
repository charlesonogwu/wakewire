import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type VerificationInput, verifyInDocker } from "./docker.js";
import type { Command } from "./process.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function harness(failedStage = -1, code = 1) {
  const root = await mkdtemp(join(tmpdir(), "prepush-docker-"));
  roots.push(root);
  const input: VerificationInput = {
    repo: join(root, "repo.git"),
    archive: join(root, "candidate.tar"),
    logPath: join(root, "verification.log"),
    image: `node@sha256:${"a".repeat(64)}`,
    key: "b".repeat(64),
    candidateSha: "c".repeat(40),
  };
  const calls: { args: string[]; timeout: number | undefined }[] = [];
  let creates = 0;
  let starts = 0;
  const execute: Command = async (file, args, options) => {
    expect(file).toBe("docker");
    calls.push({ args, timeout: options?.timeout });
    let stdout = "";
    let exit = 0;
    if (args[0] === "create") stdout = String(++creates).repeat(64);
    if (args[0] === "start") {
      const stage = starts++;
      exit = stage === failedStage ? code : 0;
      stdout = [1, 4].includes(stage) ? "d".repeat(64) : "private test output\n";
    }
    return { code: exit, stdout, stderr: "" };
  };
  return { input, calls, execute };
}

describe("container isolation boundary", () => {
  it("uses pinned existing image, isolated stages, only owned mounts, and real offline guard", async () => {
    const h = await harness();
    expect(await verifyInDocker(h.input, h.execute)).toMatchObject({
      tests: 0,
      build: 0,
      guard: 0,
      exitCode: 0,
    });
    const calls = h.calls.map((call) => call.args);
    expect(calls[0]).toEqual(["image", "inspect", h.input.image]);
    const volume = calls.find((args) => args[0] === "volume" && args[1] === "create");
    expect(volume).toContain("wakewire.purpose=prepush");
    expect(volume).toContain(`wakewire.candidate=${h.input.key}`);
    const creates = calls.filter((args) => args[0] === "create");
    expect(creates).toHaveLength(5);
    for (const args of creates) {
      expect(args).toContain("--read-only");
      expect(args).toContain("--pull=never");
      expect(args).toContain("--cap-drop=ALL");
      expect(args).toContain("--security-opt=no-new-privileges");
      expect(args).toContain("--pids-limit=256");
      expect(args).toContain("--memory=2g");
      expect(args).toContain("--cpus=2");
      expect(args).not.toContain("--privileged");
      expect(args.join(" ")).not.toMatch(
        /docker\.sock|SSH_AUTH_SOCK|GH_TOKEN|GITHUB_TOKEN|\/root|\/home|--env-file|--network=host/,
      );
    }
    const [init, baseline, install, verify, integrity] = creates;
    if (!init || !install || !verify) throw new Error("Missing stage");
    expect(init).toContain("--network=none");
    expect(init).toContain("--cap-add=CHOWN");
    expect(init).toContain(`type=bind,src=${h.input.archive},dst=/candidate.tar,readonly`);
    expect(init.at(-1)).toContain("--no-same-owner");
    expect(init.at(-1)).toContain("chown -R 1000:1000");
    for (const args of [install, verify]) {
      expect(args).toContain("--user=1000:1000");
      expect(args).toContain("--tmpfs=/tmp:rw,nosuid,nodev,size=512m");
      expect(args).toContain("HOME=/tmp");
      expect(args).toContain("NPM_CONFIG_USERCONFIG=/dev/null");
      expect(args).not.toContain("--cap-add=CHOWN");
    }
    expect(install).not.toContain("--network=none");
    expect(install.at(-1)).toBe("npm ci --ignore-scripts --no-audit --no-fund");
    expect(install.filter((a) => a.startsWith("type=bind"))).toEqual([]);
    expect(verify).toContain("--network=none");
    expect(verify.at(-1)).toBe("npm test && npm run build && npm run verify:push");
    for (const env of [
      "CI=1",
      "GIT_DIR=/git",
      "GIT_WORK_TREE=/work",
      "GIT_CONFIG_COUNT=1",
      "GIT_CONFIG_KEY_0=safe.directory",
      "GIT_CONFIG_VALUE_0=/git",
    ])
      expect(verify).toContain(env);
    expect(verify.filter((a) => a.startsWith("type=bind"))).toEqual([
      `type=bind,src=${h.input.repo},dst=/git,readonly`,
    ]);
    for (const args of [baseline, integrity]) {
      expect(args).toContain("--entrypoint=node");
      expect(args).toContain("--network=none");
      expect(args?.find((arg) => arg.startsWith("type=volume"))).toMatch(/,readonly$/);
    }
    expect(calls.filter((args) => args[0] === "rm")).toEqual(
      [1, 2, 3, 4, 5].map((n) => ["rm", "--force", String(n).repeat(64)]),
    );
    expect(
      h.calls
        .filter((call) => call.args[0] === "start")
        .every((call) => call.timeout && call.timeout <= 20 * 60_000),
    ).toBe(true);
    expect(await readFile(h.input.logPath, "utf8")).toContain("private test output");
  });
  it("image inspection failure does not pull or create resources", async () => {
    const h = await harness();
    let calls = 0;
    await expect(
      verifyInDocker(h.input, async () => {
        calls++;
        return { code: 1, stdout: "", stderr: "secret" };
      }),
    ).rejects.toThrow("image");
    expect(calls).toBe(1);
  });
  it("dependency failure prevents verification and removes exact owned resources", async () => {
    const h = await harness(2, 7);
    await expect(verifyInDocker(h.input, h.execute)).rejects.toThrow("install");
    expect(h.calls.filter((c) => c.args[0] === "create")).toHaveLength(3);
    expect(h.calls.filter((c) => c.args[0] === "rm").map((c) => c.args[2])).toEqual([
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
    ]);
  });
  it("reports actual failed verification exit without inventing per-stage success", async () => {
    const h = await harness(3, 19);
    expect(await verifyInDocker(h.input, h.execute)).toEqual({
      tests: null,
      build: null,
      guard: null,
      integrity: null,
      exitCode: 19,
    });
  });
  it("timeout removes only containers created by this invocation", async () => {
    const h = await harness(3, 125);
    await verifyInDocker(h.input, h.execute);
    expect(h.calls.filter((c) => c.args[0] === "rm").map((c) => c.args)).toEqual(
      [1, 2, 3, 4].map((n) => ["rm", "--force", String(n).repeat(64)]),
    );
    expect(h.calls.some((c) => c.args.includes("prune"))).toBe(false);
  });
  it("rejects a changed host-held byte manifest after passing verification", async () => {
    const h = await harness();
    const execute: Command = async (...args) => {
      const result = await h.execute(...args);
      if (args[1][0] === "start" && args[1][2] === "5".repeat(64)) result.stdout = "e".repeat(64);
      return result;
    };
    expect(await verifyInDocker(h.input, execute)).toMatchObject({
      tests: 0,
      build: 0,
      guard: 0,
      integrity: 1,
    });
  });
});
