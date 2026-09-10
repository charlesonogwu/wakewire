import { readFileSync } from "node:fs";
import { z } from "zod";
import type { DaemonConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { CodexDesktopAdapter } from "./codex-desktop.js";
import { CodexExecAdapter } from "./codex-exec.js";
import { CodexSdkAdapter } from "./codex-sdk.js";
import { DesktopMcpClient } from "./desktop-mcp.js";
import type { AgentAdapter } from "./types.js";

export function createAdapter(config: DaemonConfig, logger: Logger): AgentAdapter {
  switch (config.adapter) {
    case "codex-desktop": {
      const file = process.env.WAKEWIRE_DESKTOP_REGISTRATION;
      if (!file) throw new Error("Desktop adapter requires explicit local registration");
      const registration = z
        .object({
          threadId: z.string().min(1),
          cwd: z.string().min(1),
          stateFile: z.string().min(1),
          inheritPermissions: z.literal(true),
          serverPath: z.string().min(1),
          serverSha256: z.string().regex(/^[a-f0-9]{64}$/),
          pipePath: z.string().min(1),
        })
        .strict()
        .parse(JSON.parse(readFileSync(file, "utf8")));
      return new CodexDesktopAdapter(registration, new DesktopMcpClient(registration));
    }
    case "codex-app-server":
      return new CodexAppServerAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
        connection: config.appServerConnection,
        listenUrl: config.appServerListen,
      });
    case "codex-exec":
      return new CodexExecAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
      });
    default:
      return new CodexSdkAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
      });
  }
}
