import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexDesktopAdapter } from "./codex-desktop.js";
import { DesktopMcpClient } from "./desktop-mcp.js";

export interface DesktopRegistration {
  threadId: string;
  cwd: string;
  stateFile: string;
  inheritPermissions: true;
  serverPath: string;
  serverSha256: string;
  pipePath: string;
  coordination?: unknown;
}

export interface DesktopConnectorCandidate {
  serverPath: string;
  serverSha256: string;
  pipePath: string;
}

interface RefreshDependencies {
  candidates: () => DesktopConnectorCandidate[];
  probe: (
    candidate: DesktopConnectorCandidate,
    registration: DesktopRegistration,
  ) => Promise<boolean>;
}

const registrationRefreshes = new Map<string, Promise<boolean>>();

export async function selectDesktopConnector(
  registration: DesktopRegistration,
  candidates: DesktopConnectorCandidate[],
  probe: (
    candidate: DesktopConnectorCandidate,
    registration: DesktopRegistration,
  ) => Promise<boolean>,
): Promise<DesktopConnectorCandidate> {
  const matches: DesktopConnectorCandidate[] = [];
  for (const candidate of candidates) {
    if (await probe(candidate, registration)) matches.push(candidate);
  }
  if (matches.length === 0) {
    throw new Error("No Codex Desktop connector matches the registered task");
  }
  if (matches.length > 1) {
    throw new Error("Multiple Codex Desktop connectors match the registered task");
  }
  return matches[0] as DesktopConnectorCandidate;
}

export function newestConnectorServers(servers: string[]): string[] {
  const parsed = servers.map((serverPath) => {
    const version = path.basename(path.dirname(serverPath));
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
      throw new Error(`Invalid connector version: ${version}`);
    }
    const parts = version.split(".").map(Number);
    if (parts.some((part) => !Number.isSafeInteger(part))) {
      throw new Error(`Invalid connector version: ${version}`);
    }
    return { serverPath, parts };
  });
  parsed.sort((a, b) => {
    for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
      const difference = (b.parts[index] ?? 0) - (a.parts[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return b.serverPath.localeCompare(a.serverPath);
  });
  const newest = parsed[0]?.parts.join(".");
  return parsed
    .filter((entry) => entry.parts.join(".") === newest)
    .map((entry) => entry.serverPath);
}

function connectorCandidates(): DesktopConnectorCandidate[] {
  if (process.platform !== "win32") {
    throw new Error("Automatic Codex Desktop connector refresh currently requires Windows");
  }
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const cacheRoot = path.join(codexHome, "plugins", "cache", "openai-bundled", "codex-app-tools");
  const servers = newestConnectorServers(
    fs
      .readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(cacheRoot, entry.name, "server.mjs"))
      .filter((file) => fs.existsSync(file)),
  );
  const pipes = fs
    .readdirSync("\\\\.\\pipe\\")
    .filter((name) => /^codex-(?:browser-use|computer-use)-/.test(name))
    .map((name) => `\\\\.\\pipe\\${name}`);
  return servers.flatMap((serverPath) => {
    const serverSha256 = createHash("sha256").update(fs.readFileSync(serverPath)).digest("hex");
    return pipes.map((pipePath) => ({ serverPath, serverSha256, pipePath }));
  });
}

async function probeDesktopConnector(
  candidate: DesktopConnectorCandidate,
  registration: DesktopRegistration,
): Promise<boolean> {
  const config = { ...registration, ...candidate };
  let adapter: CodexDesktopAdapter | undefined;
  try {
    adapter = new CodexDesktopAdapter(config, new DesktopMcpClient(config));
    return await adapter.probe();
  } catch {
    return false;
  } finally {
    adapter?.close();
  }
}

export async function refreshDesktopRegistration(
  file: string,
  dependencies: RefreshDependencies = {
    candidates: connectorCandidates,
    probe: probeDesktopConnector,
  },
): Promise<boolean> {
  if (!path.isAbsolute(file)) throw new Error("Desktop registration path must be absolute");
  const key = path.resolve(file);
  const previous = registrationRefreshes.get(key);
  const refresh = (previous ? previous.catch(() => false) : Promise.resolve(false)).then(() =>
    refreshDesktopRegistrationOnce(file, dependencies),
  );
  registrationRefreshes.set(key, refresh);
  try {
    return await refresh;
  } finally {
    if (registrationRefreshes.get(key) === refresh) registrationRefreshes.delete(key);
  }
}

async function refreshDesktopRegistrationOnce(
  file: string,
  dependencies: RefreshDependencies,
): Promise<boolean> {
  const original = fs.readFileSync(file, "utf8");
  const registration = JSON.parse(original) as DesktopRegistration;
  const selected = await selectDesktopConnector(
    registration,
    dependencies.candidates(),
    dependencies.probe,
  );
  if (
    selected.serverPath === registration.serverPath &&
    selected.serverSha256 === registration.serverSha256 &&
    selected.pipePath === registration.pipePath
  ) {
    return false;
  }
  const updated = `${JSON.stringify({ ...registration, ...selected }, null, 2)}\n`;
  writeFileAtomically(file, updated, original);
  return true;
}

export function writeFileAtomically(
  file: string,
  contents: string,
  expectedContents?: string,
): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, "wx", 0o600);
  let open = true;
  try {
    fs.writeFileSync(handle, contents);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    open = false;
    if (expectedContents !== undefined && fs.readFileSync(file, "utf8") !== expectedContents) {
      throw new Error("Desktop registration changed during refresh");
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (open) {
      try {
        fs.closeSync(handle);
      } catch {
        // Preserve the operation error while still attempting temp cleanup.
      }
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
