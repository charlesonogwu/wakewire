import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PrepushConfigSchema } from "./prepush/config.js";
import { runPrepush } from "./prepush/runner.js";

export function parseArguments(args: string[]): { config: string; pr: number } {
  if (args.length !== 4) throw new Error("arguments");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key || !value || !["--config", "--pr"].includes(key) || values.has(key))
      throw new Error("arguments");
    values.set(key, value);
  }
  const config = values.get("--config");
  const pr = values.get("--pr");
  if (
    !config ||
    !isAbsolute(config) ||
    !pr ||
    !/^[1-9][0-9]*$/.test(pr) ||
    !Number.isSafeInteger(Number(pr))
  )
    throw new Error("arguments");
  return { config, pr: Number(pr) };
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    const info = await lstat(args.config);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
      throw new Error("configuration");
    const config = PrepushConfigSchema.parse(JSON.parse(await readFile(args.config, "utf8")));
    const result = await runPrepush(config, args.pr);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = ["pushed", "skipped"].includes(result.state) ? 0 : 1;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ state: "failed", reason: "configuration-or-runner-error" })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();
