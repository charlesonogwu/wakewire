#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { authGmail } from "./cli/auth-gmail.js";
import { authImap } from "./cli/auth-imap.js";
import { authSlack } from "./cli/auth-slack.js";
import { authWebhook } from "./cli/auth-webhook.js";
import { configGet, configList, configSet } from "./cli/config-cmd.js";
import { installService, uninstallService } from "./cli/service.js";
import {
  apiFetch,
  inspectDaemonState,
  readDaemonState,
  removeDaemonStateIfCurrent,
} from "./client.js";
import { loadConfig } from "./config.js";
import { runDaemon } from "./daemon/daemon.js";
import { openDatabase } from "./db/db.js";
import { createStores } from "./db/repos.js";
import { createLogger } from "./logging.js";
import { runMcpServer } from "./mcp/server.js";
import { logFilePath, wakewireHome } from "./paths.js";
import { refreshDesktopRegistration } from "./sinks/desktop-registration.js";
import { VERSION } from "./version.js";

const cliPath = fileURLToPath(import.meta.url);
const program = new Command();

program
  .name("wakewire")
  .description("Push external events (GitHub, Gmail) into local Codex threads")
  .version(VERSION);

program
  .command("init")
  .description("Create ~/.wakewire, run migrations, and generate the API token")
  .action(() => {
    fs.mkdirSync(wakewireHome(), { recursive: true });
    const db = openDatabase();
    const stores = createStores(db);
    loadConfig(stores.settings); // generates the API token on first run
    db.close();
    console.log(`Initialized ${wakewireHome()}`);
    console.log("Next steps:");
    console.log("  1. wakewire start            # or: wakewire service install");
    console.log("  2. Install the Codex plugin (see README) and say: $wakewire-setup");
  });

