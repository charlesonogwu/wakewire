import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DaemonConfig } from "../config.js";
import { CoordinationAdapter, CoordinationConfigSchema } from "../coordination/adapter.js";
import { CoordinationCompletionMonitor } from "../coordination/completion.js";
import { GithubSnapshotClient } from "../coordination/github.js";
import type { Logger } from "../logging.js";
import { CodexAppServerAdapter } from "./codex-app-server.js";
import { CodexDesktopAdapter } from "./codex-desktop.js";
import { CodexExecAdapter } from "./codex-exec.js";
import { CodexSdkAdapter } from "./codex-sdk.js";
import { RefreshingDesktopMcpClient } from "./desktop-refreshing-client.js";
import { MuseExecAdapter } from "./muse-exec.js";
import { T3McpClient } from "./t3-mcp.js";
import { OfficialT3McpClient } from "./t3-official-mcp.js";
import { type T3Config, T3ConfigSchema, T3ThreadAdapter } from "./t3-thread.js";
import { discoverT3Origin } from "./t3-token.js";
import type { AgentAdapter } from "./types.js";

const T3RegistrationBase = T3ConfigSchema.safeExtend({
  coordination: CoordinationConfigSchema.optional(),
});
/** Default transport: the pinned third-party stdio bridge (existing registrations). */
const T3BridgeRegistration = T3RegistrationBase.safeExtend({
  transport: z.literal("bridge").optional(),
  serverPath: z.string().refine(path.isAbsolute),
  serverSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** T3 Code's own MCP endpoint with a token from `wakewire t3 login`. Bridge pins may stay
 * in the file (ignored) so switching back is a one-line change. */
const T3OfficialRegistration = T3RegistrationBase.safeExtend({
  transport: z.literal("t3-official-mcp"),
  tokenFile: z.string().refine(path.isAbsolute),
  origin: z.string().optional(),
  serverPath: z.string().refine(path.isAbsolute).optional(),
  serverSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type T3Registration =
  | z.infer<typeof T3BridgeRegistration>
  | z.infer<typeof T3OfficialRegistration>;

export function parseT3Registration(raw: unknown): T3Registration {
  const transport = (raw as { transport?: unknown } | null)?.transport;
  return transport === "t3-official-mcp"
    ? T3OfficialRegistration.parse(raw)
    : T3BridgeRegistration.parse(raw);
}

function createT3Adapter(registration: T3Registration, logger: Logger): T3ThreadAdapter {
  const targetConfig: T3Config = T3ConfigSchema.parse({
    threadId: registration.threadId,
    environmentId: registration.environmentId,
    projectId: registration.projectId,
    cwd: registration.cwd,
    fallbackTargets: registration.fallbackTargets,
    stateFile: registration.stateFile,
    inheritPermissions: registration.inheritPermissions,
  });
  if (registration.transport === "t3-official-mcp") {
    const origin = discoverT3Origin(registration.origin);
    logger.info(
      { adapter: "t3-thread", transport: "t3-official-mcp", origin },
      "T3 sink uses T3 Code's MCP endpoint",
    );
    const client = new OfficialT3McpClient(
      targetConfig,
      { origin, tokenFile: registration.tokenFile },
      logger,
    );
    return new T3ThreadAdapter(targetConfig, client, logger);
  }
  return new T3ThreadAdapter(targetConfig, new T3McpClient(registration, logger), logger);
}

export function createAdapter(config: DaemonConfig, logger: Logger): AgentAdapter {
  switch (config.adapter) {
    case "t3-thread": {
      const file = process.env.WAKEWIRE_T3_REGISTRATION;
      if (!file) throw new Error("T3 adapter requires explicit local registration");
      const registration = parseT3Registration(JSON.parse(readFileSync(file, "utf8")));
      const t3 = createT3Adapter(registration, logger);
      if (!registration.coordination) return t3;
      const snapshots = new GithubSnapshotClient(registration.coordination.expectedRepository);
      const completion = new CoordinationCompletionMonitor({
        dbFile: registration.stateFile,
        config: registration.coordination,
        snapshots,
        inner: t3,
      });
      const adapter = new CoordinationAdapter(registration.coordination, snapshots, t3, completion);
      completion.start();
      return adapter;
    }
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
          coordination: CoordinationConfigSchema.optional(),
        })
        .strict()
        .parse(JSON.parse(readFileSync(file, "utf8")));
      const desktop = new CodexDesktopAdapter(registration, new RefreshingDesktopMcpClient(file));
      if (!registration.coordination) return desktop;
      const snapshots = new GithubSnapshotClient(registration.coordination.expectedRepository);
      const completion = new CoordinationCompletionMonitor({
        dbFile: registration.stateFile,
        config: registration.coordination,
        snapshots,
        inner: desktop,
      });
      const adapter = new CoordinationAdapter(
        registration.coordination,
        snapshots,
        desktop,
        completion,
      );
      completion.start();
      return adapter;
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
    case "muse-exec":
      return new MuseExecAdapter(logger, {
        musePath: config.musePath,
        yolo: config.museYolo,
      });
    default:
      return new CodexSdkAdapter(logger, {
        codexPath: config.codexPath,
        model: config.model,
      });
  }
}
