import { afterEach, expect, it, vi } from "vitest";
import { command, gitEnvironment, hostEnvironment } from "./process.js";

afterEach(() => vi.unstubAllEnvs());
it("passes shell metacharacters as inert argv and reports the actual child exit", async () => {
  const result = await command(process.execPath, [
    "-e",
    "process.stdout.write(process.argv[1]); process.exitCode=19",
    ";$(echo secret)&",
  ]);
  expect(result).toEqual({ code: 19, stdout: ";$(echo secret)&", stderr: "" });
});
it("bounds execution time", async () => {
  const result = await command(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    timeout: 100,
  });
  expect(result.code).toBe(125);
});
it("bounds captured output", async () => {
  const result = await command(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(9*1024*1024))",
  ]);
  expect(result.code).not.toBe(0);
  expect(result.stdout.length).toBeLessThanOrEqual(8 * 1024 * 1024);
});
it("clears host Git and runtime injection without copying it into private Git configuration", () => {
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "secret");
  vi.stubEnv("GIT_DIR", "foreign");
  vi.stubEnv("NODE_OPTIONS", "--require=evil");
  expect(hostEnvironment()).not.toHaveProperty("GIT_DIR");
  expect(hostEnvironment()).not.toHaveProperty("NODE_OPTIONS");
  expect(gitEnvironment()).not.toHaveProperty("GIT_CONFIG_VALUE_0");
  expect(gitEnvironment()).toMatchObject({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
});
