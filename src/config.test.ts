import { describe, expect, it } from "vitest";
import { loadConfig, settingKeys } from "./config.js";

function stubSettings(values: Record<string, string>) {
  return {
    get: (key: string) => values[key] ?? null,
    getOrCreate: (key: string, fallback: () => string) => values[key] ?? fallback(),
  } as unknown as Parameters<typeof loadConfig>[0];
}

describe("loadConfig muse settings", () => {
  it("parses sink.museYolo opt-in strictly", () => {
    expect(loadConfig(stubSettings({ [settingKeys.museYolo]: "1" })).museYolo).toBe(true);
    expect(loadConfig(stubSettings({})).museYolo).toBe(false);
    expect(loadConfig(stubSettings({ [settingKeys.museYolo]: "true" })).museYolo).toBe(false);
  });

  it("passes sink.musePath through when set", () => {
    expect(
      loadConfig(stubSettings({ [settingKeys.musePath]: "/usr/local/bin/muse" })).musePath,
    ).toBe("/usr/local/bin/muse");
    expect(loadConfig(stubSettings({})).musePath).toBeUndefined();
  });
});
