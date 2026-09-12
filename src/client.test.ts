import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, inspectDaemonState } from "./client.js";
import type { DaemonState } from "./daemon/daemon.js";

const state: DaemonState = {
  pid: 1234,
  port: 57100,
  token: "test-token",
  instanceId: "instance-1",
  startedAt: "2026-09-12T00:00:00.000Z",
  version: "0.1.0",
};

const homes: string[] = [];
const originalHome = process.env.WAKEWIRE_HOME;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.WAKEWIRE_HOME;
  else process.env.WAKEWIRE_HOME = originalHome;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function installState(): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wakewire-client-"));
  homes.push(home);
  process.env.WAKEWIRE_HOME = home;
  fs.writeFileSync(path.join(home, "daemon.json"), JSON.stringify(state));
}

function stalledJsonResponse(signal: AbortSignal | null | undefined): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  } as Response;
}

describe("apiFetch", () => {
  it("verifies public daemon identity before sending the bearer token", async () => {
    installState();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ service: "wakewire", instanceId: state.instanceId, pid: 1234 }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ routes: [] }), { status: 200 }));
    vi.stubGlobal("fetch", request);

    await expect(apiFetch("/api/routes")).resolves.toEqual({ status: 200, body: { routes: [] } });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[0]).toBe("http://127.0.0.1:57100/api/identity");
    expect(request.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(request.mock.calls[1]?.[0]).toBe("http://127.0.0.1:57100/api/routes");
    expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer test-token",
    });
  });

  it("does not disclose the token when public identity mismatches", async () => {
    installState();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ service: "wakewire", instanceId: "replacement", pid: 1234 })),
      );
    vi.stubGlobal("fetch", request);

    await expect(apiFetch("/api/routes")).rejects.toThrow(/identity/i);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("never retries an authenticated write after its response is lost", async () => {
    installState();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ service: "wakewire", instanceId: state.instanceId, pid: 1234 }),
        ),
      )
      .mockRejectedValueOnce(new Error("response lost"));
    vi.stubGlobal("fetch", request);

    await expect(
      apiFetch("/api/routes", { method: "POST", body: { name: "one" } }),
    ).rejects.toMatchObject({ name: "DaemonRequestUncertainError" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled authenticated health response body", async () => {
    vi.useFakeTimers();
    installState();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ service: "wakewire", instanceId: state.instanceId, pid: 1234 }),
        ),
      )
      .mockImplementationOnce(async (_input, init) => stalledJsonResponse(init?.signal));
    vi.stubGlobal("fetch", request);

    const health = apiFetch("/api/health");
    const assertion = expect(health).rejects.toThrow(/deadline|timed out/i);
    await vi.runAllTimersAsync();

    await assertion;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports an uncertain outcome when a delivered mutation stalls while parsing", async () => {
    vi.useFakeTimers();
    installState();
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ service: "wakewire", instanceId: state.instanceId, pid: 1234 }),
        ),
      )
      .mockImplementationOnce(async (_input, init) => stalledJsonResponse(init?.signal));
    vi.stubGlobal("fetch", request);

    const mutation = apiFetch("/api/routes", { method: "POST", body: { name: "one" } });
    const assertion = expect(mutation).rejects.toMatchObject({
      name: "DaemonRequestUncertainError",
      message: expect.stringMatching(/outcome is uncertain|may have been applied/i),
    });
    await vi.runAllTimersAsync();

    await assertion;
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("inspectDaemonState", () => {
  it("checks lifecycle identity without waiting for authenticated deep health", async () => {
    const request = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ service: "wakewire", instanceId: "instance-1", pid: 1234 }), {
          status: 200,
        }),
      );

    await expect(inspectDaemonState(state, request, () => true)).resolves.toMatchObject({
      status: "reachable",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("never discloses the token to a process whose identity does not match", async () => {
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ service: "other", instanceId: "wrong", pid: 1234 }), {
          status: 200,
        }),
    );
    await expect(inspectDaemonState(state, request, () => true)).resolves.toMatchObject({
      status: "foreign",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("treats a live pid with an unreachable endpoint as uncertain", async () => {
    await expect(
      inspectDaemonState(
        state,
        async () => {
          throw new Error("connection refused");
        },
        () => true,
      ),
    ).resolves.toMatchObject({ status: "uncertain" });
  });

  it("treats a live legacy daemon without the identity route as uncertain", async () => {
    await expect(
      inspectDaemonState(
        state,
        async () => new Response("not found", { status: 404 }),
        () => true,
      ),
    ).resolves.toMatchObject({ status: "uncertain" });
  });

  it("treats a dead pid as stale without making a network request", async () => {
    const request = vi.fn();
    await expect(inspectDaemonState(state, request, () => false)).resolves.toMatchObject({
      status: "stale",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed for a legacy live state without an instance identity", async () => {
    const request = vi.fn();
    const { instanceId: _instanceId, ...legacyState } = state;
    await expect(inspectDaemonState(legacyState, request, () => true)).resolves.toMatchObject({
      status: "uncertain",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps the identity deadline active while parsing the response body", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => stalledJsonResponse(init?.signal));
    const inspection = inspectDaemonState(state, request, () => true);

    await expect(
      Promise.race([
        inspection,
        new Promise((resolve) => setTimeout(() => resolve({ status: "stalled" }), 1_500)),
      ]),
    ).resolves.toMatchObject({ status: "uncertain" });
  });
});