program
  .command("start")
  .description("Run the daemon (foreground by default)")
  .option("-d, --detach", "fork to the background and return")
  .action(async (opts: { detach?: boolean }) => {
    const existing = readDaemonState();
    if (existing) {
      const inspection = await inspectDaemonState(existing);
      if (inspection.status === "reachable") {
        console.error(`daemon already running (pid ${existing.pid}, port ${existing.port})`);
        process.exitCode = 1;
        return;
      }
      if (inspection.status === "uncertain") {
        console.error(
          `cannot verify daemon identity: ${inspection.detail}; refusing to start another`,
        );
        process.exitCode = 1;
        return;
      }
      if (!removeDaemonStateIfCurrent(existing)) {
        console.error("daemon state changed during inspection; refusing to start another");
        process.exitCode = 1;
        return;
      }
    }
    if (opts.detach) {
      const child = spawn(process.execPath, [cliPath, "start"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      console.log(`daemon starting in background (pid ${child.pid}). Logs: ${logFilePath()}`);
      return;
    }
    await runDaemon(createLogger({ daemon: true }));
  });

program
  .command("stop")
  .description("Stop the running daemon")
  .action(async () => {
    const state = readDaemonState();
    if (!state) {
      console.log("daemon is not running");
      return;
    }
    const inspection = await inspectDaemonState(state);
    if (inspection.status === "uncertain") {
      console.error(
        `cannot verify daemon identity: ${inspection.detail}; refusing to signal the pid`,
      );
      process.exitCode = 1;
      return;
    }
    if (inspection.status !== "reachable") {
      if (!removeDaemonStateIfCurrent(state)) {
        console.error("daemon state changed during inspection; shutdown outcome is uncertain");
        process.exitCode = 1;
        return;
      }
      console.log("daemon is not running");
      return;
    }
    const response = await apiFetch<{ ok?: boolean; error?: string }>("/api/shutdown", {
      method: "POST",
      body: { instanceId: state.instanceId },
    });
    if (response.status < 200 || response.status >= 300 || response.body.ok !== true) {
      throw new Error(response.body.error ?? "daemon rejected the shutdown request");
    }
    console.log(`shutdown requested for daemon instance ${state.instanceId}`);
  });

program
  .command("status")
  .description("Show daemon status, sources, and queue depth")
  .action(async () => {
    const state = readDaemonState();
    if (!state) {
      console.log("daemon: not running");
      return;
    }
    const inspection = await inspectDaemonState(state);
    if (inspection.status !== "reachable") {
      console.log(
        inspection.status === "uncertain"
          ? `daemon: identity uncertain (${inspection.detail})`
          : "daemon: not running",
      );
      return;
    }
    try {
      const health = await apiFetch("/api/health");
      console.log(JSON.stringify(health.body, null, 2));
    } catch (err) {
      console.log(
        `daemon: state file exists (pid ${state.pid}) but API is unreachable: ${err instanceof Error ? err.message : err}`,
      );
    }
  });

program
  .command("logs")
  .description("Show daemon logs")
  .option("-f, --follow", "follow the log")
  .option("-n, --lines <n>", "number of lines", "100")
  .action((opts: { follow?: boolean; lines: string }) => {
    if (!fs.existsSync(logFilePath())) {
      console.log(`no log file yet at ${logFilePath()}`);
      return;
    }
    const args = ["-n", opts.lines, ...(opts.follow ? ["-f"] : []), logFilePath()];
    spawn("tail", args, { stdio: "inherit" });
  });

const auth = program.command("auth").description("Authenticate event sources");
auth
  .command("gmail")
  .description("Run the Google OAuth flow for a gmail source")
  .option("--source <id>", "gmail source id (from wakewire_source_setup_gmail)")
  .option("--client-id <id>", "Google OAuth client id")
  .option("--client-secret <secret>", "Google OAuth client secret")
  .action(async (opts: { source?: string; clientId?: string; clientSecret?: string }) => {
    await authGmail(createLogger(), opts);
  });
auth
  .command("imap")
  .description(
    "Store the password for a password-authenticated mail source (e.g. a Gmail app password)",
  )
  .option(
    "--source <id>",
    'source id (from wakewire_source_setup_gmail with authKind "imap-password")',
  )
  .option(
    "--password <password>",
    "provide non-interactively (visible in shell history — prefer the prompt)",
  )
  .action(async (opts: { source?: string; password?: string }) => {
    await authImap(createLogger(), opts);
  });
auth
  .command("slack")
  .description("Store the Socket Mode tokens for a slack source (app-level xapp- and bot xoxb-)")
  .option("--source <id>", "slack source id (from wakewire_source_setup_slack)")
  .option("--app-token <token>", "app-level token (prefer the hidden prompt)")
  .option("--bot-token <token>", "bot token (prefer the hidden prompt)")
  .action(async (opts: { source?: string; appToken?: string; botToken?: string }) => {
    await authSlack(createLogger(), opts);
  });
auth
  .command("webhook")
  .description("Store a provider-issued signing secret for a generic webhook source")
  .option("--source <id>", "webhook source id (from wakewire_source_setup_webhook)")
  .option("--secret <secret>", "provide non-interactively (prefer the hidden prompt)")
  .action(async (opts: { source?: string; secret?: string }) => {
    await authWebhook(createLogger(), opts);
  });

const config = program.command("config").description("Read and write daemon settings");
config
  .command("list")
  .description("Show known settings, current values, and what they do")
  .action(() => configList());
config
  .command("get <key>")
  .description("Print a setting's current value")
  .action((key: string) => configGet(key));
config
  .command("set <key> <value>")
  .description("Set a setting, e.g. wakewire config set sink.adapter codex-app-server")
  .action(async (key: string, value: string) => {
    await configSet(key, value);
  });

const service = program.command("service").description("Run the daemon as a login service");
service
  .command("install")
  .description("Install a launchd agent (macOS) or systemd user unit (Linux)")
  .action(async () => {
    await installService(cliPath);
  });
service
  .command("uninstall")
  .description("Remove the launchd agent / systemd unit")
  .action(async () => {
    await uninstallService();
  });

program
  .command("desktop-refresh <registration>")
  .description("Refresh a registered Codex Desktop connector after an app restart or update")
  .action(async (registration: string) => {
    const changed = await refreshDesktopRegistration(registration);
    console.log(changed ? "Desktop registration refreshed" : "Desktop registration is current");
  });

program
  .command("mcp")
  .description("Run the wakewire MCP server on stdio (used by the Codex plugin)")
  .action(async () => {
    await runMcpServer();
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
