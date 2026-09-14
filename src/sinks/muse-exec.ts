import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../logging.js";
import type { AgentAdapter, DeliveryOptions, DeliveryResult } from "./types.js";
import { PermanentError, UnreachableError } from "./types.js";

export interface MuseExecAdapterConfig {
  musePath?: string | undefined;
  /** Cap model steps per delivery so an unattended turn always terminates. */
  maxModelSteps?: number | undefined;
  /**
   * When true, pass --yolo (approval + sandbox off, workspace trusted).
   * Default false: runs with --trust-workspace and on-request approvals,
   * so credentialed/destructive turns pause instead of acting.
   */
  yolo?: boolean | undefined;
}

/**
 * Headless sink shelling out to `muse exec`. Same role as the codex-exec
 * adapter: maximum-compatibility delivery against an installed CLI, with
 * the prompt passed via --prompt-file so long prompts never hit argv
 * limits. WakeWire thread ids map 1:1 onto Muse session ids.
 */
export class MuseExecAdapter implements AgentAdapter {
  readonly name = "muse-exec";

  constructor(
    private readonly logger: Logger,
    private readonly config: MuseExecAdapterConfig = {},
  ) {}

  async deliverToThread(
    threadId: string,
    prompt: string,
    opts: DeliveryOptions,
  ): Promise<DeliveryResult> {
    const { args, promptFile } = this.baseArgs(opts);
    args.push("--session-id", threadId, "--prompt-file", promptFile);
    try {
      const { stdout } = await this.run(args, threadId, prompt, promptFile);
      return { threadId, finalResponse: parseFinalResponse(stdout) };
    } finally {
      unlinkQuiet(promptFile);
    }
  }

  async startThread(prompt: string, opts: DeliveryOptions): Promise<DeliveryResult> {
    const { args, promptFile } = this.baseArgs(opts, { cd: true });
    args.push("--prompt-file", promptFile);
    try {
      const { stdout } = await this.run(args, null, prompt, promptFile);
      const threadId = parseMuseSessionId(stdout);
      if (!threadId) throw new UnreachableError("muse exec did not report a session id");
      return { threadId, finalResponse: parseFinalResponse(stdout) };
    } finally {
      unlinkQuiet(promptFile);
    }
  }

  async probe(): Promise<boolean> {
    try {
      await this.spawnCollect(["--version"], 10_000);
      return true;
    } catch {
      return false;
    }
  }

  private baseArgs(
    opts: DeliveryOptions,
    flags: { cd?: boolean } = {},
  ): { args: string[]; promptFile: string } {
    const promptFile = path.join(
      os.tmpdir(),
      `wakewire-muse-prompt-${process.pid}-${Math.random().toString(36).slice(2)}.txt`,
    );
    const args = [
      "exec",
      "--json",
      "--trust-workspace",
      "--max-model-steps",
      String(this.config.maxModelSteps ?? 60),
    ];
    if (this.config.yolo) {
      args.push("--yolo");
    }
    if (flags.cd && opts.cwd) args.push("--workspace", opts.cwd);
    else if (opts.cwd) args.push("--workspace", opts.cwd);
    return { args, promptFile };
  }

  private async run(
    args: string[],
    threadId: string | null,
    prompt: string,
    promptFile: string,
  ): Promise<{ stdout: string }> {
    fs.writeFileSync(promptFile, prompt, "utf8");
    try {
      return await this.spawnCollect(args, 30 * 60_000);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT/i.test(message)) {
        throw new UnreachableError(`muse CLI not found: ${message}`);
      }
      if (
        threadId &&
        /(no.*(session|thread|conversation).*(found|exists))|not found|unknown session/i.test(
          message,
        )
      ) {
        throw new PermanentError(`session ${threadId} not found: ${message}`);
      }
      throw err instanceof Error ? err : new Error(message);
    }
  }

  private spawnCollect(args: string[], timeoutMs: number): Promise<{ stdout: string }> {
    const bin = this.config.musePath ?? "muse";
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`muse ${args[0]} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout });
        } else {
          this.logger.debug({ code, stderr: stderr.slice(-2000) }, "muse exec failed");
          reject(new Error(`muse exited with code ${code}: ${stderr.slice(-500).trim()}`));
        }
      });
    });
  }
}

/** Find a Muse session id in a `muse exec --json` JSONL event stream. */
export function parseMuseSessionId(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ["session_id", "sessionId", "thread_id", "threadId"]) {
        if (typeof event[key] === "string" && (event[key] as string).length > 0) {
          return event[key] as string;
        }
      }
    } catch {
      // non-JSON noise on stdout — ignore
    }
  }
  return null;
}

/**
 * Best-effort final assistant text from a `muse exec --json` stream.
 * Shapes vary by provider/preset, so this scans common text-bearing
 * fields and returns the last non-empty hit. May be undefined.
 */
export function parseFinalResponse(jsonl: string): string | undefined {
  let last: string | undefined;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const candidates = [
        event["final_response"],
        event["finalResponse"],
        event["last_message"],
        event["lastMessage"],
        event["text"],
        event["output_text"],
      ];
      for (const c of candidates) {
        if (typeof c === "string" && c.trim().length > 0) last = c.trim();
      }
    } catch {
      // non-JSON noise on stdout — ignore
    }
  }
  return last;
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // prompt file already gone — nothing to do
  }
}
