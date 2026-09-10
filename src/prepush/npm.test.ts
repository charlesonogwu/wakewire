import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { npmArguments } from "./npm.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(
  npmrc: string,
  scripts: Record<string, string> = { test: 'node -e "process.exit(17)"' },
) {
  const root = await mkdtemp(join(tmpdir(), "prepush-npm-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "synthetic", version: "1.0.0", scripts }),
  );
  await writeFile(join(root, ".npmrc"), npmrc);
  await writeFile(join(root, "bypass.cjs"), "process.exit(0)\n");
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run tests through npm so its trusted CLI is available");
  const invoke = (args: string[]) => {
    // Adapt only platform-specific executable/path boundaries for this local
    // synthetic npm probe; production's container paths remain fixed.
    const adapted = args.map((arg) =>
      arg === "--prefix=/work"
        ? `--prefix=${root}`
        : arg === "--script-shell=/bin/sh" && process.platform === "win32"
          ? `--script-shell=${process.env.ComSpec}`
          : process.platform === "win32"
            ? arg.replace("=/dev/null", "=NUL")
            : arg,
    );
    return spawnSync(process.execPath, [npm, ...adapted], {
      cwd: root,
      env: {
        // The parent npm test command exports its own npm_config_globalconfig.
        // Docker does not inherit these host variables; model that boundary.
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
        ),
        NODE_OPTIONS: "",
        NPM_CONFIG_USERCONFIG: process.platform === "win32" ? "NUL" : "/dev/null",
      },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
  };
  return { root, invoke };
}

it("overrides project script-shell, node-options and root/workspace/suppression effective settings", async () => {
  const f = await fixture(
    "script-shell=untrusted-shell\nnode-options=--require ./bypass.cjs\nworkspaces=true\ninclude-workspace-root=false\nignore-scripts=true\nif-present=true\ndry-run=true\nglobal=true\n",
  );
  const result = f.invoke([...npmArguments(), "config", "list", "--json"]);
  expect(result.status).toBe(0);
  const config = JSON.parse(result.stdout);
  expect(config.globalconfig).not.toBe(config.userconfig);
  expect(config.globalconfig).toMatch(/wakewire-empty-global\.npmrc$/);
  expect(config).toMatchObject({
    "node-options": "",
    workspaces: false,
    "include-workspace-root": true,
    "ignore-scripts": false,
    "if-present": false,
    "dry-run": false,
    global: false,
    prefix: f.root,
  });
  expect(config["script-shell"]).toBe(
    process.platform === "win32" ? process.env.ComSpec : "/bin/sh",
  );
});
it("node-options cannot suppress the intended exit 17 without changing protected scripts", async () => {
  const f = await fixture("node-options=--require ./bypass.cjs\n");
  expect(f.invoke([...npmArguments(), "test"]).status).toBe(17);
});
it("script-shell cannot bypass intended verification", async () => {
  const trueShell =
    process.platform === "win32"
      ? resolve(
          execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
          "../../../usr/bin/true.exe",
        )
      : "/bin/true";
  const f = await fixture(`script-shell=${trueShell.replaceAll("\\", "/")}\n`);
  expect(f.invoke(["test"]).status).toBe(0);
  expect(f.invoke([...npmArguments(), "test"]).status).toBe(17);
});
it("reapplies trusted flags when project config is rewritten between commands", async () => {
  const f = await fixture("", {
    test: 'node -e "process.exit(17)"',
    build: 'node -e "process.exit(19)"',
  });
  expect(f.invoke([...npmArguments(), "test"]).status).toBe(17);
  await writeFile(join(f.root, ".npmrc"), "node-options=--require ./bypass.cjs\nif-present=true\n");
  expect(f.invoke([...npmArguments(), "run", "build"]).status).toBe(19);
});
it("an explicit workspace filter cannot yield successful verification of another project", async () => {
  const f = await fixture("workspace=untrusted-child\n");
  const result = f.invoke([...npmArguments(), "test"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("workspaces");
});
it("workspace selection cannot redirect away from the failing root script", async () => {
  const f = await fixture("workspaces=true\ninclude-workspace-root=false\nif-present=true\n");
  expect(f.invoke([...npmArguments(), "test"]).status).toBe(17);
});
it("if-present cannot suppress a missing protected script", async () => {
  const f = await fixture("if-present=true\n", {});
  expect(f.invoke([...npmArguments(), "run", "verify:push"]).status).not.toBe(0);
});
it("project ignore-scripts cannot suppress an existing protected pretest", async () => {
  const f = await fixture("ignore-scripts=true\n", {
    pretest: 'node -e "process.exit(23)"',
    test: 'node -e "process.exit(0)"',
  });
  expect(f.invoke([...npmArguments(), "test"]).status).toBe(23);
});
it("installation retains trusted ignore-scripts even when project config enables lifecycle scripts", async () => {
  const f = await fixture("ignore-scripts=false\n");
  const result = f.invoke([...npmArguments(true), "config", "list", "--json"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)["ignore-scripts"]).toBe(true);
});
