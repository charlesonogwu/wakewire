import fs from "node:fs";
import type { DesktopToolClient } from "./codex-desktop.js";
import { DesktopMcpClient } from "./desktop-mcp.js";
import { refreshDesktopRegistration } from "./desktop-registration.js";

interface Dependencies {
  refresh: (file: string) => Promise<boolean>;
  readRegistration: (file: string) => unknown;
  makeClient: (registration: unknown) => DesktopToolClient;
}

interface ClientGeneration {
  client: DesktopToolClient;
  closed: boolean;
}

interface RefreshFlight {
  failed: ClientGeneration | undefined;
  promise: Promise<void>;
}

const defaults: Dependencies = {
  refresh: refreshDesktopRegistration,
  readRegistration: (file) => JSON.parse(fs.readFileSync(file, "utf8")),
  makeClient: (registration) =>
    new DesktopMcpClient(registration as ConstructorParameters<typeof DesktopMcpClient>[0]),
};

/**
 * Re-resolves Codex Desktop's versioned connector and transient named pipe
 * after an app restart. Writes are never retried because their response may
 * have been lost after delivery.
 */
export class RefreshingDesktopMcpClient implements DesktopToolClient {
  private current: ClientGeneration | undefined;
  private refreshFlight: RefreshFlight | undefined;
  private readonly closingGenerations = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly registrationFile: string,
    private readonly dependencies: Dependencies = defaults,
  ) {}

  private client(): ClientGeneration {
    this.ensureOpen();
    this.current ??= {
      client: this.dependencies.makeClient(
        this.dependencies.readRegistration(this.registrationFile),
      ),
      closed: false,
    };
    return this.current;
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Desktop connector closed");
  }

  private closeGeneration(generation: ClientGeneration): void {
    if (generation.closed) return;
    generation.closed = true;
    const closing = Promise.resolve()
      .then(() => generation.client.close())
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => this.closingGenerations.delete(closing));
    this.closingGenerations.add(closing);
  }

  private refreshAfter(failed: ClientGeneration | undefined): Promise<void> {
    this.ensureOpen();
    if (this.refreshFlight) return this.refreshFlight.promise;
    if (failed ? this.current !== failed : this.current !== undefined) return Promise.resolve();

    const flight = { failed } as RefreshFlight;
    flight.promise = Promise.resolve()
      .then(async () => {
        if (failed) {
          if (this.current !== failed) return;
          this.current = undefined;
          this.closeGeneration(failed);
        } else if (this.current) {
          return;
        }
        await this.dependencies.refresh(this.registrationFile);
        this.ensureOpen();
      })
      .finally(() => {
        if (this.refreshFlight === flight) this.refreshFlight = undefined;
      });
    this.refreshFlight = flight;
    return flight.promise;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.refreshFlight) await this.refreshFlight.promise;
    this.ensureOpen();
    if (name !== "read_thread") return await this.client().client.call(name, args);

    let failed: ClientGeneration | undefined;
    try {
      failed = this.client();
      const result = await failed.client.call(name, args);
      this.ensureOpen();
      if (!isMcpError(result)) return result;
    } catch {
      // Read-only calls are safe to repeat after refreshing the registration.
    }
    await this.refreshAfter(failed);
    const result = await this.client().client.call(name, args);
    this.ensureOpen();
    return result;
  }

  async close(): Promise<void> {
    if (!this.closed) this.closed = true;
    if (this.current) this.closeGeneration(this.current);
    this.current = undefined;
    await this.refreshFlight?.promise.catch(() => undefined);
    await Promise.all(this.closingGenerations);
  }
}

function isMcpError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    (value as { isError?: unknown }).isError === true
  );
}
