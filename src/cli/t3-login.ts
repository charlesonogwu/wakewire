import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { z } from "zod";
import {
  daysLeft,
  defaultTokenFile,
  discoverT3Origin,
  readT3Token,
  T3_SCOPES,
  tokenIsUsable,
  writeT3Token,
} from "../sinks/t3-token.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export interface T3LoginOptions {
  registration?: string | undefined;
  tokenFile?: string | undefined;
  origin?: string | undefined;
  /** Test seams. */
  fetch?: typeof fetch;
  print?: (line: string) => void;
  onAuthorizeUrl?: (url: string) => void;
  runtimeFile?: string;
  timeoutMs?: number;
  now?: () => number;
}

export interface T3LoginResult {
  tokenFile: string;
  expiresAt: string;
  scope: string;
}

/** Token location and origin: explicit flags, then the registration, then defaults. */
export function resolveT3Access(opts: T3LoginOptions): { tokenFile: string; origin: string } {
  const registrationFile = opts.registration ?? process.env.WAKEWIRE_T3_REGISTRATION;
  let registered: { tokenFile?: string | undefined; origin?: string | undefined } = {};
  if (registrationFile) {
    registered = z
      .object({ tokenFile: z.string().optional(), origin: z.string().optional() })
      .parse(JSON.parse(readFileSync(registrationFile, "utf8")));
  }
  const tokenFile =
    opts.tokenFile ??
    registered.tokenFile ??
    (registrationFile ? defaultTokenFile(registrationFile) : undefined);
  if (!tokenFile)
    throw new Error("Pass --registration <t3-registration.json> or --token-file <path>");
  if (!path.isAbsolute(tokenFile)) throw new Error("The T3 token file path must be absolute");
  return {
    tokenFile,
    origin: discoverT3Origin(opts.origin ?? registered.origin, opts.runtimeFile),
  };
}

const base64url = (buffer: Buffer) => buffer.toString("base64url");
const sameOrigin = (url: string, origin: string) => new URL(url).origin === origin;
function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const ProtectedResource = z.object({ resource: z.string().url() });
const AuthServer = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
  code_challenge_methods_supported: z.array(z.string()),
});
const Registered = z.object({ client_id: z.string().min(1) });
const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
});

async function fetchJson(f: typeof fetch, url: string, init?: RequestInit): Promise<unknown> {
  const response = await f(url, init);
  // Bodies are never echoed: an error body is not needed to act and may be sensitive.
  if (!response.ok) throw new Error(`T3 ${new URL(url).pathname} returned HTTP ${response.status}`);
  return response.json();
}

interface CallbackServer {
  redirectUri: string;
  result: Promise<URLSearchParams>;
  close(): void;
}

/** Listens once on 127.0.0.1 for the authorization redirect. */
async function listenForCallback(timeoutMs: number): Promise<CallbackServer> {
  let settle!: (value: URLSearchParams) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<URLSearchParams>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(
      "WakeWire received the T3 response. You can close this tab and return to the terminal.",
    );
    settle(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const timer = setTimeout(() => fail(new Error("Timed out waiting for T3 approval")), timeoutMs);
  timer.unref();
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    close: () => {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    },
  };
}

/**
 * OAuth 2.1 authorization-code + PKCE (S256) against T3 Code's MCP authorization
 * server. A human approves in T3; the bearer token is stored privately and never printed.
 */
export async function t3Login(opts: T3LoginOptions = {}): Promise<T3LoginResult> {
  const f = opts.fetch ?? fetch;
  const print = opts.print ?? ((line: string) => console.log(line));
  const now = opts.now ?? Date.now;
  const { tokenFile, origin } = resolveT3Access(opts);

  const { resource } = ProtectedResource.parse(
    await fetchJson(f, `${origin}/.well-known/oauth-protected-resource`),
  );
  const meta = AuthServer.parse(
    await fetchJson(f, `${origin}/.well-known/oauth-authorization-server`),
  );
  if (
    !sameOrigin(resource, origin) ||
    new URL(meta.issuer).origin !== origin ||
    ![meta.authorization_endpoint, meta.token_endpoint, meta.registration_endpoint].every((url) =>
      sameOrigin(url, origin),
    )
  )
    throw new Error("T3 OAuth metadata points outside the local T3 server");
  if (!meta.code_challenge_methods_supported.includes("S256"))
    throw new Error("T3 OAuth server does not support PKCE S256");

  const callback = await listenForCallback(opts.timeoutMs ?? LOGIN_TIMEOUT_MS);
  try {
    const scope = T3_SCOPES.join(" ");
    const { client_id: clientId } = Registered.parse(
      await fetchJson(f, meta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "WakeWire",
          redirect_uris: [callback.redirectUri],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope,
        }),
      }),
    );
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));
    const authorize = new URL(meta.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback.redirectUri,
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
    }).toString();
    print("Open this URL, sign in to T3 Code and approve WakeWire with Operate access:");
    print(authorize.toString());
    opts.onAuthorizeUrl?.(authorize.toString());

    const params = await callback.result;
    if (!safeEqual(params.get("state") ?? "", state))
      throw new Error("T3 approval rejected: state mismatch");
    if (params.get("iss") !== meta.issuer)
      throw new Error("T3 approval rejected: unexpected issuer");
    if (params.get("error")) throw new Error("T3 approval was denied or failed");
    const code = params.get("code");
    if (!code) throw new Error("T3 approval returned no authorization code");

    const token = TokenResponse.parse(
      await fetchJson(f, meta.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: callback.redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          resource,
        }).toString(),
      }),
    );
    if (token.token_type.toLowerCase() !== "bearer")
      throw new Error("T3 issued an unsupported token type");
    const granted = token.scope ?? scope;
    if (!granted.split(" ").includes("orchestration:operate"))
      throw new Error("T3 granted read-only access; approve Operate access instead");
    const obtained = now();
    const expiresAt = new Date(obtained + token.expires_in * 1000).toISOString();
    writeT3Token(tokenFile, {
      version: 1,
      origin,
      resource,
      clientId,
      scope: granted,
      accessToken: token.access_token,
      obtainedAt: new Date(obtained).toISOString(),
      expiresAt,
    });
    print(
      `T3 access approved (${granted}). Expires ${expiresAt} (${daysLeft(expiresAt, obtained)} days). Token stored in ${tokenFile}.`,
    );
    return { tokenFile, expiresAt, scope: granted };
  } finally {
    callback.close();
  }
}

/** Shows expiry and days left; never the token. Returns false when access is unusable. */
export function t3Status(opts: T3LoginOptions = {}): boolean {
  const print = opts.print ?? ((line: string) => console.log(line));
  const now = (opts.now ?? Date.now)();
  const { tokenFile, origin } = resolveT3Access(opts);
  const token = readT3Token(tokenFile);
  print(`T3 origin: ${origin}`);
  print(`Token file: ${tokenFile}`);
  if (!token) {
    print("T3 access: not approved. Run `wakewire t3 login`.");
    return false;
  }
  const usable = tokenIsUsable(token, now);
  print(`Scope: ${token.scope}`);
  print(`Expires: ${token.expiresAt} (${Math.max(0, daysLeft(token.expiresAt, now))} days left)`);
  if (!usable) print("T3 access has expired. Run `wakewire t3 login` to re-approve.");
  return usable;
}
