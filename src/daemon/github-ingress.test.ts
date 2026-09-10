import { createHmac } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { WakeEvent } from "../core/event.js";
import { GithubWebhookSource } from "../sources/github/source.js";
import { createGithubIngress, githubIngressConfig } from "./github-ingress.js";

const secret = "synthetic-webhook-signing-secret";
function fixture() {
  const events: WakeEvent[] = [];
  const source = new GithubWebhookSource(
    "test",
    { mode: "listen" },
    {
      backend: "keychain",
      get: () => secret,
      set: () => {},
      delete: () => {},
    },
    { emit: (event) => events.push(event), logger: pino({ level: "silent" }) },
  );
  return { app: createGithubIngress(() => source), events };
}
function request(body: string, signature?: string) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "synthetic-delivery",
      "x-hub-signature-256":
        signature ?? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
    body,
  };
}
const payload = JSON.stringify({
  repository: { full_name: "example/widget" },
  sender: { id: 101 },
  action: "opened",
  number: 9,
  pull_request: { number: 9 },
});

describe("public GitHub-only ingress", () => {
  it("fails closed when its configured source is stopped", async () => {
    const app = createGithubIngress(() => undefined);
    expect((await app.request("/github", request(payload))).status).toBe(503);
  });
  it("requires both explicit dedicated listener settings", () => {
    expect(githubIngressConfig({})).toBeNull();
    expect(() => githubIngressConfig({ WAKEWIRE_GITHUB_INGRESS_PORT: "8888" })).toThrow();
    expect(
      githubIngressConfig({
        WAKEWIRE_GITHUB_INGRESS_PORT: "8888",
        WAKEWIRE_GITHUB_SOURCE_ID: "github-test",
      }),
    ).toEqual({ port: 8888, sourceId: "github-test" });
  });
  it.each(["0", "-1", "65536", "3.5", "80suffix"])("rejects invalid listen port %s", (port) => {
    expect(() =>
      githubIngressConfig({
        WAKEWIRE_GITHUB_INGRESS_PORT: port,
        WAKEWIRE_GITHUB_SOURCE_ID: "github-test",
      }),
    ).toThrow();
  });
  it("durably emits authenticated GitHub events", async () => {
    const { app, events } = fixture();
    expect((await app.request("/github", request(payload))).status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.repo).toBe("example/widget");
  });
  it("rejects forged signatures without emitting", async () => {
    const { app, events } = fixture();
    expect((await app.request("/github", request(payload, "sha256=bad"))).status).toBe(401);
    expect(events).toHaveLength(0);
  });
  it.each(["/api/health", "/api/inject", "/", "/github/extra"])(
    "does not expose %s",
    async (url) => {
      const { app, events } = fixture();
      expect((await app.request(url, request(payload))).status).toBe(404);
      expect(events).toHaveLength(0);
    },
  );
  it.each(["null", "[]", "17"])("rejects non-object JSON %s", async (body) => {
    const { app, events } = fixture();
    expect((await app.request("/github", request(body))).status).toBe(400);
    expect(events).toHaveLength(0);
  });
  it("rejects oversized bodies before emitting", async () => {
    const { app, events } = fixture();
    expect((await app.request("/github", request("x".repeat(1_048_577)))).status).toBe(413);
    expect(events).toHaveLength(0);
  });
  it("does not accept GET on its webhook", async () => {
    const { app } = fixture();
    expect((await app.request("/github")).status).toBe(404);
  });
});
