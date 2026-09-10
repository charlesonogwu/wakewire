import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { integrityScript } from "./integrity.js";
import { type Command, command, hostEnvironment } from "./process.js";

export interface VerificationOutcomes {
  tests: number | null;
  build: number | null;
  guard: number | null;
  integrity: number | null;
  exitCode?: number;
}
export interface VerificationInput {
  repo: string;
  archive: string;
  image: string;
  key: string;
  candidateSha: string;
  logPath: string;
}

function requireSuccess(code: number, reason: string) {
  if (code !== 0) throw new Error(reason);
}

export async function verifyInDocker(
  input: VerificationInput,
  execute: Command = command,
): Promise<VerificationOutcomes> {
  const log = await open(input.logPath, "a", 0o600);
  const docker = (args: string[], timeout = 120_000) =>
    execute("docker", args, { env: hostEnvironment(), timeout });
  const volume = `wakewire-prepush-${randomUUID()}`;
  let volumeOwned = false;
  const common = [
    "--pull=never",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    "--memory=2g",
    "--cpus=2",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=512m",
    "--workdir=/work",
  ];
  const user = [
    "--user=1000:1000",
    "--env",
    "HOME=/tmp",
    "--env",
    "NPM_CONFIG_USERCONFIG=/dev/null",
  ];
  async function stage(name: string, flags: string[], script: string | string[], timeout: number) {
    const manifest = Array.isArray(script);
    const created = await docker([
      "create",
      "--name",
      `wakewire-prepush-${randomUUID()}`,
      ...common,
      "--mount",
      `type=volume,src=${volume},dst=/work${manifest ? ",readonly" : ""}`,
      manifest ? "--entrypoint=node" : "--entrypoint=/bin/sh",
      ...flags,
      input.image,
      ...(manifest ? script : ["-c", script]),
    ]);
    const id = created.stdout.trim();
    if (created.code !== 0 || !/^[a-f0-9]{64}$/.test(id)) throw new Error(`docker-create-${name}`);
    try {
      const result = await docker(["start", "--attach", id], timeout);
      await log.writeFile(`\n[${name}] exit=${result.code}\n${result.stdout}\n${result.stderr}\n`);
      return result;
    } finally {
      // execFile timeout kills the Docker client, not the container. Remove
      // only the exact daemon-issued ID from our successful create operation.
      const removed = await docker(["rm", "--force", id], 30_000);
      requireSuccess(removed.code, "docker-container-cleanup");
    }
  }
  try {
    if ((await docker(["image", "inspect", input.image])).code !== 0)
      throw new Error("docker-image-missing");
    const created = await docker([
      "volume",
      "create",
      "--label",
      "wakewire.purpose=prepush",
      "--label",
      `wakewire.candidate=${input.key}`,
      volume,
    ]);
    if (created.code !== 0) throw new Error("docker-volume-create");
    volumeOwned = true;
    const init = await stage(
      "init",
      [
        "--user=0:0",
        "--network=none",
        "--cap-add=CHOWN",
        "--mount",
        `type=bind,src=${input.archive},dst=/candidate.tar,readonly`,
      ],
      "tar --no-same-owner -xf /candidate.tar -C /work && chown -R 1000:1000 /work",
      120_000,
    );
    if (init.code !== 0) throw new Error("docker-init");
    const offline = [
      ...user,
      "--network=none",
      "--env",
      "CI=1",
      "--env",
      "GIT_DIR=/git",
      "--env",
      "GIT_WORK_TREE=/work",
      "--env",
      "GIT_CONFIG_COUNT=1",
      "--env",
      "GIT_CONFIG_KEY_0=safe.directory",
      "--env",
      "GIT_CONFIG_VALUE_0=/git",
      "--env",
      "GIT_CONFIG_NOSYSTEM=1",
      "--env",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "--mount",
      `type=bind,src=${input.repo},dst=/git,readonly`,
    ];
    const manifestArgs = ["-e", integrityScript, input.candidateSha];
    const baseline = await stage("baseline", offline, manifestArgs, 120_000);
    if (baseline.code !== 0 || !/^[a-f0-9]{64}$/.test(baseline.stdout))
      throw new Error("docker-baseline");
    const install = await stage(
      "install",
      user,
      "npm ci --ignore-scripts --no-audit --no-fund",
      10 * 60_000,
    );
    if (install.code !== 0) throw new Error("docker-install");
    const verified = await stage(
      "verification",
      offline,
      "npm test && npm run build && npm run verify:push",
      20 * 60_000,
    );
    const code = verified.code;
    // Both byte manifests are emitted by trusted Node in fresh offline
    // containers. The baseline lives only in host memory, never in /work.
    let integrity: number | null = null;
    if (code === 0) {
      const final = await stage("integrity", offline, manifestArgs, 120_000);
      integrity = final.code === 0 && final.stdout === baseline.stdout ? 0 : final.code || 1;
    }
    // One trusted && chain provides a real aggregate exit. Candidate-controlled
    // stdout cannot establish which earlier stages passed on failure.
    return {
      tests: code === 0 ? 0 : null,
      build: code === 0 ? 0 : null,
      guard: code === 0 ? 0 : null,
      integrity,
      exitCode: code,
    };
  } finally {
    try {
      if (volumeOwned)
        requireSuccess(
          (await docker(["volume", "rm", volume], 30_000)).code,
          "docker-volume-cleanup",
        );
    } finally {
      await log.sync();
      await log.close();
    }
  }
}
