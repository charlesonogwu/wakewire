import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { loadConfig } from "../config.js";
import { DeliveryQueue } from "../core/queue.js";
import { matchRoutes } from "../core/router.js";
import { openDatabase } from "../db/db.js";
import { createStores } from "../db/repos.js";
import {
  acquireExclusiveOwnership,
  type ExclusiveOwner,
  releaseExclusiveOwnership,
} from "../exclusive-ownership.js";
import type { Logger } from "../logging.js";
import { daemonLockFilePath, stateFilePath, wakewireHome } from "../paths.js";
import { createSecretStore } from "../secrets/store.js";
import { createAdapter } from "../sinks/factory.js";
import { prepareWorktree } from "../sinks/worktree.js";
import { GithubWebhookSource } from "../sources/github/source.js";
import { VERSION } from "../version.js";
import { createApi } from "./api.js";
import { createGithubIngress, githubIngressConfig } from "./github-ingress.js";
import { SourceManager } from "./sources.js";

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  instanceId?: string;
  startedAt: string;
  version: string;
}

function publishState(state: DaemonState): void {
  const file = stateFilePath();
  const temporary = `${file}.${state.instanceId}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(handle, JSON.stringify(state, null, 2));
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (handle !== undefined) fs.closeSync(handle);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export class Daemon {
  private queue: DeliveryQueue | null = null;
  private sources: SourceManager | null = null;
  private server: Server | null = null;
  private ingressServer: Server | null = null;
  private adapter: import("../sinks/types.js").AgentAdapter | null = null;
  private db: ReturnType<typeof openDatabase> | null = null;
  private owner: ExclusiveOwner | null = null;
  private ownershipHandle: number | null = null;
  private publishedState: DaemonState | null = null;
  private stopping: Promise<void> | null = null;
  private readonly stopped: Promise<void>;
  private resolveStopped: (() => void) | null = null;

  constructor(private readonly logger: Logger) {
    this.stopped = new Promise((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  async start(): Promise<DaemonState> {
    fs.mkdirSync(wakewireHome(), { recursive: true });
    const instanceId = randomUUID();
    const owner = { pid: process.pid, instanceId };
    this.ownershipHandle = acquireExclusiveOwnership(daemonLockFilePath(), owner);
    this.owner = owner;
    try {
      return await this.startOwned(instanceId);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async startOwned(instanceId: string): Promise<DaemonState> {
    const ingress = githubIngressConfig(process.env);
    this.db = openDatabase();
    const stores = createStores(this.db);
    const config = loadConfig(stores.settings);
    const secrets = await createSecretStore(this.logger);
    const adapter = createAdapter(config, this.logger);
    this.adapter = adapter;

    const queue = new DeliveryQueue(stores, adapter, this.logger, {
      ratePerMinute: config.ratePerMinute,
      prepareWorktree: (_route, delivery) =>
        prepareWorktree((_route.target as { cwd: string }).cwd, delivery.id),
    });
    this.queue = queue;

    const sources = new SourceManager(stores, secrets, this.logger, (event) => {
      const routes = matchRoutes(stores.routes.listEnabled(), event);
      if (routes.length === 0) {
        this.logger.debug(
          { source: event.source, kind: event.kind, deliveryId: event.deliveryId },
          "event matched no routes",
        );
        return;
      }
      for (const route of routes) {
        queue.enqueueEvent(route, event);
      }
    });
    this.sources = sources;

    const startedAt = new Date().toISOString();
    const api = createApi({
      stores,
      queue,
      sources,
      secrets,
      adapter,
      config,
      logger: this.logger,
      startedAt,
      instanceId,
      requestShutdown: () => {
        void this.stop();
      },
    });

    const port = await new Promise<number>((resolve) => {
      const server = serve(
        { fetch: api.fetch, hostname: "127.0.0.1", port: config.apiPort },
        (info) => resolve(info.port),
      );
      this.server = server as Server;
    });

    const state: DaemonState = {
      pid: process.pid,
      port,
      token: config.apiToken,
      instanceId,
      startedAt,
      version: VERSION,
    };
    publishState(state);
    this.publishedState = state;

    queue.start();
    await sources.startAll();
    if (ingress) {
      const sourceRecord = stores.sources.get(ingress.sourceId);
      if (sourceRecord?.kind !== "github" || sourceRecord.config.mode !== "listen") {
        await this.stop();
        throw new Error("Dedicated ingress requires an existing listen-mode GitHub source");
      }
      const ingressApp = createGithubIngress(() => {
        const source = sources.get(ingress.sourceId);
        return source instanceof GithubWebhookSource ? source : undefined;
      });
      try {
        await new Promise<void>((resolve, reject) => {
          this.ingressServer = serve(
            { fetch: ingressApp.fetch, hostname: "127.0.0.1", port: ingress.port },
            () => resolve(),
          ) as Server;
          this.ingressServer.once("error", reject);
        });
      } catch (err) {
        await this.stop();
        throw err;
      }
    }

    this.logger.info(
      { port, adapter: adapter.name, version: VERSION },
      "wakewire daemon ready on 127.0.0.1",
    );
    return state;
  }

  waitUntilStopped(): Promise<void> {
    return this.stopped;
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopOwned().finally(() => {
      this.resolveStopped?.();
      this.resolveStopped = null;
    });
    return this.stopping;
  }

  private async stopOwned(): Promise<void> {
    this.logger.info("daemon shutting down");
    this.queue?.stop();
    await this.sources?.stopAll();
    // Kills adapter connections AND any shared app-server child it owns —
    // otherwise the hard exit below orphans the spawned server.
    await this.adapter?.close?.();
    await new Promise<void>((resolve) => {
      if (!this.ingressServer) return resolve();
      this.ingressServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.db?.close();
    try {
      const state = JSON.parse(fs.readFileSync(stateFilePath(), "utf8")) as DaemonState;
      if (
        this.publishedState?.instanceId &&
        state.instanceId === this.publishedState.instanceId &&
        state.pid === this.publishedState.pid
      ) {
        fs.unlinkSync(stateFilePath());
      }
    } catch {
      // state file already gone
    }
    if (this.ownershipHandle !== null && this.owner) {
      releaseExclusiveOwnership(daemonLockFilePath(), this.ownershipHandle, this.owner);
      this.ownershipHandle = null;
      this.owner = null;
    }
  }
}

/** Run the daemon in the foreground until SIGINT/SIGTERM. */
export async function runDaemon(logger: Logger): Promise<void> {
  const daemon = new Daemon(logger);
  await daemon.start();
  const shutdown = () => {
    void daemon.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await daemon.waitUntilStopped();
  process.off("SIGINT", shutdown);
  process.off("SIGTERM", shutdown);
  // Lingering source sockets (e.g. a tarpitted IMAP connect) must not keep a
  // cleanly-stopped daemon alive as a zombie.
  process.exit(0);
}
