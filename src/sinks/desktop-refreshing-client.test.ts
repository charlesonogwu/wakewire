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

  it("fences retry and future calls when closed during refresh", async () => {
    const refreshGate = deferred<boolean>();
    const closeGate = deferred<void>();
    const stale = client(vi.fn().mockRejectedValue(new Error("stale connector")));
    vi.mocked(stale.close).mockReturnValue(closeGate.promise);
    const replacement = client(vi.fn().mockResolvedValue({ content: [] }));
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh: vi.fn(() => refreshGate.promise),
      readRegistration: vi.fn().mockReturnValue({ version: "current" }),
      makeClient: vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(replacement),
    });
    const pendingRead = subject.call("read_thread", {
      threadId: "thread-1",
      hostId: "local",
    });
    const pendingAssertion = expect(pendingRead).rejects.toThrow(/closed/i);
    await vi.waitFor(() => expect(stale.close).toHaveBeenCalledTimes(1));

    const closing = subject.close();
    let closeFinished = false;
    void closing.then(() => {
      closeFinished = true;
    });
    refreshGate.resolve(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeFinished).toBe(false);
    closeGate.resolve();
    await closing;

    await pendingAssertion;
    await expect(
      subject.call("read_thread", { threadId: "thread-1", hostId: "local" }),
    ).rejects.toThrow(/closed/i);
    expect(stale.close).toHaveBeenCalledTimes(1);
    expect(replacement.call).not.toHaveBeenCalled();
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("joins a newer active refresh when an older generation fails late", async () => {
    const lateFirstRead = deferred<unknown>();
    const secondRefresh = deferred<boolean>();
    const first = client(
      vi
        .fn<DesktopToolClient["call"]>()
        .mockImplementationOnce(() => lateFirstRead.promise)
        .mockRejectedValueOnce(new Error("generation one failed")),
    );
    const second = client(
      vi
        .fn<DesktopToolClient["call"]>()
        .mockResolvedValueOnce({ content: [{ type: "text", text: "generation two" }] })
        .mockRejectedValueOnce(new Error("generation two failed")),
    );
    const third = client(vi.fn().mockResolvedValue({ content: [] }));
    const refresh = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => secondRefresh.promise);
    const makeClient = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third);
    const subject = new RefreshingDesktopMcpClient("C:\\registration.json", {
      refresh,
      readRegistration: vi.fn().mockReturnValue({ version: "current" }),
      makeClient,
    });

    const oldRead = subject.call("read_thread", { threadId: "thread-1", hostId: "local" });
    await expect(
      subject.call("read_thread", { threadId: "thread-1", hostId: "local" }),
    ).resolves.toEqual({ content: [{ type: "text", text: "generation two" }] });
    const newerRead = subject.call("read_thread", { threadId: "thread-1", hostId: "local" });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));

    lateFirstRead.reject(new Error("late generation one failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(makeClient).toHaveBeenCalledTimes(2);
    secondRefresh.resolve(true);

    await expect(Promise.all([oldRead, newerRead])).resolves.toEqual([
      { content: [] },
      { content: [] },
    ]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(third.close).not.toHaveBeenCalled();
    await subject.close();
    expect(third.close).toHaveBeenCalledTimes(1);
  });
});
