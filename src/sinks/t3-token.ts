import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { writePrivateFile } from "../secrets/private-file.js";

/** T3 Code issues operate-level MCP access for 30 days with no refresh grant. */
export const T3_SCOPES = ["orchestration:read", "orchestration:operate"] as const;
export const DEFAULT_T3_ORIGIN = "http://127.0.0.1:3773";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Treat a token as expired slightly early so a call never races its expiry. */
const EXPIRY_SKEW_MS = 60 * 1000;

export const T3TokenSchema = z
  .object({
    version: z.literal(1),
    origin: z.string().url(),
    resource: z.string().url(),
    clientId: z.string().min(1),
    scope: z.string(),
    accessToken: z.string().min(1),
    obtainedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type T3Token = z.infer<typeof T3TokenSchema>;

/** Only loopback http origins are accepted: the bearer token must never leave this machine. */
export function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("T3 origin must be a loopback http URL");
  return url.origin;
}

/** Explicit origin, else T3's own runtime file, else the default local port. */
export function discoverT3Origin(explicit?: string, runtimeFile?: string): string {
  if (explicit) return loopbackOrigin(explicit);
  const file = runtimeFile ?? path.join(os.homedir(), ".t3", "userdata", "server-runtime.json");
  try {
    const runtime = z.object({ origin: z.string() }).parse(JSON.parse(readFileSync(file, "utf8")));
    return loopbackOrigin(runtime.origin);
  } catch {
    return DEFAULT_T3_ORIGIN;
  }
}

export type T3TokenLoad =
  | { status: "ok"; token: T3Token }
  | { status: "missing" }
  /** The file exists but cannot be read; `code` is the OS error code (e.g. EACCES). */
  | { status: "unreadable"; code: string }
  /** `problem` names the failing fields or "invalid JSON"; it never contains file content. */
  | { status: "malformed"; problem: string };

/** Distinguishes "no file" from unreadable or malformed files without exposing content. */
export function loadT3Token(file: string): T3TokenLoad {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? "UNKNOWN");
    return code === "ENOENT" ? { status: "missing" } : { status: "unreadable", code };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // JSON.parse messages can quote the content, so they are never surfaced.
    return { status: "malformed", problem: "invalid JSON" };
  }
  const parsed = T3TokenSchema.safeParse(json);
  if (parsed.success) return { status: "ok", token: parsed.data };
  const problem = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join(", ");
  return { status: "malformed", problem };
}

/** Returns null unless the file holds a valid token; never exposes token content. */
export function readT3Token(file: string): T3Token | null {
  const load = loadT3Token(file);
  return load.status === "ok" ? load.token : null;
}

/** Operator-facing reason for an unusable token file (no content). */
export function describeT3TokenLoad(load: Exclude<T3TokenLoad, { status: "ok" }>): string {
  if (load.status === "missing") return "no T3 access token file";
  if (load.status === "unreadable") return `T3 access token file is unreadable (${load.code})`;
  return `T3 access token file is malformed (${load.problem})`;
}

export function writeT3Token(file: string, token: T3Token): void {
  writePrivateFile(file, `${JSON.stringify(T3TokenSchema.parse(token), null, 2)}\n`);
}

export function tokenIsUsable(token: T3Token, now = Date.now()): boolean {
  return Date.parse(token.expiresAt) - EXPIRY_SKEW_MS > now;
}

/** Whole days remaining, rounded down; negative once expired. */
export function daysLeft(expiresAt: string, now = Date.now()): number {
  return Math.floor((Date.parse(expiresAt) - now) / DAY_MS);
}

/** The `/mcp` resource a token must be bound to for the given origin. */
export function mcpResource(origin: string): string {
  return new URL("/mcp", origin).toString();
}

/** Default token location: next to the T3 registration file. */
export function defaultTokenFile(registrationFile: string): string {
  return path.join(path.dirname(registrationFile), "t3-mcp-token.json");
}
