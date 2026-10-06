import { createHash, type KeyObject, sign, verify } from "node:crypto";
import { canonicalJson } from "./crypto.js";
import type { ArtifactEnvelope, ArtifactFile } from "./types.js";

export interface ArtifactSourceFile {
  path: string;
  mode: number;
  bytes: Buffer;
}

export interface ArtifactRequest {
  repositoryId: string;
  mergeSha: string;
  treeHash: string;
  adapterVersion: string;
  architecture: string;
  runtimeVersions: Record<string, string>;
  compatibility: "reversible" | "irreversible";
  files: ArtifactSourceFile[];
  expectedArchitecture: string;
  expectedRuntimeVersions: Record<string, string>;
  adapterIntroducedByMerge: string | null;
  signingKey: KeyObject;
}

const REPO_ONLY =
  /^(docs\/|\.github\/|tests\/|vendor\/wakewire\/|README|SECURITY|LICENSE|package\.json$|tsconfig.*\.json$|biome\.json$|.*\.md$)/;

export function buildArtifactEnvelope(input: ArtifactRequest): ArtifactEnvelope {
  if (input.compatibility !== "reversible" && input.compatibility !== "irreversible") {
    throw new Error("unknown compatibility");
  }
  if (input.architecture !== input.expectedArchitecture) throw new Error("wrong architecture");
  for (const [name, version] of Object.entries(input.expectedRuntimeVersions)) {
    if (input.runtimeVersions[name] !== version) throw new Error(`wrong runtime ${name}`);
  }
  const seen = new Set<string>();
  const files: ArtifactFile[] = [];
  for (const file of input.files) {
    assertSafePath(file.path);
    if ((file.mode & 0o170000) === 0o120000) throw new Error(`symlink forbidden: ${file.path}`);
    if (seen.has(file.path)) throw new Error(`duplicate file ${file.path}`);
    seen.add(file.path);
    if (REPO_ONLY.test(file.path)) continue;
    if (isAdapterPath(file.path) && input.adapterIntroducedByMerge === input.mergeSha) {
      throw new Error("same-merge adapter update");
    }
    files.push({
      path: file.path,
      mode: file.mode,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
    });
  }
  const body = {
    repositoryId: input.repositoryId,
    mergeSha: input.mergeSha,
    treeHash: input.treeHash,
    adapterVersion: input.adapterVersion,
    architecture: input.architecture,
    runtimeVersions: input.runtimeVersions,
    files,
    compatibility: input.compatibility,
  };
  const signature = sign(null, Buffer.from(canonicalJson(body)), input.signingKey).toString(
    "base64url",
  );
  return { ...body, signature };
}

export function verifyArtifactEnvelope(
  envelope: ArtifactEnvelope,
  bytes: ReadonlyMap<string, Buffer>,
  publicKey: KeyObject,
  expected: { architecture: string; runtimeVersions: Record<string, string>; repositoryId: string },
): void {
  const { signature, ...body } = envelope;
  if (
    !verify(null, Buffer.from(canonicalJson(body)), publicKey, Buffer.from(signature, "base64url"))
  ) {
    throw new Error("artifact signature is invalid");
  }
  if (envelope.repositoryId !== expected.repositoryId) throw new Error("wrong repository");
  if (envelope.architecture !== expected.architecture) throw new Error("wrong architecture");
  for (const [name, version] of Object.entries(expected.runtimeVersions)) {
    if (envelope.runtimeVersions[name] !== version) throw new Error(`wrong runtime ${name}`);
  }
  for (const file of envelope.files) {
    const payload = bytes.get(file.path);
    if (!payload) throw new Error(`missing bytes ${file.path}`);
    const actual = createHash("sha256").update(payload).digest("hex");
    if (actual !== file.sha256) throw new Error(`changed bytes ${file.path}`);
  }
}

function assertSafePath(filePath: string): void {
  if (filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").includes("..")) {
    throw new Error(`path traversal ${filePath}`);
  }
}

function isAdapterPath(filePath: string): boolean {
  return filePath === "adapter/policy.json" || filePath.startsWith("adapter/");
}
