import { describe, expect, it } from "vitest";
import { parseRuntimeAdapter } from "./adapter.js";

describe("RuntimeAdapterSchema", () => {
  it("accepts callback ids and rejects arbitrary command strings", () => {
    const adapter = parseRuntimeAdapter({
      version: "1",
      repositoryId: "repo-a",
      allow: ["src/**"],
      deny: [".env"],
      runtimeTargetId: "target-a",
      busyCheckId: "busy",
      verifyCheckId: "verify",
      reloadId: "reload",
      rollback: "files",
      architecture: "x64",
      runtimeVersions: { python: "3.11" },
    });
    expect(adapter.rollback).toBe("files");
    expect(() => parseRuntimeAdapter({ ...adapter, rollback: "shell" })).toThrow();
  });
});
