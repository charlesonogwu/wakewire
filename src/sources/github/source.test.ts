import { createHmac } from "node:crypto";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WakeEvent } from "../../core/event.js";
import { GithubWebhookSource } from "./source.js";
import * as signatureVerification from "./verify.js";

const secret = "synthetic-lifecycle-secret";
const rawBody = JSON.stringify({
  repository: { full_name: "example/project" },
  action: "opened",
  number: 7,
});
const args = {
  eventName: "pull_request",
  deliveryId: "synthetic-delivery",
  rawBody,
  signature: `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
};
function fixture() {
  const events: WakeEvent[] = [];
  const source = new GithubWebhookSource(
    "synthetic-source",
    { mode: "listen" },
    {
      backend: "keychain",
      get: () => secret,
      set: () => {},
      delete: () => {},
    },
    { emit: (event) => events.push(event), logger: pino({ level: "silent" }) },
  );
  return { source, events };
}
afterEach(() => vi.restoreAllMocks());

describe("GitHub source lifecycle", () => {
  it("supports standalone webhook handling before start", async () => {
    const { source, events } = fixture();
    expect((await source.handleWebhook(args)).status).toBe(200);
    expect(events).toHaveLength(1);
  });
  it("rejects calls after stop and accepts fresh calls after restart", async () => {
    const { source, events } = fixture();
    await source.stop();
    expect((await source.handleWebhook(args)).status).toBe(503);
    expect(events).toHaveLength(0);
    await source.start();
    expect((await source.handleWebhook(args)).status).toBe(200);
    expect(events).toHaveLength(1);
  });
  it.each(["stop", "stop-restart", "start"] as const)(
    "invalidates an in-flight signature verification across %s",
    async (operation) => {
      const { source, events } = fixture();
      await source.start();
      let entered = () => {};
      const verificationStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release = () => {};
      const verificationReleased = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realVerify = signatureVerification.verifyGithubSignature;
      vi.spyOn(signatureVerification, "verifyGithubSignature").mockImplementationOnce(
        async (...input) => {
          entered();
          await verificationReleased;
          return realVerify(...input);
        },
      );
      const pending = source.handleWebhook(args);
      await verificationStarted;
      if (operation !== "start") await source.stop();
      if (operation !== "stop") await source.start();
      release();
      expect((await pending).status).toBe(503);
      expect(events).toHaveLength(0);
      expect(source.status()).toMatchObject({ received: 0, lastEventAt: null });
      if (operation !== "stop") {
        expect((await source.handleWebhook(args)).status).toBe(200);
        expect(events).toHaveLength(1);
      }
    },
  );
});
