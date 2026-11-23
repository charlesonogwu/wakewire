import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { verifyGithubSignature } from "../sources/github/verify.js";
import { type Funnel, findFunnel, probeAddress, probeLocal, type SignedPing } from "./route.js";

const SECRET = "synthetic-selftest-secret";
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function signedPing(): Promise<SignedPing> {
  const { sign } = await import("@octokit/webhooks-methods");
  const body = JSON.stringify({ zen: "WakeWire self-test", hook_id: 0 });
  return { deliveryId: "wakewire-selftest-test", body, signature: await sign(SECRET, body) };
}

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: net.Socket) => sockets.add(socket));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

/** Answers like the ingress: "pong" only for a ping signed with the shared secret. */
function ingressHandler(): http.RequestListener {
  return (request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", async () => {
      const ok =
        request.url === "/github" &&
        request.headers["x-github-event"] === "ping" &&
        (await verifyGithubSignature(
          SECRET,
          body,
          request.headers["x-hub-signature-256"] as string,
        ));
      response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: ok ? "pong" : "signature verification failed" }));
    });
  };
}

const funnel = (port: number): Funnel => ({
  host: "wakewire.test",
  port,
  target: "http://127.0.0.1:8769",
});

describe("findFunnel", () => {
  const status = {
    TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
    Web: {
      "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } },
      "host.example.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8769" } } },
    },
    AllowFunnel: { "host.example.ts.net:8443": true, "host.example.ts.net:443": true },
  };
  it("picks the funneled entry that proxies to the ingress port, with Tailscale's own target", () => {
    expect(findFunnel(status, 8769)).toEqual({
      host: "host.example.ts.net",
      port: 8443,
      target: "http://127.0.0.1:8769",
    });
  });
  it("ignores entries that are not funneled, point elsewhere, or are ambiguous", () => {
    expect(findFunnel({ ...status, AllowFunnel: {} }, 8769)).toBeNull();
    expect(findFunnel(status, 9999)).toBeNull();
    const twice = {
      Web: { ...status.Web, "other.example.ts.net:443": status.Web["host.example.ts.net:8443"] },
      AllowFunnel: { "host.example.ts.net:8443": true, "other.example.ts.net:443": true },
    };
    expect(findFunnel(twice, 8769)).toBeNull();
    expect(findFunnel("not json", 8769)).toBeNull();
  });
});

describe("probeAddress", () => {
  it("names the reboot fault: TCP connects, then closes before any TLS reply", async () => {
    const port = await listen(
      net.createServer((socket) => socket.once("data", () => socket.destroy())),
    );
    expect(await probeAddress("127.0.0.1", funnel(port), await signedPing())).toBe(
      "closed-before-tls",
    );
  });
  it("does not mistake a peer that answered with bytes for that fault", async () => {
    const port = await listen(
      net.createServer((socket) =>
        socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")),
      ),
    );
    expect(await probeAddress("127.0.0.1", funnel(port), await signedPing())).toBe("tls-failed");
  });
  it("reports a refused connection and a silent peer, neither of which heals", async () => {
    const closed = await listen(net.createServer());
    servers.pop()?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await probeAddress("127.0.0.1", funnel(closed), await signedPing())).toBe(
      "connect-failed",
    );
    const silent = await listen(net.createServer(() => {}));
    expect(
      await probeAddress("127.0.0.1", funnel(silent), await signedPing(), { timeoutMs: 300 }),
    ).toBe("tls-timeout");
  });

  const dir = mkdtempSync(path.join(os.tmpdir(), "wakewire-selftest-tls-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let tls: { key: Buffer; cert: Buffer } | null = null;
  try {
    // A throwaway certificate for this run only; no key is kept in the repository.
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        path.join(dir, "key.pem"),
        "-out",
        path.join(dir, "cert.pem"),
        "-subj",
        "/CN=wakewire.test",
        "-addext",
        "subjectAltName=DNS:wakewire.test",
      ],
      { stdio: "ignore" },
    );
    tls = {
      key: readFileSync(path.join(dir, "key.pem")),
      cert: readFileSync(path.join(dir, "cert.pem")),
    };
  } catch {
    tls = null;
  }
  it.skipIf(!tls)(
    "gets pong only from a daemon holding the same secret, over TLS with SNI",
    async () => {
      if (!tls) return;
      const port = await listen(https.createServer(tls, ingressHandler()));
      const trust = { tls: { ca: tls.cert } };
      expect(await probeAddress("127.0.0.1", funnel(port), await signedPing(), trust)).toBe("pong");
      const forged = { ...(await signedPing()), signature: `sha256=${"0".repeat(64)}` };
      expect(await probeAddress("127.0.0.1", funnel(port), forged, trust)).toBe("wrong-reply");
      // The certificate must match the funnel's name.
      expect(
        await probeAddress(
          "127.0.0.1",
          { ...funnel(port), host: "elsewhere.test" },
          await signedPing(),
          trust,
        ),
      ).toBe("tls-failed");
    },
  );
});

describe("probeLocal", () => {
  it("asks the local ingress the same signed question", async () => {
    const port = await listen(http.createServer(ingressHandler()));
    expect(await probeLocal(port, await signedPing())).toBe("pong");
    const forged = { ...(await signedPing()), signature: `sha256=${"0".repeat(64)}` };
    expect(await probeLocal(port, forged)).toBe("wrong-reply");
    servers.pop()?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await probeLocal(port, await signedPing())).toBe("refused");
  });
});
