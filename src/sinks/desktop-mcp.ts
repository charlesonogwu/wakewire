import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DesktopToolClient } from "./codex-desktop.js";
import { PermanentError } from "./types.js";

/** Uses the user's installed bundled connector without copying its private protocol. */
export class DesktopMcpClient implements DesktopToolClient {
  private readonly clients = new Set<Client>();
  private closed = false;
  constructor(
    private readonly config: {
      serverPath: string;
      serverSha256: string;
      threadId: string;
      pipePath: string;
    },
  ) {
    if (
      !path.isAbsolute(config.serverPath) ||
      !/^[a-f0-9]{64}$/.test(config.serverSha256) ||
      !config.threadId ||
      !config.pipePath
    )
      throw new PermanentError("Incomplete Desktop connector registration");
    const hash = createHash("sha256").update(readFileSync(config.serverPath)).digest("hex");
    if (hash !== config.serverSha256)
      throw new PermanentError("Desktop connector changed; registration must be reverified");
  }
  private async connect(client: Client) {
    if (this.closed) throw new Error("Desktop connector closed");
    const hash = createHash("sha256").update(readFileSync(this.config.serverPath)).digest("hex");
    if (hash !== this.config.serverSha256)
      throw new PermanentError("Desktop connector changed; registration must be reverified");
    const env: Record<string, string> = {
      CODEX_APP_TOOLS_PIPE_PATH: this.config.pipePath,
      CODEX_THREAD_ID: this.config.threadId,
    };
    for (const name of [
      "SystemRoot",
      "WINDIR",
      "PATH",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "HOME",
      "CODEX_HOME",
      "TEMP",
      "TMP",
    ]) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [this.config.serverPath],
        env,
        stderr: "ignore",
      }),
    );
    const catalog = await client.listTools();
    for (const name of ["read_thread", "send_message_to_thread"])
      if (catalog.tools.filter((t) => t.name === name).length !== 1)
        throw new Error("Desktop connector tool catalog changed");
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (
      !["read_thread", "send_message_to_thread"].includes(name) ||
      args.threadId !== this.config.threadId ||
      args.hostId !== "local"
    )
      throw new PermanentError("Desktop connector request outside registered scope");
    // A fresh bundled-client process per request avoids poisoned connections
    // after app restarts. This is not a separate agent or app-server runtime.
    const client = new Client({ name: "wakewire-desktop", version: "0.1.0" });
    this.clients.add(client);
    try {
      await this.connect(client);
      return await client.callTool(
        { name, arguments: args, _meta: { threadId: this.config.threadId } },
        undefined,
        { timeout: 30000 },
      );
    } finally {
      this.clients.delete(client);
      await client.close();
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      for (const client of this.clients) void client.close();
      this.clients.clear();
    }
  }
}
