import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Logger } from "../logging.js";
import { T3NotSubmittedError } from "./t3-mcp.js";
import type { T3Config, T3ToolClient } from "./t3-thread.js";
import { loopbackOrigin, readT3Token, tokenIsUsable } from "./t3-token.js";
import { PermanentError } from "./types.js";

/** The stored T3 access is missing, expired or rejected. Deliveries are held, never dropped. */
export class T3AuthRequiredError extends T3NotSubmittedError {}

export const REAPPROVE_MESSAGE =
  "re-approve T3 access: run `wakewire t3 login`; deliveries are held until then";

/** Logical adapter calls mapped onto T3 Code's own MCP tools. */
const TOOLS = {
  get_thread: "t3_thread_read",
  list_projects: "t3_project_list",
  list_threads: "t3_thread_list",
  send_message: "t3_thread_send",
} as const;
type Logical = keyof typeof TOOLS;
const ALLOWED_ARGS: Record<Logical, readonly string[]> = {
  get_thread: ["threadId", "view", "limit", "afterPosition", "maxCharsPerItem"],
  list_projects: ["limit", "cursor"],
  list_threads: ["projectId", "limit", "cursor", "settled"],
  send_message: ["threadId", "message", "mode", "clientRequestId"],
};

export interface OfficialT3Options {
  origin: string;
  tokenFile: string;
  /** Test seam; defaults to global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function isAuthFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === 401 ||
    code === 403 ||
    (error instanceof Error && error.constructor.name === "UnauthorizedError")
  );
}

/**
 * Talks to T3 Code's supported MCP endpoint (`<origin>/mcp`) with the bearer
 * token stored by `wakewire t3 login`. Registration scope is enforced here,
 * before any request leaves the process: only registered threads/projects, only
 * four tools, and sends in queue mode with an idempotency key.
 */
export class OfficialT3McpClient implements T3ToolClient {
  readonly dialect = "official" as const;
  private closed = false;
  private readonly clients = new Set<Client>();
  private resolved: Partial<Record<Logical, string>> = {};
  private readonly endpoint: URL;
  constructor(
    private readonly config: T3Config,
    private readonly options: OfficialT3Options,
    private readonly logger: Logger,
  ) {
    this.endpoint = new URL("/mcp", loopbackOrigin(options.origin));
  }

  /** Expiry of the stored token, for warnings. Never exposes the token itself. */
  tokenExpiresAt(): string | null {
    return readT3Token(this.options.tokenFile)?.expiresAt ?? null;
  }

  private inScope(name: string, args: Record<string, unknown>): name is Logical {
    if (!(name in TOOLS)) return false;
    const logical = name as Logical;
    if (Object.keys(args).some((key) => !ALLOWED_ARGS[logical].includes(key))) return false;
    const targets = [this.config, ...this.config.fallbackTargets];
    if (
      (logical === "get_thread" || logical === "send_message") &&
      !targets.some((t) => t.threadId === args.threadId)
    )
      return false;
    if (logical === "list_threads" && !targets.some((t) => t.projectId === args.projectId))
      return false;
    if (
      logical === "send_message" &&
      (args.mode !== "queue" ||
        typeof args.message !== "string" ||
        typeof args.clientRequestId !== "string" ||
        !args.clientRequestId)
    )
      return false;
    return true;
  }

  private bearer(): string {
    const token = readT3Token(this.options.tokenFile);
    const now = (this.options.now ?? Date.now)();
    if (!token || !tokenIsUsable(token, now)) {
      this.logger.error(
        {
          adapter: "t3-thread",
          transport: "t3-official-mcp",
          tokenFile: this.options.tokenFile,
          expiresAt: token?.expiresAt ?? null,
        },
        token
          ? `T3 access expired; ${REAPPROVE_MESSAGE}`
          : `No T3 access token; ${REAPPROVE_MESSAGE}`,
      );
      throw new T3AuthRequiredError("T3 access missing or expired: run `wakewire t3 login`");
    }
    return token.accessToken;
  }

  private rejected(status: unknown): never {
    this.logger.error(
      { adapter: "t3-thread", transport: "t3-official-mcp", status },
      `T3 rejected the stored access token; ${REAPPROVE_MESSAGE}`,
    );
    throw new T3AuthRequiredError("T3 rejected stored access: run `wakewire t3 login`");
  }

  /** Accept T3's own tool name, or a uniquely prefixed variant of it (verified via tools/list). */
  private async resolve(client: Client, logical: Logical): Promise<string> {
    const cached = this.resolved[logical];
    if (cached) return cached;
    const { tools } = await client.listTools(undefined, { timeout: 30000 });
    const names = tools.map((tool) => tool.name);
    for (const key of Object.keys(TOOLS) as Logical[]) {
      const base = TOOLS[key];
      const matches = names.includes(base)
        ? [base]
        : names.filter((name) => new RegExp(`^[A-Za-z0-9-]+(?:__|[_.:/])${base}$`).test(name));
      if (matches.length === 1 && matches[0]) this.resolved[key] = matches[0];
    }
    const found = this.resolved[logical];
    if (found) return found;
    this.logger.error(
      { adapter: "t3-thread", tool: TOOLS[logical] },
      "T3 MCP does not expose the expected tool; deliveries held",
    );
    throw new T3NotSubmittedError(`T3 MCP does not expose ${TOOLS[logical]}`);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed || !this.inScope(name, args))
      throw new PermanentError("T3 request outside registration scope");
    const token = this.bearer();
    const client = new Client({ name: "wakewire-t3", version: "0.1.0" });
    this.clients.add(client);
    const timeout = this.options.timeoutMs ?? 30000;
    try {
      // Everything up to callTool is provably pre-submission.
      try {
        await client.connect(
          // exactOptionalPropertyTypes: the SDK's sessionId getter is string | undefined.
          new StreamableHTTPClientTransport(this.endpoint, {
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          }) as Transport,
          { timeout },
        );
      } catch (error) {
        if (isAuthFailure(error)) this.rejected((error as { code?: unknown }).code ?? 401);
        this.logger.warn(
          { adapter: "t3-thread", transport: "t3-official-mcp" },
          "T3 MCP unreachable; deliveries held",
        );
        throw new T3NotSubmittedError("T3 MCP unreachable");
      }
      let tool: string;
      try {
        tool = await this.resolve(client, name);
      } catch (error) {
        if (error instanceof T3NotSubmittedError) throw error;
        if (isAuthFailure(error)) this.rejected((error as { code?: unknown }).code ?? 401);
        throw new T3NotSubmittedError("T3 MCP tool discovery failed");
      }
      try {
        return await client.callTool({ name: tool, arguments: args }, undefined, { timeout });
      } catch (error) {
        // An HTTP auth rejection means T3 never processed the call.
        if (isAuthFailure(error)) this.rejected((error as { code?: unknown }).code ?? 401);
        throw new Error("T3 MCP call failed");
      }
    } finally {
      this.clients.delete(client);
      await client.close().catch(() => {});
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.clients].map((client) => client.close()));
  }
}
