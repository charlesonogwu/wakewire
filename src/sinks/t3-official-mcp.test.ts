import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { T3NotSubmittedError } from "./t3-mcp.js";
import { OfficialT3McpClient, T3AuthRequiredError } from "./t3-official-mcp.js";
import type { T3Config } from "./t3-thread.js";
import { loadT3Token, writeT3Token } from "./t3-token.js";
import { PermanentError, UnreachableError } from "./types.js";

const TOKEN = "synthetic-secret-token-value-123";
const dirs: string[] = [];
const servers: http.Server[] = [];
const clients: OfficialT3McpClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeT3 {
  origin: string;
  requests: number;
  calls: { name: string; args: Record<string, unknown> }[];
  status: number;
}
/** A local stand-in for T3 Code's /mcp: bearer-checked, stateless Streamable HTTP. */
async function fakeT3(prefix = ""): Promise<FakeT3> {
  const state: FakeT3 = { origin: "", requests: 0, calls: [], status: 200 };
  const server = http.createServer(async (req, res) => {
    state.requests++;
    if (state.status !== 200 || req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(state.status === 200 ? 401 : state.status, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: "invalid_mcp_credential" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const mcp = new Server({ name: "fake-t3", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ["t3_thread_read", "t3_thread_send", "t3_thread_list", "t3_project_list", "other"].map(
        (name) => ({ name: `${prefix}${name}`, inputSchema: { type: "object" as const } }),
      ),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      state.calls.push({
        name: request.params.name,
        args: (request.params.arguments ?? {}) as Record<string, unknown>,
      });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    });
    // Stateless mode: no session ID generator.
    const transport = new StreamableHTTPServerTransport({});
    await mcp.connect(transport as Transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

interface SetupExtra {
  tokenOrigin?: string;
  /** Omit to discover the origin from runtimeFile instead of pinning it. */
  pinned?: boolean;
  runtimeFile?: string;
  now?: () => number;
}
function setup(origin: string, expiresInMs = 10 * 24 * 60 * 60 * 1000, extra: SetupExtra = {}) {
  const tokenOrigin = extra.tokenOrigin ?? origin;
  const dir = mkdtempSync(path.join(os.tmpdir(), "wakewire-t3-official-"));
  dirs.push(dir);
  const tokenFile = path.join(dir, "token.json");
  if (expiresInMs !== 0)
    writeT3Token(tokenFile, {
      version: 1,
      origin: tokenOrigin,
      resource: `${tokenOrigin}/mcp`,
      clientId: "client",
      scope: "orchestration:read orchestration:operate",
      accessToken: TOKEN,
      obtainedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    });
  const config: T3Config = {
    threadId: "primary",
    environmentId: "env",
    projectId: "project",
    cwd: dir,
    fallbackTargets: [{ threadId: "fallback", environmentId: "env", projectId: "p2", cwd: dir }],
    stateFile: path.join(dir, "receipts.db"),
    inheritPermissions: true,
  };
  const lines: string[] = [];
  const logger = pino(
    { level: "debug" },
    new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    }),
  );
  const client = new OfficialT3McpClient(
    config,
    {
      ...(extra.pinned === false ? {} : { origin }),
      tokenFile,
      runtimeFile: extra.runtimeFile,
      ...(extra.now ? { now: extra.now } : {}),
    },
    logger,
  );
  clients.push(client);
  return { client, lines, tokenFile, dir };
}

describe("OfficialT3McpClient", () => {
  it("rejects every call outside the registration before any request", async () => {
    const t3 = await fakeT3();
    const { client } = setup(t3.origin);
    const send = { threadId: "primary", message: "m", mode: "queue", clientRequestId: "id" };
    for (const [name, args] of [
      ["get_thread", { threadId: "stranger" }],
      ["list_threads", { projectId: "project" }],
      ["send_message", { ...send, threadId: "stranger" }],
      ["send_message", { ...send, mode: "steer" }],
      ["send_message", { ...send, mode: "auto" }],
      ["send_message", { threadId: "primary", message: "m", mode: "queue" }],
      ["send_message", { ...send, clientRequestId: "" }],
      ["send_message", { ...send, extra: true }],
      ["get_thread", { threadId: "primary", includeSubagents: true }],
      ["t3_thread_send", send],
      ["t3_project_delete", { projectId: "project" }],
    ] as const)
      await expect(client.call(name, args)).rejects.toBeInstanceOf(PermanentError);
    expect(t3.requests).toBe(0);
  });

  it("maps logical calls onto T3's own tools with a bearer token", async () => {
    const t3 = await fakeT3();
    const { client } = setup(t3.origin);
    await client.call("get_thread", { threadId: "fallback", view: "messages", limit: 1 });
    await client.call("list_projects", { limit: 100 });
    const result = await client.call("send_message", {
      threadId: "primary",
      message: "hello",
      mode: "queue",
      clientRequestId: "wakewire-abc",
    });
    expect(result).toMatchObject({ content: [{ type: "text" }] });
    expect(t3.calls).toEqual([
      { name: "t3_thread_read", args: { threadId: "fallback", view: "messages", limit: 1 } },
      { name: "t3_project_list", args: { limit: 100 } },
      {
        name: "t3_thread_send",
        args: {
          threadId: "primary",
          message: "hello",
          mode: "queue",
          clientRequestId: "wakewire-abc",
        },
      },
    ]);
  });

  it("resolves prefixed tool names from tools/list", async () => {
    const t3 = await fakeT3("t3-code__");
    const { client } = setup(t3.origin);
    await client.call("list_projects", {});
    expect(t3.calls.map((call) => call.name)).toEqual(["t3-code__t3_project_list"]);
  });

  it("holds with a re-approve error on 401 and never logs the token", async () => {
    const t3 = await fakeT3();
    t3.status = 401;
    const { client, lines } = setup(t3.origin);
    const error = await client.call("list_projects", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(T3AuthRequiredError);
    expect(error).toBeInstanceOf(T3NotSubmittedError);
    expect(error).toBeInstanceOf(UnreachableError);
    expect(lines.join("")).toContain("re-approve T3 access");
    expect(lines.join("")).not.toContain(TOKEN);
    expect(String(error)).not.toContain(TOKEN);
  });

  it("treats a 403 the same way", async () => {
    const t3 = await fakeT3();
    t3.status = 403;
    const { client } = setup(t3.origin);
    await expect(client.call("list_projects", {})).rejects.toBeInstanceOf(T3AuthRequiredError);
  });

  it("refuses to call T3 with a missing or expired token", async () => {
    const t3 = await fakeT3();
    const missing = setup(t3.origin, 0);
    await expect(missing.client.call("list_projects", {})).rejects.toBeInstanceOf(
      T3AuthRequiredError,
    );
    const expired = setup(t3.origin, -1000);
    await expect(expired.client.call("list_projects", {})).rejects.toBeInstanceOf(
      T3AuthRequiredError,
    );
    expect(t3.requests).toBe(0);
    expect(expired.lines.join("")).toContain("T3 access expired");
    expect(expired.lines.join("")).not.toContain(TOKEN);
  });

  it("reports an unreachable T3 as provably unsent", async () => {
    const t3 = await fakeT3();
    const { client } = setup(t3.origin);
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await expect(client.call("list_projects", {})).rejects.toBeInstanceOf(T3NotSubmittedError);
  });

  it("exposes only the expiry, never the token, and logs no token on success", async () => {
    const t3 = await fakeT3();
    const { client, lines } = setup(t3.origin);
    expect(client.tokenExpiresAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await client.call("list_projects", {});
    expect(lines.join("")).not.toContain(TOKEN);
  });

  it("refuses a token issued for another origin with an origin-changed log", async () => {
    const t3 = await fakeT3();
    const { client, lines } = setup(t3.origin, undefined, { tokenOrigin: "http://127.0.0.1:1" });
    await expect(client.call("list_projects", {})).rejects.toBeInstanceOf(T3AuthRequiredError);
    expect(t3.requests).toBe(0);
    expect(lines.join("")).toContain("origin changed: re-run `wakewire t3 login`");
    expect(lines.join("")).not.toContain(TOKEN);
  });

  it("re-discovers the origin once after a connection failure", async () => {
    const live = await fakeT3();
    const dead = await fakeT3();
    const deadServer = servers.pop();
    deadServer?.closeAllConnections();
    await new Promise((resolve) => deadServer?.close(resolve));
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wakewire-t3-runtime-"));
    dirs.push(runtimeDir);
    const runtimeFile = path.join(runtimeDir, "server-runtime.json");
    writeFileSync(runtimeFile, JSON.stringify({ origin: dead.origin }));
    // Approved against the old origin; T3 is still there, so the call is just unreachable.
    const { client, lines } = setup(dead.origin, undefined, { pinned: false, runtimeFile });
    await expect(client.call("list_projects", {})).rejects.toBeInstanceOf(T3NotSubmittedError);
    await expect(client.call("list_projects", {})).rejects.not.toBeInstanceOf(T3AuthRequiredError);
    // T3 restarts on another port: the next call re-discovers it and asks for a new login.
    writeFileSync(runtimeFile, JSON.stringify({ origin: live.origin }));
    await expect(client.call("list_projects", {})).rejects.toBeInstanceOf(T3AuthRequiredError);
    expect(client.currentOrigin()).toBe(live.origin);
    expect(lines.join("")).toContain("origin changed: re-run `wakewire t3 login`");
    expect(live.requests).toBe(0);
  });

  it("never re-discovers a pinned origin", async () => {
    const t3 = await fakeT3();
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "wakewire-t3-runtime-"));
    dirs.push(runtimeDir);
    const runtimeFile = path.join(runtimeDir, "server-runtime.json");
    writeFileSync(runtimeFile, JSON.stringify({ origin: t3.origin }));
    const pinned = setup("http://127.0.0.1:9", undefined, { runtimeFile });
    await expect(pinned.client.call("list_projects", {})).rejects.toBeInstanceOf(
      T3NotSubmittedError,
    );
    expect(pinned.client.currentOrigin()).toBe("http://127.0.0.1:9");
    expect(t3.requests).toBe(0);
  });

  it("logs re-approve at most once per 10 minutes", async () => {
    const t3 = await fakeT3();
    let now = Date.now();
    const { client, lines } = setup(t3.origin, -1000, { now: () => now });
    for (let i = 0; i < 3; i++)
      await expect(client.call("list_projects", {})).rejects.toBeInstanceOf(T3AuthRequiredError);
    const count = () => lines.filter((line) => line.includes("re-approve T3 access")).length;
    expect(count()).toBe(1);
    now += 9 * 60 * 1000;
    await client.call("list_projects", {}).catch(() => {});
    expect(count()).toBe(1);
    now += 60 * 1000;
    await client.call("list_projects", {}).catch(() => {});
    expect(count()).toBe(2);
  });

  it("names malformed and unreadable token files without logging their content", async () => {
    const t3 = await fakeT3();
    const { client, lines, tokenFile, dir } = setup(t3.origin, 0);
    writeFileSync(tokenFile, `{"accessToken": "${TOKEN}"`);
    await expect(client.call("list_projects", {})).rejects.toBeInstanceOf(T3AuthRequiredError);
    expect(lines.join("")).toContain("malformed (invalid JSON)");
    writeFileSync(tokenFile, JSON.stringify({ version: 1, accessToken: TOKEN }));
    expect(loadT3Token(tokenFile)).toMatchObject({ status: "malformed" });
    expect(JSON.stringify(loadT3Token(tokenFile))).not.toContain(TOKEN);
    expect(loadT3Token(dir)).toMatchObject({ status: "unreadable" });
    expect(loadT3Token(path.join(dir, "absent.json"))).toEqual({ status: "missing" });
    expect(lines.join("")).not.toContain(TOKEN);
  });

  it("only accepts loopback origins", () => {
    expect(
      () =>
        new OfficialT3McpClient(
          {} as T3Config,
          { origin: "https://example.com", tokenFile: "x" },
          pino({ level: "silent" }),
        ),
    ).toThrow(/loopback/);
  });
});
