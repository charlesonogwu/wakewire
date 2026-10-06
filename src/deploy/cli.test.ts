import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dispatchDeploy, renderStatus, runDryRun } from "./cli.js";

const deps = {
  dryRun: () => ({
    repositoryId: "example/one" as const,
    status: "nothing-to-deploy" as const,
    writes: 0,
  }),
  recover: () => "cleared" as const,
  status: () => ({ repositories: [] }),
};

describe("deploy cli", () => {
  it("dry-runs synthetic data and rejects merge, repo, path, and command arguments", () => {
    const calls: string[] = [];
    const local = {
      dryRun: () => {
        calls.push("dry");
        return {
          repositoryId: "example/one" as const,
          status: "nothing-to-deploy" as const,
          writes: 0,
        };
      },
      recover: () => {
        calls.push("recover");
        return "cleared" as const;
      },
      status: () => {
        calls.push("status");
        return { repositories: [] };
      },
    };
    expect(dispatchDeploy(["dry-run"], local)).toEqual({
      repositoryId: "example/one",
      status: "nothing-to-deploy",
      writes: 0,
    });
    expect(calls).toEqual(["dry"]);
    for (const argv of [
      ["merge"],
      ["dry-run", "--repo", "example/one"],
      ["dry-run", "--path", "/tmp/example"],
      ["dry-run", "--command", "sh"],
      ["activate"],
      ["enable"],
    ]) {
      expect(() => dispatchDeploy(argv, local)).toThrow(/forbidden|unsupported/);
    }
    expect(calls).toEqual(["dry"]);
  });

  it("redacts signatures and tokens from status", () => {
    const output = renderStatus({
      repositories: [
        {
          repositoryId: "example/one",
          owner: "omarchy",
          phase: "stable",
          generation: 2,
          deploymentActivationEnabled: false,
          signature: "secret-signature",
          token: "ghp_secret",
          notice: "token ghp_secret leaked",
        },
      ],
    });
    expect(output).toContain("example/one");
    expect(output).toContain("false");
    expect(output).not.toContain("secret-signature");
    expect(output).not.toContain("ghp_");
  });

  it("rejects a caller manifest and recovers only with repository, intent, and token", () => {
    const calls: string[] = [];
    const local = {
      ...deps,
      recover: (evidence: { repositoryId: string; intentId: string; token: number }) => {
        calls.push(`${evidence.repositoryId}:${evidence.intentId}:${evidence.token}`);
        return "fenced" as const;
      },
    };
    expect(
      dispatchDeploy(
        ["recover", "--repository", "example/one", "--intent", "intent-1", "--token", "4"],
        local,
      ),
    ).toEqual({ status: "fenced" });
    expect(calls).toEqual(["example/one:intent-1:4"]);
    expect(() => dispatchDeploy(["recover"], local)).toThrow(/repository, intent, and token/);
    expect(() =>
      dispatchDeploy(
        [
          "recover",
          "--repository",
          "example/one",
          "--intent",
          "intent-1",
          "--token",
          "4",
          "--manifest",
          "ab".repeat(32),
        ],
        local,
      ),
    ).toThrow(/manifest/);
    expect(() =>
      dispatchDeploy(["recover", "--manifest", "ab".repeat(32), "--clear"], local),
    ).toThrow(/forbidden/);
    expect(calls).toEqual(["example/one:intent-1:4"]);
  });

  it("runs the executor only inside the synthetic dry-run adapter", () => {
    const result = runDryRun();
    expect(result).toEqual({
      repositoryId: "example/one",
      status: "nothing-to-deploy",
      writes: 0,
    });
  });

  it("wires deploy into the root cli without a merge command", () => {
    const source = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
    expect(source).toContain("dispatchDeploy");
    expect(source).toContain('command("deploy")');
    expect(source).not.toContain("deploy merge");
  });
});
