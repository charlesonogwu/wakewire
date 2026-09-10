import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PrepushConfigSchema } from "./config.js";

const settings = {
  coordination: {
    expectedRepository: "example/project",
    localAgent: "codex",
    trustedAuthorIds: { codex: ["101"], hermes: ["202"] },
    waitingLabel: "waiting:operator",
    prepushEnabled: true,
  },
  exportHost: "agent@export.example",
  exportRoot: "/exports/candidates",
  stateRoot: resolve("synthetic-state"),
  image: `node@sha256:${"a".repeat(64)}`,
  trustedAuthorEmail: "agent@example.invalid",
};

describe("private prepush configuration", () => {
  it("accepts pinned inert configuration", () => {
    expect(PrepushConfigSchema.parse(settings)).toEqual(settings);
  });
  it.each([
    { exportHost: "-oProxyCommand=evil" },
    { exportHost: "agent@host;evil" },
    { exportHost: "host\n" },
    { exportHost: "user@-host" },
    { exportRoot: "/exports/../private" },
    { exportRoot: "/exports/./a" },
    { exportRoot: "/exports/a b" },
    { exportRoot: "relative" },
    { stateRoot: "relative" },
    { image: "node:22" },
    { image: `node@sha256:${"A".repeat(64)}` },
    { trustedAuthorEmail: "a\nb" },
    { trustedAuthorEmail: " " },
    { command: "evil" },
    { coordination: { ...settings.coordination, prepushEnabled: false } },
  ])("rejects unsafe configuration %j", (change) => {
    expect(PrepushConfigSchema.safeParse({ ...settings, ...change }).success).toBe(false);
  });
});
