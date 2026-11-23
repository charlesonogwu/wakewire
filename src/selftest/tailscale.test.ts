import { describe, expect, it } from "vitest";
import type { Funnel } from "./route.js";
import {
  canonicalJson,
  createTailscale,
  serveStatus,
  type Tailscale,
  tailscaleBinary,
  toggleFunnel,
} from "./tailscale.js";

const FUNNEL: Funnel = { host: "host.example.ts.net", port: 8443, target: "http://127.0.0.1:8769" };
const CONFIG = {
  TCP: { "5173": { HTTPS: true }, "8443": { HTTPS: true } },
  Web: {
    "host.example.ts.net:5173": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } },
    "host.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8769" } } },
  },
  AllowFunnel: { "host.example.ts.net:8443": true },
};

/** A fake tailscale CLI: records every call and answers from a script. */
function fakeTailscale(script: {
  statuses?: unknown[];
  fail?: (args: string[], call: number) => boolean;
  backend?: string;
}) {
  const calls: string[][] = [];
  const statuses = [...(script.statuses ?? [CONFIG, CONFIG])];
  const tailscale: Tailscale = async (args) => {
    calls.push(args);
    if (script.fail?.(args, calls.length)) return { ok: false, stdout: "" };
    if (args[0] === "status")
      return { ok: true, stdout: JSON.stringify({ BackendState: script.backend ?? "Running" }) };
    if (args[0] === "serve") {
      const next = statuses.shift();
      return next === undefined
        ? { ok: false, stdout: "" }
        : { ok: true, stdout: JSON.stringify(next) };
    }
    return { ok: true, stdout: "" };
  };
  return { tailscale, calls };
}

describe("toggleFunnel", () => {
  it("turns only this port's funnel off and on again with Tailscale's own target", async () => {
    const { tailscale, calls } = fakeTailscale({});
    expect(await toggleFunnel(tailscale, FUNNEL)).toMatchObject({
      outcome: "toggled",
      identical: true,
    });
    expect(calls).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
      ["funnel", "--https=8443", "off"],
      ["funnel", "--bg", "--https=8443", "http://127.0.0.1:8769"],
      ["serve", "status", "--json"],
    ]);
  });
  it("compares the whole serve config, so a lost neighbour is reported with both versions", async () => {
    const after = {
      ...CONFIG,
      Web: { "host.example.ts.net:8443": CONFIG.Web["host.example.ts.net:8443"] },
    };
    const result = await toggleFunnel(
      fakeTailscale({ statuses: [CONFIG, after] }).tailscale,
      FUNNEL,
    );
    expect(result).toMatchObject({ outcome: "toggled", identical: false });
    if (result.outcome !== "toggled") throw new Error("unreachable");
    expect(result.before).toContain("5173");
    expect(result.after).not.toContain("127.0.0.1:5173");
  });
  it("changes nothing when the config cannot be read or turning off fails", async () => {
    const unreadable = fakeTailscale({ statuses: [] });
    expect(await toggleFunnel(unreadable.tailscale, FUNNEL)).toEqual({
      outcome: "status-unavailable",
    });
    expect(unreadable.calls).toHaveLength(2);
    const offFails = fakeTailscale({ fail: (args) => args.includes("off") });
    expect(await toggleFunnel(offFails.tailscale, FUNNEL)).toEqual({ outcome: "off-failed" });
    expect(offFails.calls.some((args) => args.includes("--bg"))).toBe(false);
  });
  it("retries turning on once, then reports the removed route with the exact restore command", async () => {
    const once = fakeTailscale({ fail: (args, call) => args.includes("--bg") && call === 3 });
    expect(await toggleFunnel(once.tailscale, FUNNEL)).toMatchObject({ outcome: "toggled" });
    const twice = fakeTailscale({ fail: (args) => args.includes("--bg") });
    const result = await toggleFunnel(twice.tailscale, FUNNEL);
    expect(result).toMatchObject({
      outcome: "route-removed",
      restore: "tailscale funnel --bg --https=8443 http://127.0.0.1:8769",
    });
    expect(twice.calls.filter((args) => args.includes("--bg"))).toHaveLength(2);
  });
});

describe("toggleFunnel when Tailscale itself is down", () => {
  it("touches nothing while the node is logged out or stopped", async () => {
    for (const backend of ["NeedsLogin", "Stopped"]) {
      const down = fakeTailscale({ backend });
      expect(await toggleFunnel(down.tailscale, FUNNEL)).toEqual({
        outcome: "not-running",
        state: backend,
      });
      expect(down.calls).toEqual([["status", "--json"]]);
    }
  });
});

describe("tailscale helpers", () => {
  it("compares configs by content, not key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
  it("finds the CLI from the environment, the Windows install, or PATH", () => {
    expect(tailscaleBinary({ WAKEWIRE_TAILSCALE_PATH: "/opt/ts" }, () => false, "linux")).toBe(
      "/opt/ts",
    );
    expect(tailscaleBinary({}, () => true, "win32")).toBe(
      "C:\\Program Files\\Tailscale\\tailscale.exe",
    );
    expect(tailscaleBinary({}, () => false, "win32")).toBe("tailscale");
  });
  it("returns only the exit status and stdout, never error text", async () => {
    const tailscale = createTailscale("tailscale", async () => ({
      code: 1,
      stdout: "",
      stderr: "secret-ish detail",
    }));
    expect(await tailscale(["serve", "status", "--json"])).toEqual({ ok: false, stdout: "" });
    expect(await serveStatus(async () => ({ ok: true, stdout: "not json" }))).toBeNull();
  });
});
