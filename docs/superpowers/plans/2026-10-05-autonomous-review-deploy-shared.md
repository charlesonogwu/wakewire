# Autonomous Review-to-Deployment Shared Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend WakeWire with isolated repository lanes, rigorous exact-candidate collaboration, operator-only merge handling, and a generic signed deployment transaction.

**Architecture:** WakeWire runs on the review host and keeps GitHub as the durable record. It routes author and reviewer work into separate T3 contexts, validates the exact merge candidate, and produces signed immutable artifacts after an operator merge. A small runtime executor activates repository-specific artifacts under a global fencing protocol; private repositories supply adapters, never generic orchestration.

**Tech Stack:** TypeScript 7, Node >=20.18, Vitest, better-sqlite3, Zod, GitHub REST API, T3 thread bridge, Ed25519 signatures.

**Spec:** `docs/superpowers/specs/2026-10-05-autonomous-review-deploy-design.md`

## Global Constraints

- Agents have no merge method, generic GitHub token, production credential, or production shell.
- GitHub is authoritative; T3 threads are working context only.
- Every verdict binds repository, PR, head SHA, base SHA, and candidate tree hash.
- New head or base evidence invalidates previous verdicts and summaries.
- Runtime deployment uses a previously activated private adapter and never downloads from GitHub.
- Private repository names, runtime paths, commands, and secrets stay outside this public package.
- Review jobs may run concurrently; runtime activation and rollback are globally serialized.
- Unknown delivery or runtime state fails closed and is reconciled before retry.

## Review Focus

- A PR head remains unchanged while its base moves: invalidate the candidate and both verdicts.
- A merge webhook is missed or duplicated: reconciliation creates exactly one deployment intent.
- The runtime becomes busy after an advisory check: release leases/locks and remain pending.
- A crash occurs after partial activation or before receipt acknowledgment: reconcile without duplicate copy.
- A compromised adapter or model attempts merge, arbitrary command, cross-repository routing, or target changes: reject before external mutation.

---

### Task 1: Repository Registry and Isolated Lanes

**Files:**
- Create: `src/deploy/types.ts`
- Create: `src/deploy/registry.ts`
- Create: `src/deploy/registry.test.ts`
- Create: `src/deploy/lanes.ts`
- Create: `src/deploy/lanes.test.ts`
- Modify: `src/paths.ts`

**Interfaces:**
- Produces: `LaneRecord`, `RepositoryRegistry.load(path)`, `LaneRouter.route(event)`, and immutable repository/task identity types.
- Consumes: `wakewireHome()` for the private registry root.

- [ ] **Step 1: Write failing registry and routing tests**

```ts
it("rejects shared contexts and overlapping roots", () => {
  expect(() => loadRegistry(registryWithSharedReviewerThread)).toThrow(/threadId/);
  expect(() => loadRegistry(registryWithOverlappingRoots)).toThrow(/overlap/);
});

it("routes simultaneous repositories without context bleed", () => {
  expect(router.route(eventA).laneId).toBe("lane-a");
  expect(router.route(eventB).laneId).toBe("lane-b");
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/deploy/registry.test.ts src/deploy/lanes.test.ts`
Expected: FAIL because the deploy registry modules do not exist.

- [ ] **Step 3: Implement strict types, private registry loading, overlap checks, and idempotent routing**

