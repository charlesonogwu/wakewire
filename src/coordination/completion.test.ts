import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAdapter } from "../sinks/types.js";
import { BusyError, PermanentError } from "../sinks/types.js";
import { CoordinationAdapter } from "./adapter.js";
import { CoordinationCompletionMonitor, latestTrustedVote } from "./completion.js";
import type { CoordinationConfig, CoordinationSnapshot } from "./policy.js";

const oldHead = "a".repeat(40);
const newHead = "b".repeat(40);
const config: CoordinationConfig = {
  expectedRepository: "example/project",
  localAgent: "codex",
  trustedAuthorIds: { codex: ["101"], hermes: ["202"] },
  waitingLabel: "waiting:owner",
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wakewire-completion-"));
  dirs.push(dir);
  let time = Date.parse("2026-09-21T00:00:00.000Z");
  let snapshot: CoordinationSnapshot = {
    repository: "example/project",
    state: "open",
    headSha: oldHead,
    headRepository: "example/project",
    body: "<!-- agent-handoff:v1\norigin: codex\nowner: codex\nreviewer: hermes\nimpacts: website\n-->",
    labels: ["agent:codex", "changes-requested:codex"],
    checks: "pending",
    comments: [
      {
        id: 2,
        authorId: "202",
        updatedAt: "2026-09-21T00:00:00Z",
        body: `<!-- agent-review:v1\nreviewer: hermes\ndecision: revise\nhead-sha: ${oldHead}\n-->`,
      },
    ],
  };
  const sent = vi.fn(async (threadId: string, _prompt: string) => ({ threadId }));
  const inner: AgentAdapter = {
    name: "fake-desktop",
    deliverToThread: sent,
    startThread: async () => {
      throw new Error("new task forbidden");
    },
    probe: async () => true,
  };
  const snapshots = { read: vi.fn(async () => snapshot) };
  const create = () =>
    new CoordinationCompletionMonitor({
      dbFile: path.join(dir, "receipts.db"),
      config,
      snapshots,
      inner,
      now: () => new Date(time),
      checkDelayMs: 5 * 60_000,
    });
  const job = {
    repository: "example/project",
    number: 7,
    headSha: oldHead,
    action: "fix" as const,
    threadId: "existing-task",
    firstPrompt: "Fix only after re-fetching PR #7",
    firstDeliveryId: "coordination:v1:old-head-fix",
    baselineVote: null,
  };
  return {
    create,
    job,
    sent,
    snapshots,
    advance(ms: number) {
      time += ms;
    },
    update(next: CoordinationSnapshot) {
      snapshot = next;
    },
    snapshot() {
      return structuredClone(snapshot);
    },
  };
}

