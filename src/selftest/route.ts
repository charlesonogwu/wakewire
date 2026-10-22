import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { z } from "zod";

/** The Tailscale Funnel entry that proxies to the dedicated GitHub ingress. */
export interface Funnel {
  /** Public DNS name, e.g. "host.tailnet.ts.net". */
  host: string;
  /** Public HTTPS port the funnel listens on. */
  port: number;
  /** Local proxy target exactly as Tailscale stores it, e.g. "http://127.0.0.1:8769". */
  target: string;
}

/** A GitHub `ping` signed with the ingress source's own secret. Never log `signature`. */
export interface SignedPing {
  deliveryId: string;
  body: string;
  signature: string;
}

/**
 * How one public address answered:
 * - pong: this daemon (it verified our signature and answered "pong").
 * - closed-before-tls: TCP connected, then the connection closed before any TLS reply.
 *   The only failure the self-heal acts on.
 * - connect-failed / connect-timeout: no TCP connection (report only).
 * - tls-timeout: TCP connected but no TLS reply arrived in time (report only).
 * - tls-failed: the far end spoke TLS but the handshake failed, e.g. a bad certificate.
 * - wrong-reply: something answered, but not this daemon's "pong".
 */
export type ProbeOutcome =
  | "pong"
  | "closed-before-tls"
  | "connect-failed"
  | "connect-timeout"
  | "tls-timeout"
  | "tls-failed"
  | "wrong-reply";

export const PROBE_TIMEOUT_MS = 10_000;
/** Public resolvers, so the answer is what GitHub sees rather than Tailscale's MagicDNS. */
export const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

const ServeStatus = z.object({
  Web: z
    .record(
      z.string(),
      z.object({
        Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional(),
      }),
    )
    .optional(),
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
});

/** Finds the one funneled "host:port" whose "/" handler proxies to the local ingress port. */
export function findFunnel(status: unknown, ingressPort: number): Funnel | null {
  const parsed = ServeStatus.safeParse(status);
  if (!parsed.success) return null;
  const found: Funnel[] = [];
  for (const [hostPort, web] of Object.entries(parsed.data.Web ?? {})) {
    if (!parsed.data.AllowFunnel?.[hostPort]) continue;
    const target = web.Handlers?.["/"]?.Proxy;
    if (!target) continue;
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      continue;
    }
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || Number(url.port) !== ingressPort)
      continue;
    const split = hostPort.lastIndexOf(":");
    const port = Number(hostPort.slice(split + 1));
    if (split < 1 || !Number.isInteger(port)) continue;
    found.push({ host: hostPort.slice(0, split), port, target });
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** IPv4 A records for the funnel host from public DNS. */
export async function resolvePublicV4(host: string): Promise<string[]> {
  const resolver = new dns.promises.Resolver({ timeout: 5_000, tries: 2 });
  resolver.setServers(PUBLIC_RESOLVERS);
  return resolver.resolve4(host);
}

const pingHeaders = (ping: SignedPing, host: string) => ({
  host,
  "content-type": "application/json",
  "content-length": String(Buffer.byteLength(ping.body)),
  "user-agent": "WakeWire-Selftest",
  "x-github-event": "ping",
  "x-github-delivery": ping.deliveryId,
  "x-hub-signature-256": ping.signature,
  connection: "close",
});

/** True only for this daemon's answer to a ping it verified. */
async function isPong(response: http.IncomingMessage): Promise<boolean> {
  let text = "";
  for await (const chunk of response) {
    text += String(chunk);
    if (text.length > 4096) return false;
  }
  if (response.statusCode !== 200) return false;
  try {
    return (JSON.parse(text) as { message?: unknown }).message === "pong";
  } catch {
    return false;
  }
}

/**
 * Sends the signed ping to one public address with the funnel's name for SNI and
 * certificate checks. Nothing from the reply is kept beyond the outcome.
 */
export function probeAddress(
  address: string,
  funnel: Funnel,
  ping: SignedPing,
  options: { timeoutMs?: number; tls?: https.RequestOptions } = {},
): Promise<ProbeOutcome> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let connected = false;
    let secure = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(outcome);
    };
    const arm = (outcome: ProbeOutcome) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(outcome), timeoutMs);
    };
    const request = https.request({
      host: address,
      port: funnel.port,
      servername: funnel.host,
      method: "POST",
      path: "/github",
      agent: false,
      headers: pingHeaders(ping, funnel.host),
      ...options.tls,
    });
    arm("connect-timeout");
    request.on("socket", (socket) => {
      socket.once("connect", () => {
        connected = true;
        arm("tls-timeout");
      });
      socket.once("secureConnect", () => {
        secure = true;
        arm("wrong-reply");
      });
    });
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (!connected) return finish("connect-failed");
      if (secure) return finish("wrong-reply");
      // Node reports a peer that hangs up before answering the ClientHello as ECONNRESET
      // ("socket disconnected before secure TLS connection was established"); a peer
      // that answered with TLS fails with an SSL or certificate error instead.
      finish(
        error.code === "ECONNRESET" || error.code === "EPIPE" ? "closed-before-tls" : "tls-failed",
      );
    });
    request.on("response", (response) => {
      isPong(response).then(
        (pong) => finish(pong ? "pong" : "wrong-reply"),
        () => finish("wrong-reply"),
      );
    });
    request.end(ping.body);
  });
}

/** The local ingress listener, asked the same signed question. */
export function probeLocal(
  port: number,
  ping: SignedPing,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<"pong" | "refused" | "timeout" | "wrong-reply"> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: "pong" | "refused" | "timeout" | "wrong-reply") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/github",
      agent: false,
      headers: pingHeaders(ping, `127.0.0.1:${port}`),
    });
    request.on("error", () => finish("refused"));
    request.on("response", (response) => {
      isPong(response).then(
        (pong) => finish(pong ? "pong" : "wrong-reply"),
        () => finish("wrong-reply"),
      );
    });
    request.end(ping.body);
  });
}
