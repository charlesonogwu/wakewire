import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Logger } from "../logging.js";
import type { T3Config, T3ToolClient } from "./t3-thread.js";
import { PermanentError, UnreachableError } from "./types.js";

/** Raised only before an MCP transport is opened: no request was submitted. */
export class T3BridgeUnavailableError extends UnreachableError {}

/** Port of the deployed MR T client: pinned bridge, inherited private user auth. */
export class T3McpClient implements T3ToolClient {
  private closed = false;
  private readonly clients = new Set<Client>();
  constructor(
    private readonly config: T3Config & { serverPath: string; serverSha256: string },
    private readonly logger: Logger,
  ) {
    if (!path.isAbsolute(config.serverPath) || !/^[a-f0-9]{64}$/.test(config.serverSha256))
      throw new PermanentError("Invalid T3 bridge registration");
  }
  private verify() {
    try {
      if (
        createHash("sha256").update(readFileSync(this.config.serverPath)).digest("hex") ===
        this.config.serverSha256
      )
        return;
    } catch {
      /* Missing/unreadable bridge is recoverable after re-registration. */
    }
    this.logger.error(
      { adapter: "t3-thread" },
      "re-register T3 bridge: pinned entry point is missing, unreadable or changed; deliveries held",
    );
    throw new T3BridgeUnavailableError(
      "re-register T3 bridge: pinned entry point is unavailable or changed",
    );
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const targets = [this.config, ...this.config.fallbackTargets];
    if (
      this.closed ||
      !["get_thread", "list_projects", "list_threads", "send_message"].includes(name) ||
      (["get_thread", "send_message"].includes(name) &&
        !targets.some((t) => t.threadId === args.threadId)) ||
      (name === "list_threads" && !targets.some((t) => t.projectId === args.projectId)) ||
      (name === "send_message" &&
        (args.deliveryMode !== "after-current" ||
          Object.keys(args).some((key) => !["threadId", "message", "deliveryMode"].includes(key))))
    )
      throw new PermanentError("T3 request outside registration scope");
    this.verify();
    const client = new Client({ name: "wakewire-t3", version: "0.1.0" });
    this.clients.add(client);
    const env: Record<string, string> = {};
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "PATH",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "HOME",
      "TEMP",
      "TMP",
    ]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [this.config.serverPath],
          env,
          stderr: "ignore",
        }),
      );
      return await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    } finally {
      this.clients.delete(client);
      await client.close();
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.clients].map((client) => client.close()));
  }
}