```ts
export interface LaneRecord {
  laneId: string;
  repositoryId: string;
  github: { owner: string; name: string };
  roots: { checkout: string; worktree: string; cache: string };
  threads: Record<"author" | "reviewer", { projectId: string; threadId: string }>;
  adapterPath: string;
}
```

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run src/deploy/registry.test.ts src/deploy/lanes.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/types.ts src/deploy/registry.ts src/deploy/registry.test.ts src/deploy/lanes.ts src/deploy/lanes.test.ts src/paths.ts
git commit -m "feat: add isolated deployment lanes"
```

### Task 2: Separate Author and Reviewer T3 Routing

**Files:**
- Create: `src/deploy/t3.ts`
- Create: `src/deploy/t3.test.ts`
- Modify: `src/sinks/types.ts`

**Interfaces:**
- Consumes: `LaneRecord`, `requestId`, and role from Task 1.
- Produces: `ReviewHostRouter.wake({ laneId, role, requestId })` and signed verdict ingestion.

- [ ] **Step 1: Write failing separation and sanitization tests**

```ts
it("never delivers one work item to both role contexts", async () => {
  await router.wake({ laneId: "a", role: "reviewer", requestId: "r1" });
  expect(client.sent).toEqual([{ threadId: "review-thread", requestId: "r1" }]);
});
```

Test production-token text, `.env` values, unknown lane, shared thread IDs, invalid verdict signatures, and duplicate request IDs.

- [ ] **Step 2: Run the test and confirm red**

Run: `npx vitest run src/deploy/t3.test.ts`
Expected: FAIL because `ReviewHostRouter` is missing.

- [ ] **Step 3: Implement a narrow T3 client that transmits only structured wake records**

The model-facing request contains `laneId`, `role`, `requestId`, repository ID, PR, and exact candidate IDs. Do not extend the Codex Desktop sink or include production payloads.

- [ ] **Step 4: Verify**

Run: `npx vitest run src/deploy/t3.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/t3.ts src/deploy/t3.test.ts src/sinks/types.ts
git commit -m "feat: route isolated review contexts"
```

### Task 3: Candidate State Machine and Readiness Summaries

**Files:**
- Create: `src/deploy/candidate.ts`
- Create: `src/deploy/candidate.test.ts`
- Create: `src/deploy/summary.ts`
- Create: `src/deploy/summary.test.ts`

**Interfaces:**
- Produces: `advanceCandidate(state, event)`, `CandidateState`, and `renderOperatorSummary(candidate)`.
- Does not reuse `src/coordination/policy.ts`; that module remains the legacy label protocol.

- [ ] **Step 1: Write the candidate transition tests**

```ts
it("invalidates approval when the base moves", () => {
  const next = advanceCandidate(mergeReady, { type: "base-changed", baseSha: SHA_B });
  expect(next.state).toBe("invalidated");
  expect(next.verdicts).toEqual([]);
});
```

Cover drafts entering challenge but not readiness, unresolved findings, cancelled checks, unknown outcomes, `blocked`, `not-worth-merging`, and superseded summaries.

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/deploy/candidate.test.ts src/deploy/summary.test.ts`
Expected: FAIL because candidate modules are missing.

- [ ] **Step 3: Implement pure deterministic transitions and bounded plain-English summaries**

`merge-ready` requires separate current author/reviewer verdicts, zero unresolved findings, and all required checks successful for the candidate tree.

- [ ] **Step 4: Verify**

Run: `npx vitest run src/deploy/candidate.test.ts src/deploy/summary.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/candidate.ts src/deploy/candidate.test.ts src/deploy/summary.ts src/deploy/summary.test.ts
git commit -m "feat: track exact review candidates"
```

### Task 4: No-Merge GitHub Broker and Fresh Merge Validation

**Files:**
- Create: `src/deploy/broker.ts`
- Create: `src/deploy/broker.test.ts`
- Create: `src/deploy/reconcile.ts`
- Create: `src/deploy/reconcile.test.ts`
- Modify: `src/coordination/github.ts`
- Modify: `src/coordination/github.test.ts`

**Interfaces:**
- Produces: `Broker.publishBranch`, `Broker.comment`, `Broker.status`, and `MergeReconciler.scan()`.
- Consumes: read-only GitHub snapshot client and candidate state.

- [ ] **Step 1: Write failing authority and reconciliation tests**

```ts
expect(Object.keys(broker).sort()).toEqual(["comment", "publishBranch", "status"]);
await expect(transport.post("/pulls/7/merge", {})).rejects.toThrow(/merge forbidden/);
```

Test direct push refusal, operator actor mismatch, reviewed head mismatch, moved base, merge-tree mismatch, missed webhook recovery, duplicate webhook, and older release suppression.

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/deploy/broker.test.ts src/deploy/reconcile.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement fixed endpoint allowlists and periodic fresh-state reconciliation**

The broker may publish an owned branch, comment, and status only. It exposes neither raw transport nor merge endpoint to a model process.

- [ ] **Step 4: Verify**

Run: `npx vitest run src/deploy/broker.test.ts src/deploy/reconcile.test.ts src/coordination/github.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/broker.ts src/deploy/broker.test.ts src/deploy/reconcile.ts src/deploy/reconcile.test.ts src/coordination/github.ts src/coordination/github.test.ts
git commit -m "feat: validate operator merges"
```

### Task 5: Signed Artifacts and Adapter Boundary

**Files:**
- Create: `src/deploy/artifact.ts`
- Create: `src/deploy/artifact.test.ts`
- Create: `src/deploy/adapter.ts`
- Create: `src/deploy/adapter.test.ts`

**Interfaces:**
- Produces: `buildArtifactEnvelope`, `verifyArtifactEnvelope`, and `RuntimeAdapterSchema`.
- Consumes: actual merge tree, previously activated adapter version, and an injected signing provider.

- [ ] **Step 1: Write failing provenance tests**

Test changed bytes after signing, wrong repository, wrong architecture/runtime, path traversal, duplicate files, symlinks, same-merge adapter update, unknown compatibility, and documentation-only artifacts.

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/deploy/artifact.test.ts src/deploy/adapter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement canonical manifests and Ed25519 signing**

