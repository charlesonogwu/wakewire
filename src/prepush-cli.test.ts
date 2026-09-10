import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArguments } from "./prepush-cli.js";

describe("standalone prepush CLI", () => {
  it("accepts only an absolute config and one positive safe PR", () => {
    expect(parseArguments(["--config", resolve("private.json"), "--pr", "7"])).toEqual({
      config: resolve("private.json"),
      pr: 7,
    });
  });
  it.each(
    [
      [],
      ["--config", "relative", "--pr", "7"],
      ["--config", resolve("a"), "--pr", "0"],
      ["--config", resolve("a"), "--pr", "7", "--branch", "main"],
      ["--config", resolve("a"), "--pr", "7", "--pr", "8"],
      ["--config", resolve("a"), "--pr", "1e2"],
      ["--config", resolve("a"), "--pr", "9007199254740992"],
    ].map((args) => ({ args })),
  )("rejects malformed arguments $args", ({ args }) => {
    expect(() => parseArguments(args)).toThrow();
  });
  it("fails as bounded JSON without exposing malformed private config", async () => {
    const root = await mkdtemp(join(tmpdir(), "prepush-cli-"));
    try {
      const path = join(root, "private.json");
      await writeFile(path, '{"secret":"never-print-this"}');
      let output = "";
      try {
        execFileSync(
          process.execPath,
          ["--import", "tsx", "src/prepush-cli.ts", "--config", path, "--pr", "7"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        output = String((error as { stdout: string }).stdout);
      }
      expect(JSON.parse(output)).toMatchObject({ state: "failed" });
      expect(output.length).toBeLessThan(300);
      expect(output).not.toContain("never-print-this");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
