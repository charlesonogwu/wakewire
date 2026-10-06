import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ArtifactRequest } from "./artifact.js";
import { buildArtifactEnvelope, verifyArtifactEnvelope } from "./artifact.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const SHA = "a".repeat(40);

function request(
  files: ArtifactRequest["files"],
  overrides: Partial<ArtifactRequest> = {},
): ArtifactRequest {
  return {
    repositoryId: "repo-a",
    mergeSha: SHA,
    treeHash: "b".repeat(40),
    adapterVersion: "1",
    architecture: "x64",
    runtimeVersions: { python: "3.11" },
    compatibility: "reversible",
    files,
    expectedArchitecture: "x64",
    expectedRuntimeVersions: { python: "3.11" },
    adapterIntroducedByMerge: null,
    signingKey: privateKey,
    ...overrides,
  };
}

describe("artifacts", () => {
  it("rejects changed bytes, traversal, symlinks, duplicates, and same-merge adapter edits", () => {
    const file = { path: "src/app.py", mode: 0o100644, bytes: Buffer.from("print(1)\n") };
    const envelope = buildArtifactEnvelope(request([file]));
    expect(() =>
      verifyArtifactEnvelope(
        envelope,
        new Map([[file.path, Buffer.from("print(2)\n")]]),
        publicKey,
        {
          architecture: "x64",
          runtimeVersions: { python: "3.11" },
          repositoryId: "repo-a",
        },
      ),
    ).toThrow(/changed bytes/);
    expect(() => buildArtifactEnvelope(request([{ ...file, path: "../etc/passwd" }]))).toThrow(
      /traversal/,
    );
    expect(() => buildArtifactEnvelope(request([{ ...file, mode: 0o120777 }]))).toThrow(/symlink/);
    expect(() => buildArtifactEnvelope(request([file, { ...file }]))).toThrow(/duplicate/);
    expect(() =>
      buildArtifactEnvelope(
        request([{ path: "adapter/policy.json", mode: 0o100644, bytes: Buffer.from("{}") }], {
          adapterIntroducedByMerge: SHA,
        }),
      ),
    ).toThrow(/same-merge/);
  });

  it("rejects the wrong architecture, runtime, repository, and unknown compatibility", () => {
    expect(() => buildArtifactEnvelope(request([], { architecture: "arm64" }))).toThrow(
      /architecture/,
    );
    expect(() =>
      buildArtifactEnvelope(request([], { runtimeVersions: { python: "3.14" } })),
    ).toThrow(/runtime/);
    const envelope = buildArtifactEnvelope(request([]));
    expect(() =>
      verifyArtifactEnvelope(envelope, new Map(), publicKey, {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "other",
      }),
    ).toThrow(/repository/);
    expect(() =>
      buildArtifactEnvelope(request([], { compatibility: "maybe" as "reversible" })),
    ).toThrow(/compatibility/);
  });

  it("builds an empty manifest for repository-only files", () => {
    const envelope = buildArtifactEnvelope(
      request([
        { path: "docs/guide.md", mode: 0o100644, bytes: Buffer.from("# guide\n") },
        { path: "tests/test_app.py", mode: 0o100644, bytes: Buffer.from("def test():\n pass\n") },
        { path: "vendor/wakewire/base.json", mode: 0o100644, bytes: Buffer.from("{}\n") },
      ]),
    );
    expect(envelope.files).toEqual([]);
    expect(() =>
      verifyArtifactEnvelope(envelope, new Map(), publicKey, {
        architecture: "x64",
        runtimeVersions: { python: "3.11" },
        repositoryId: "repo-a",
      }),
    ).not.toThrow();
  });
});
