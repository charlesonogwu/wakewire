import { execFile } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}
export type Command = (
  file: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

/** Never return execFile's error message: it embeds arguments and possibly secrets. */
export const command: Command = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeout ?? 120_000,
        maxBuffer: 8 * 1024 * 1024,
        killSignal: "SIGKILL",
        ...options,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 125) : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });

export function hostEnvironment(): NodeJS.ProcessEnv {
  // Only host processes inherit authentication. Drop Git/Node injection knobs.
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GIT_|NODE_OPTIONS$|LD_PRELOAD$|LD_LIBRARY_PATH$)/i.test(key),
    ),
  );
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...hostEnvironment(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}
