import { describe, expect, it, vi } from "vitest";
import type { DesktopToolClient } from "./codex-desktop.js";
import { RefreshingDesktopMcpClient } from "./desktop-refreshing-client.js";

function client(call: DesktopToolClient["call"]): DesktopToolClient {
  return { call, close: vi.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("RefreshingDesktopMcpClient", () => {
  it("refreshes a stale registration and retries one read-only call", async () => {
    const stale = client(vi.fn().mockRejectedValue(new Error("stale connector")));
    const current = client(vi.fn().mockResolvedValue({ content: [] }));
    const refresh = vi.fn().mockResolvedValue(true);
    const makeClient = vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(current);
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh,
      readRegistration: vi.fn().mockReturnValue({ version: "current" }),
      makeClient,
    });

    await expect(
      subject.call("read_thread", { threadId: "thread-1", hostId: "local" }),
    ).resolves.toEqual({ content: [] });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(makeClient).toHaveBeenCalledTimes(2);
  });

  it("recovers when a Desktop update removed the registered connector binary", async () => {
    const current = client(vi.fn().mockResolvedValue({ content: [] }));
    const makeClient = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("registered connector no longer exists");
      })
      .mockReturnValueOnce(current);
    const refresh = vi.fn().mockResolvedValue(true);
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh,
      readRegistration: vi
        .fn()
        .mockReturnValueOnce({ version: "removed" })
        .mockReturnValueOnce({ version: "current" }),
      makeClient,
    });

    await expect(
      subject.call("read_thread", { threadId: "thread-1", hostId: "local" }),
    ).resolves.toEqual({ content: [] });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(makeClient).toHaveBeenCalledTimes(2);
  });

  it("never retries a possibly delivered write", async () => {
    const stale = client(vi.fn().mockRejectedValue(new Error("response lost")));
    const refresh = vi.fn();
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh,
      readRegistration: vi.fn(),
      makeClient: vi.fn().mockReturnValue(stale),
    });

    await expect(
      subject.call("send_message_to_thread", { threadId: "thread-1", hostId: "local" }),
    ).rejects.toThrow("response lost");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shares one refresh across overlapping reads from the same failed generation", async () => {
    const refreshGate = deferred<boolean>();
    const stale = client(vi.fn().mockRejectedValue(new Error("stale connector")));
    const current = client(vi.fn().mockResolvedValue({ content: [] }));
    const refresh = vi.fn(() => refreshGate.promise);
    const makeClient = vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(current);
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh,
      readRegistration: vi.fn().mockReturnValue({ version: "current" }),
      makeClient,
    });

    const firstRead = subject.call("read_thread", { threadId: "thread-1", hostId: "local" });
    const secondRead = subject.call("read_thread", { threadId: "thread-1", hostId: "local" });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    refreshGate.resolve(true);

    await expect(Promise.all([firstRead, secondRead])).resolves.toEqual([
      { content: [] },
      { content: [] },
    ]);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(makeClient).toHaveBeenCalledTimes(2);
  });

  it("waits for an active refresh before a later read creates its client", async () => {
    const refreshGate = deferred<boolean>();
    const stale = client(vi.fn().mockRejectedValue(new Error("stale connector")));
    const current = client(vi.fn().mockResolvedValue({ content: [] }));
    const refresh = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(() => refreshGate.promise)
      .mockResolvedValue(true);
    const makeClient = vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(current);
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh,
      readRegistration: vi.fn().mockReturnValue({ version: "current" }),
      makeClient,
    });
    const firstRead = subject.call("read_thread", { threadId: "thread-1", hostId: "local" });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    const laterRead = subject.call("read_thread", { threadId: "thread-1", hostId: "local" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(makeClient).toHaveBeenCalledTimes(1);
    refreshGate.resolve(true);

    await expect(Promise.all([firstRead, laterRead])).resolves.toEqual([
      { content: [] },
      { content: [] },
    ]);
    expect(makeClient).toHaveBeenCalledTimes(2);
  });

  it("retires only the generation whose read failed", async () => {
    const lateFailure = deferred<unknown>();
    const staleCall = vi
      .fn<DesktopToolClient["call"]>()
      .mockImplementationOnce(() => lateFailure.promise)
      .mockRejectedValueOnce(new Error("stale connector"));
    const stale = client(staleCall);
    const current = client(vi.fn().mockResolvedValue({ content: [] }));
    const refresh = vi.fn().mockResolvedValue(true);
    const makeClient = vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(current);
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh,
      readRegistration: vi.fn().mockReturnValue({ version: "current" }),
      makeClient,
    });

    const firstRead = subject.call("read_thread", { threadId: "thread-1", hostId: "local" });
    await expect(
      subject.call("read_thread", { threadId: "thread-1", hostId: "local" }),
    ).resolves.toEqual({ content: [] });
    lateFailure.reject(new Error("late stale failure"));

    await expect(firstRead).resolves.toEqual({ content: [] });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(current.close).not.toHaveBeenCalled();
  });

  it("refreshes when a read resolves with an MCP error result", async () => {
    const stale = client(
      vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "connector unavailable" }],
      }),
    );
    const current = client(vi.fn().mockResolvedValue({ isError: false, content: [] }));
    const refresh = vi.fn().mockResolvedValue(true);
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh,
      readRegistration: vi.fn().mockReturnValue({ version: "current" }),
      makeClient: vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(current),
    });

    await expect(
      subject.call("read_thread", { threadId: "thread-1", hostId: "local" }),
    ).resolves.toEqual({ isError: false, content: [] });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stale.close).toHaveBeenCalledTimes(1);
  });

  it("does not refresh or retry a write that resolves with an MCP error result", async () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: "delivery result unavailable" }],
    };
    const stale = client(vi.fn().mockResolvedValue(result));
    const refresh = vi.fn();
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh,
      readRegistration: vi.fn().mockReturnValue({ version: "current" }),
      makeClient: vi.fn().mockReturnValue(stale),
    });

    await expect(
      subject.call("send_message_to_thread", { threadId: "thread-1", hostId: "local" }),
    ).resolves.toEqual(result);
    expect(stale.call).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});