```ts
export interface ArtifactEnvelope {
  repositoryId: string;
  mergeSha: string;
  treeHash: string;
  adapterVersion: string;
  architecture: string;
  runtimeVersions: Record<string, string>;
  files: Array<{ path: string; sha256: string; mode: number }>;
  compatibility: "reversible" | "irreversible";
  signature: string;
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run src/deploy/artifact.test.ts src/deploy/adapter.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/artifact.ts src/deploy/artifact.test.ts src/deploy/adapter.ts src/deploy/adapter.test.ts
git commit -m "feat: sign immutable release artifacts"
```

### Task 6: Durable Deployment Journal, Outbox, and Fencing

**Files:**
- Create: `src/deploy/journal.ts`
- Create: `src/deploy/journal.test.ts`
- Create: `src/deploy/fence.ts`
- Create: `src/deploy/fence.test.ts`
- Modify: `src/db/migrations.ts`
- Modify: `src/db/db.test.ts`
- Modify: `src/db/repos.ts`

**Interfaces:**
- Produces: deployment-intent repository, receipt outbox, monotonic fencing tokens, and repository/global pause state.

- [ ] **Step 1: Write migration and crash-recovery tests**

Cover intent-before-mutation, process death during activation, lost acknowledgment, stale fencing token, repository pause, global uncertainty, linked repair release, and operator fence clearing without failed-release approval.

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/deploy/journal.test.ts src/deploy/fence.test.ts src/db/db.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add append-only migration and transactional stores**

Store candidate IDs, merge/tree hashes, phases, tokens, previous/current manifests, receipt acknowledgment, and pause/fence reasons. Never edit prior migrations.

- [ ] **Step 4: Verify**

Run: `npx vitest run src/deploy/journal.test.ts src/deploy/fence.test.ts src/db/db.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/journal.ts src/deploy/journal.test.ts src/deploy/fence.ts src/deploy/fence.test.ts src/db/migrations.ts src/db/db.test.ts src/db/repos.ts
git commit -m "feat: persist deployment transactions"
```

### Task 7: Generic Runtime Executor and Recovery

**Files:**
- Create: `src/deploy/executor.ts`
- Create: `src/deploy/executor.test.ts`
- Create: `src/deploy/recovery.ts`
- Create: `src/deploy/recovery.test.ts`
- Modify: `src/daemon/daemon.ts`
- Modify: `src/daemon/lifecycle.test.ts`

**Interfaces:**
- Consumes: verified artifact, activated adapter, journal, admission lease callback, and fence.
- Produces: `deployed`, `nothing-to-deploy`, `rolled-back`, or `fenced` receipts.

- [ ] **Step 1: Write executor ordering and rollback tests**

Assert: advisory busy checks hold no global lock; admission lease precedes idle recheck; lock is bounded; ordering rechecks under lock; partial activation restores exact previous manifest; unsafe rollback fences; another repository remains pending rather than blocked; outbox replay does not reactivate.

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/deploy/executor.test.ts src/deploy/recovery.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the transaction without private commands**

All business-specific operations are injected adapter callbacks identified by IDs. The generic executor never evaluates a shell command from a PR, issue, or artifact.

- [ ] **Step 4: Run full shared verification**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/executor.ts src/deploy/executor.test.ts src/deploy/recovery.ts src/deploy/recovery.test.ts src/daemon/daemon.ts src/daemon/lifecycle.test.ts
git commit -m "feat: execute fenced automatic deployments"
```

### Task 8: Dry-Run CLI, Status, and Generic Documentation

**Files:**
- Create: `src/deploy/cli.ts`
- Create: `src/deploy/cli.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/daemon/api.ts`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Modify: `docs/trusted-github-handoffs.md`

**Interfaces:**
- Produces: read-only status, reconciliation, dry-run, and bounded operator recovery commands.

- [ ] **Step 1: Write failing CLI safety tests**

Test default dry-run, no merge command, no arbitrary repo/path/command parameters, redacted status, explicit recovery token, and refusal to clear an unverified fence.

- [ ] **Step 2: Prove red**

Run: `npx vitest run src/deploy/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement dry-run and documented cutover surfaces**

Dry-run consumes synthetic repository IDs and artifacts only. Documentation uses placeholders and does not name private repositories or runtime paths.

- [ ] **Step 4: Run release-quality verification**

Run: `npm run prepublishOnly && git diff --check`
Expected: PASS and clean formatting.

- [ ] **Step 5: Commit**

```bash
git add src/deploy/cli.ts src/deploy/cli.test.ts src/cli.ts src/daemon/api.ts README.md SECURITY.md docs/trusted-github-handoffs.md
git commit -m "docs: add autonomous deployment dry run"
```