describe("durable coordination completion", () => {
  it("records the first wake before acceptance and survives a process restart without duplicating the job", async () => {
    const f = fixture();
    const first = f.create();
    const id = first.register(f.job);
    expect(first.list()).toEqual([
      expect.objectContaining({
        id,
        number: 7,
        action: "fix",
        state: "pending",
        acceptedWakes: 0,
      }),
    ]);
    await first.close();
    const restarted = f.create();
    expect(restarted.register(f.job)).toBe(id);
    expect(restarted.list()).toHaveLength(1);
    await restarted.close();
  });

  it("requires a changed head, trusted owner approval, and peer handoff before marking a fix complete", async () => {
    const f = fixture();
    const monitor = f.create();
    const id = monitor.register(f.job);
    monitor.acknowledge(id);
    f.advance(5 * 60_000);
    const moved = f.snapshot();
    moved.headSha = newHead;
    moved.labels = ["agent:codex", "review:hermes"];
    moved.comments = [];
    f.update(moved);
    await monitor.tick();
    expect(monitor.list()[0]?.state).toBe("pending");

    const attested = f.snapshot();
    attested.comments = [
      {
        id: 3,
        authorId: "101",
        updatedAt: "2026-09-21T00:05:00Z",
        body: `<!-- agent-review:v1\nreviewer: codex\ndecision: approve\nhead-sha: ${newHead}\n-->`,
      },
    ];
    f.update(attested);
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]?.state).toBe("complete");
    await monitor.close();
  });

  it("does not call a failed GitHub read completion or spend a resume attempt", async () => {
    const f = fixture();
    const monitor = f.create();
    const id = monitor.register(f.job);
    monitor.acknowledge(id);
    f.snapshots.read.mockRejectedValueOnce(new Error("GitHub unavailable"));
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]).toEqual(
      expect.objectContaining({
        state: "pending",
        acceptedWakes: 1,
      }),
    );
    expect(f.sent).not.toHaveBeenCalled();
    await monitor.close();
  });

  it("reports prolonged GitHub readback failure instead of waiting silently forever", async () => {
    const f = fixture();
    const monitor = f.create();
    monitor.acknowledge(monitor.register(f.job));
    f.snapshots.read.mockRejectedValue(new Error("GitHub unavailable"));
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(5 * 60_000);
      await monitor.tick();
    }
    expect(monitor.list()[0]).toEqual(
      expect.objectContaining({
        state: "needs-attention",
        acceptedWakes: 1,
      }),
    );
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(f.sent).toHaveBeenCalledTimes(1);
    expect(f.sent.mock.calls[0]?.[1]).toContain("Tell the user");
    await monitor.close();
  });

  it("registers an actionable PR before Desktop acceptance and then records the acceptance", async () => {
    const f = fixture();
    const monitor = f.create();
    const inner: AgentAdapter = {
      name: "observed-desktop",
      deliverToThread: async (threadId) => {
        expect(monitor.list()).toEqual([
          expect.objectContaining({
            number: 7,
            action: "fix",
            acceptedWakes: 0,
          }),
        ]);
        return { threadId };
      },
      startThread: async () => {
        throw new Error("new task forbidden");
      },
      probe: async () => true,
    };
    const adapter = new CoordinationAdapter(config, f.snapshots as never, inner, monitor);
    await adapter.deliverToThread("existing-task", "webhook prose", {
      sandbox: "workspace-write",
      deliveryId: "webhook-7",
      event: {
        source: "github",
        kind: "issue_comment.created",
        deliveryId: "webhook-7",
        occurredAt: "2026-09-21T00:00:00Z",
        summary: "ignored",
        payload: { repo: "example/project", number: 7 },
      },
    });
    expect(monitor.list()[0]?.acceptedWakes).toBe(1);
    await monitor.close();
  });

  it("counts changed review evidence against the same bounded wake allowance", async () => {
    const f = fixture();
    const monitor = f.create();
    const adapter = new CoordinationAdapter(
      config,
      f.snapshots as never,
      {
        name: "fake-desktop",
        deliverToThread: f.sent,
        startThread: async () => {
          throw new Error("new task forbidden");
        },
        probe: async () => true,
      },
      monitor,
    );
    for (let index = 0; index < 6; index++) {
      const snapshot = f.snapshot();
      snapshot.comments = [
        {
          id: index + 2,
          authorId: "202",
          updatedAt: `2026-09-21T00:00:0${index}Z`,
          body: `<!-- agent-review:v1\nreviewer: hermes\ndecision: revise\nhead-sha: ${oldHead}\n-->\nFinding ${index}`,
        },
      ];
      f.update(snapshot);
      await adapter.deliverToThread("existing-task", "webhook", {
        sandbox: "workspace-write",
        deliveryId: `webhook-${index}`,
        event: {
          source: "github",
          kind: "issue_comment.created",
          deliveryId: `webhook-${index}`,
          occurredAt: "2026-09-21T00:00:00Z",
          summary: "ignored",
          payload: { repo: "example/project", number: 7 },
        },
      });
    }
    expect(f.sent).toHaveBeenCalledTimes(4);
    expect(monitor.list()[0]?.acceptedWakes).toBe(4);
    await monitor.close();
  });

  it("rechecks wake capacity after a concurrent GitHub read", async () => {
    const f = fixture();
    const monitor = f.create();
    const id = monitor.register(f.job);
    monitor.acknowledge(id);
    monitor.acknowledge(id, "changed-review-2");
    monitor.acknowledge(id, "changed-review-3");
    f.advance(5 * 60_000);
    let release!: () => void;
    f.snapshots.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(f.snapshot());
        }),
    );
    const tick = monitor.tick();
    monitor.acknowledge(id, "changed-review-4");
    release();
    await tick;
    expect(monitor.list()[0]?.acceptedWakes).toBe(4);
    expect(f.sent).not.toHaveBeenCalled();
    await monitor.close();
  });

  it("holds a busy task and resumes only after it becomes idle", async () => {
    const f = fixture();
    const monitor = f.create();
    monitor.acknowledge(monitor.register(f.job));
    f.sent.mockRejectedValueOnce(new BusyError("task active"));
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]).toEqual(
      expect.objectContaining({
        state: "pending",
        acceptedWakes: 1,
      }),
    );
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]?.acceptedWakes).toBe(2);
    expect(f.sent).toHaveBeenCalledTimes(2);
    await monitor.close();
  });

  it("stops after three accepted resumes and sends one attention message", async () => {
    const f = fixture();
    const monitor = f.create();
    monitor.acknowledge(monitor.register(f.job));
    for (let check = 0; check < 5; check++) {
      f.advance(5 * 60_000);
      await monitor.tick();
    }
    expect(monitor.list()[0]).toEqual(
      expect.objectContaining({
        state: "needs-attention",
        acceptedWakes: 4,
      }),
    );
    expect(f.sent).toHaveBeenCalledTimes(4);
    expect(f.sent.mock.calls.at(-1)?.[1]).toContain("Tell the user");
    await monitor.close();
    const restarted = f.create();
    f.advance(5 * 60_000);
    await restarted.tick();
    expect(f.sent).toHaveBeenCalledTimes(4);
    await restarted.close();
  });

  it("never retries a Desktop receipt whose send outcome is uncertain", async () => {
    const f = fixture();
    const monitor = f.create();
    monitor.register(f.job);
    f.sent.mockRejectedValueOnce(new PermanentError("uncertain Desktop delivery"));
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]?.state).toBe("needs-attention");
    const count = f.sent.mock.calls.length;
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(f.sent.mock.calls.length).toBe(count + 1); // one distinct attention message only
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(f.sent.mock.calls.length).toBe(count + 1);
    await monitor.close();
  });

  it("does not mistake an old-head vote for completion after a push", async () => {
    const f = fixture();
    const monitor = f.create();
    monitor.acknowledge(monitor.register(f.job));
    const moved = f.snapshot();
    moved.headSha = newHead;
    moved.labels = ["agent:codex", "review:hermes"];
    moved.comments = [
      {
        id: 3,
        authorId: "101",
        updatedAt: "2026-09-21T00:05:00Z",
        body: `<!-- agent-review:v1\nreviewer: codex\ndecision: approve\nhead-sha: ${oldHead}\n-->`,
      },
    ];
    f.update(moved);
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]?.state).toBe("pending");
    expect(f.sent).not.toHaveBeenCalled();
    await monitor.close();
  });

  it("does not resume a fix after its change-request label is removed", async () => {
    const f = fixture();
    const monitor = f.create();
    monitor.acknowledge(monitor.register(f.job));
    const snapshot = f.snapshot();
    snapshot.labels = ["agent:codex"];
    f.update(snapshot);
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(f.sent).not.toHaveBeenCalled();
    expect(monitor.list()[0]).toEqual(
      expect.objectContaining({ state: "pending", acceptedWakes: 1 }),
    );
    await monitor.close();
  });

  it("recognizes only a trusted current-head review as review completion", async () => {
    const f = fixture();
    const monitor = f.create();
    const review = { ...f.job, action: "review" as const };
    monitor.acknowledge(monitor.register(review));
    const snapshot = f.snapshot();
    snapshot.labels = ["agent:hermes", "review:codex"];
    snapshot.body =
      "<!-- agent-handoff:v1\norigin: hermes\nowner: hermes\nreviewer: codex\nimpacts: website\n-->";
    snapshot.comments = [
      {
        id: 3,
        authorId: "999",
        updatedAt: "2026-09-21T00:05:00Z",
        body: `<!-- agent-review:v1\nreviewer: codex\ndecision: approve\nhead-sha: ${oldHead}\n-->`,
      },
    ];
    f.update(snapshot);
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]?.state).toBe("pending");
    snapshot.comments = snapshot.comments.map((comment) => ({ ...comment, authorId: "101" }));
    f.update(snapshot);
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]?.state).toBe("complete");
    await monitor.close();
  });

  it("does not complete a new review from an older vote on the same head", async () => {
    const f = fixture();
    const snapshot = f.snapshot();
    snapshot.labels = ["agent:hermes", "review:codex"];
    snapshot.body =
      "<!-- agent-handoff:v1\norigin: hermes\nowner: hermes\nreviewer: codex\nimpacts: website\n-->";
    snapshot.comments = [
      {
        id: 3,
        authorId: "101",
        updatedAt: "2026-09-21T00:00:00Z",
        body: `<!-- agent-review:v1\nreviewer: codex\ndecision: approve\nhead-sha: ${oldHead}\n-->`,
      },
    ];
    f.update(snapshot);
    const monitor = f.create();
    const prior = latestTrustedVote(snapshot, config);
    monitor.acknowledge(
      monitor.register({ ...f.job, action: "review", baselineVote: prior?.ordering ?? null }),
    );
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]?.state).toBe("pending");
    await monitor.close();
  });

  it("does not accept an older vote exposed by deletion of the baseline vote", async () => {
    const f = fixture();
    const snapshot = f.snapshot();
    snapshot.labels = ["agent:hermes", "review:codex"];
    snapshot.body =
      "<!-- agent-handoff:v1\norigin: hermes\nowner: hermes\nreviewer: codex\nimpacts: website\n-->";
    snapshot.comments = [3, 4].map((id) => ({
      id,
      authorId: "101",
      updatedAt: `2026-09-21T00:00:0${id}Z`,
      body: `<!-- agent-review:v1\nreviewer: codex\ndecision: approve\nhead-sha: ${oldHead}\n-->`,
    }));
    f.update(snapshot);
    const monitor = f.create();
    const baseline = latestTrustedVote(snapshot, config);
    monitor.acknowledge(
      monitor.register({ ...f.job, action: "review", baselineVote: baseline?.ordering ?? null }),
    );
    snapshot.comments = snapshot.comments.filter((comment) => comment.id === 3);
    f.update(snapshot);
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]?.state).toBe("pending");
    await monitor.close();
  });

  it("treats a trusted owner revise verdict as superseding verification, not approval", async () => {
    const f = fixture();
    const monitor = f.create();
    monitor.acknowledge(monitor.register({ ...f.job, action: "verify" }));
    const snapshot = f.snapshot();
    snapshot.labels = ["agent:codex", "waiting:owner"];
    snapshot.comments = [
      {
        id: 3,
        authorId: "101",
        updatedAt: "2026-09-21T00:05:00Z",
        body: `<!-- agent-review:v1\nreviewer: codex\ndecision: revise\nhead-sha: ${oldHead}\n-->`,
      },
    ];
    f.update(snapshot);
    f.advance(5 * 60_000);
    await monitor.tick();
    expect(monitor.list()[0]?.state).toBe("superseded");
    await monitor.close();
  });

  it("preserves an accepted wake across restart before the retry deadline", async () => {
    const f = fixture();
    const first = f.create();
    first.acknowledge(first.register(f.job));
    await first.close();
    const restarted = f.create();
    await restarted.tick();
    expect(f.sent).not.toHaveBeenCalled();
    f.advance(5 * 60_000);
    await restarted.tick();
    expect(f.sent).toHaveBeenCalledTimes(1);
    await restarted.close();
  });

  it("waits for an in-flight reconciliation before closing its database", async () => {
    const f = fixture();
    const monitor = f.create();
    monitor.acknowledge(monitor.register(f.job));
    f.advance(5 * 60_000);
    let release!: () => void;
    f.snapshots.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(f.snapshot());
        }),
    );
    const tick = monitor.tick();
    const close = monitor.close();
    release();
    await expect(tick).resolves.toBeUndefined();
    await expect(close).resolves.toBeUndefined();
    expect(f.sent).not.toHaveBeenCalled();
  });
});
