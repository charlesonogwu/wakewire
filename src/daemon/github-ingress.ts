import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { GithubWebhookSource } from "../sources/github/source.js";

export function githubIngressConfig(
  env: NodeJS.ProcessEnv,
): { port: number; sourceId: string } | null {
  const port = env.WAKEWIRE_GITHUB_INGRESS_PORT;
  const sourceId = env.WAKEWIRE_GITHUB_SOURCE_ID;
  if (port === undefined && sourceId === undefined) return null;
  if (
    !port ||
    !/^[1-9]\d*$/.test(port) ||
    Number(port) > 65535 ||
    !sourceId ||
    !/^[a-zA-Z0-9._-]+$/.test(sourceId)
  ) {
    throw new Error("Invalid dedicated GitHub ingress settings");
  }
  return { port: Number(port), sourceId };
}

/** Expose only this app through a tunnel, never the management API. */
export function createGithubIngress(getSource: () => GithubWebhookSource | undefined): Hono {
  const app = new Hono();
  app.use("/github", bodyLimit({ maxSize: 1_048_576 }));
  app.post("/github", async (c) => {
    const source = getSource();
    if (!source) return c.json({ message: "source unavailable" }, 503);
    const result = await source.handleWebhook({
      eventName: c.req.header("x-github-event"),
      deliveryId: c.req.header("x-github-delivery"),
      signature: c.req.header("x-hub-signature-256"),
      rawBody: await c.req.text(),
    });
    return c.json({ message: result.message }, result.status as 200);
  });
  return app;
}
