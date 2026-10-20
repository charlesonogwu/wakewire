import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readT3Token } from "../sinks/t3-token.js";
import { t3Login, t3Status } from "./t3-login.js";

const TOKEN = "synthetic-access-token-never-logged";
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeOAuth {
  origin: string;
  registered: Record<string, unknown>[];
  tokenRequests: URLSearchParams[];
  scope: string;
}
/** A local stand-in for T3 Code's MCP authorization server (stateless, PKCE S256). */
async function fakeOAuth(): Promise<FakeOAuth> {
  const state: FakeOAuth = { origin: "", registered: [], tokenRequests: [], scope: "" };
  const challenges = new Map<string, string>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", state.origin);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource")
      return json(200, {
        resource: `${state.origin}/mcp`,
        authorization_servers: [state.origin],
        scopes_supported: ["orchestration:read", "orchestration:operate"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(200, {
        issuer: state.origin,
        authorization_endpoint: `${state.origin}/oauth/mcp/authorize`,
        token_endpoint: `${state.origin}/oauth/mcp/token`,
        registration_endpoint: `${state.origin}/oauth/mcp/register`,
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/oauth/mcp/register") {
      state.registered.push(JSON.parse(body));
      return json(201, { client_id: "signed-client-metadata" });
    }
    if (url.pathname === "/oauth/mcp/token") {
      const form = new URLSearchParams(body);
      state.tokenRequests.push(form);
      const challenge = challenges.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== challenge)
        return json(400, { error: "invalid_grant" });
      return json(200, {
        access_token: TOKEN,
        token_type: "Bearer",
        expires_in: 30 * 24 * 60 * 60,
        ...(state.scope === "omit"
          ? {}
          : { scope: state.scope || "orchestration:read orchestration:operate" }),
      });
    }
    // The "approval" step records the challenge for the code it issues.
    if (url.pathname === "/approve") {
      challenges.set("auth-code", url.searchParams.get("challenge") ?? "");
      return json(200, {});
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

function registrationDir(origin: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wakewire-t3-login-"));
  dirs.push(dir);
  const registration = path.join(dir, "t3-registration.json");
  writeFileSync(registration, JSON.stringify({ threadId: "primary", origin }));
  return { dir, registration, tokenFile: path.join(dir, "t3-mcp-token.json") };
}

/** Simulates the human approving in T3: the browser follows the redirect. */
function approve(
  oauth: FakeOAuth,
  tamper: (params: URLSearchParams) => void = () => {},
): (url: string) => void {
  return (authorizeUrl) => {
    void (async () => {
      const url = new URL(authorizeUrl);
      const params = url.searchParams;
      await fetch(`${oauth.origin}/approve?challenge=${params.get("code_challenge")}`);
      const callback = new URL(params.get("redirect_uri") ?? "");
      callback.searchParams.set("code", "auth-code");
      callback.searchParams.set("state", params.get("state") ?? "");
      callback.searchParams.set("iss", oauth.origin);
      tamper(callback.searchParams);
      await fetch(callback);
    })();
  };
}

describe("wakewire t3 login", () => {
  it("registers WakeWire, uses PKCE S256 and stores the token privately", async () => {
    const oauth = await fakeOAuth();
    const { registration, tokenFile } = registrationDir(oauth.origin);
    const printed: string[] = [];
    let authorizeUrl = "";
    const now = Date.parse("2026-10-20T00:00:00.000Z");
    const result = await t3Login({
      registration,
      print: (line) => printed.push(line),
      onAuthorizeUrl: (url) => {
        authorizeUrl = url;
        approve(oauth)(url);
      },
      now: () => now,
    });
    const authorize = new URL(authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(`${oauth.origin}/oauth/mcp/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "signed-client-metadata",
      scope: "orchestration:read orchestration:operate",
      code_challenge_method: "S256",
      resource: `${oauth.origin}/mcp`,
    });
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(oauth.registered[0]).toMatchObject({
      client_name: "WakeWire",
      redirect_uris: [redirect.toString()],
      token_endpoint_auth_method: "none",
    });
    const tokenRequest = oauth.tokenRequests[0];
    expect(tokenRequest?.get("grant_type")).toBe("authorization_code");
    expect(tokenRequest?.get("resource")).toBe(`${oauth.origin}/mcp`);
    expect(tokenRequest?.get("code_verifier")).not.toBe(
      authorize.searchParams.get("code_challenge"),
    );
    expect(result).toEqual({
      tokenFile,
      expiresAt: "2026-11-19T00:00:00.000Z",
      scope: "orchestration:read orchestration:operate",
    });
    expect(readT3Token(tokenFile)?.accessToken).toBe(TOKEN);
    expect(printed.join("\n")).not.toContain(TOKEN);
    expect(printed.join("\n")).toContain("2026-11-19");

    const status: string[] = [];
    expect(
      t3Status({
        registration,
        print: (line) => status.push(line),
        now: () => now + 26 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(true);
    expect(status.join("\n")).toContain("(4 days left)");
    expect(status.join("\n")).not.toContain(TOKEN);
    expect(readFileSync(tokenFile, "utf8")).toContain(TOKEN);
  });

  it("rejects a callback with a mismatched state", async () => {
    const oauth = await fakeOAuth();
    const { registration, tokenFile } = registrationDir(oauth.origin);
    await expect(
      t3Login({
        registration,
        print: () => {},
        onAuthorizeUrl: approve(oauth, (params) => params.set("state", "forged")),
      }),
    ).rejects.toThrow(/state mismatch/);
    expect(oauth.tokenRequests).toHaveLength(0);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("rejects a callback from the wrong issuer", async () => {
    const oauth = await fakeOAuth();
    const { registration, tokenFile } = registrationDir(oauth.origin);
    await expect(
      t3Login({
        registration,
        print: () => {},
        onAuthorizeUrl: approve(oauth, (params) => params.set("iss", "http://127.0.0.1:1")),
      }),
    ).rejects.toThrow(/unexpected issuer/);
    await expect(
      t3Login({
        registration,
        print: () => {},
        onAuthorizeUrl: approve(oauth, (params) => params.delete("iss")),
      }),
    ).rejects.toThrow(/unexpected issuer/);
    expect(oauth.tokenRequests).toHaveLength(0);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("refuses read-only access", async () => {
    const oauth = await fakeOAuth();
    oauth.scope = "orchestration:read";
    const { registration, tokenFile } = registrationDir(oauth.origin);
    await expect(
      t3Login({ registration, print: () => {}, onAuthorizeUrl: approve(oauth) }),
    ).rejects.toThrow(/read-only/);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("fails closed when the token response omits scope", async () => {
    const oauth = await fakeOAuth();
    oauth.scope = "omit";
    const { registration, tokenFile } = registrationDir(oauth.origin);
    await expect(
      t3Login({ registration, print: () => {}, onAuthorizeUrl: approve(oauth) }),
    ).rejects.toThrow(/omitted scope/);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("status reports a malformed token file without its content", () => {
    const { registration, tokenFile } = registrationDir("http://127.0.0.1:3773");
    writeFileSync(tokenFile, `{"accessToken": "${TOKEN}"`);
    const lines: string[] = [];
    expect(t3Status({ registration, print: (line) => lines.push(line) })).toBe(false);
    expect(lines.join("\n")).toContain("malformed (invalid JSON)");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("refuses non-loopback origins", async () => {
    const { registration } = registrationDir("https://t3.example.com");
    await expect(t3Login({ registration, print: () => {} })).rejects.toThrow(/loopback/);
  });

  it("reports missing access without a token file", () => {
    const { registration } = registrationDir("http://127.0.0.1:3773");
    const lines: string[] = [];
    expect(t3Status({ registration, print: (line) => lines.push(line) })).toBe(false);
    expect(lines.join("\n")).toContain("wakewire t3 login");
  });

  it.runIf(process.platform === "win32")(
    "restricts the token file to the current user",
    async () => {
      const oauth = await fakeOAuth();
      const { registration, tokenFile } = registrationDir(oauth.origin);
      await t3Login({ registration, print: () => {}, onAuthorizeUrl: approve(oauth) });
      const acl = execFileSync("icacls", [tokenFile], { encoding: "utf8" });
      expect(acl).toContain(os.userInfo().username);
      expect(acl).not.toMatch(/BUILTIN\\Users|Everyone|Authenticated Users|SYSTEM|Administrators/i);
    },
  );
});
