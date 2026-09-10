# Pre-push handoff implementation plan

> Use subagent-driven-development for the protocol, then independently review the complete integration.

**Goal:** Let an assigned peer submit an unpublished candidate for isolated desktop tests before any push, without treating those tests as review approval.

**Architecture:** A trusted comment names immutable candidate facts, never commands or paths. WakeWire rechecks current PR ownership and head, then wakes the existing Desktop task. A locally configured artifact runner retrieves only a digest-named bundle from a fixed peer root, validates its ancestry and refs, tests without credentials, and pushes only the tested commit to the unchanged assigned branch.

**Spec:** User approved continuing the existing dual-review automation with Docker isolation. No business merge/deployment or customer actions are authorized.

## Constraints

- Opt-in; unchanged behavior when disabled. Existing main/peer review approval rules remain intact.
- Public examples synthetic; private host, path and credentials never appear in comments or source.
- No arbitrary URLs, remote paths, command strings or environments in request metadata.
- Exact SHA and SHA-256, trusted immutable author, current owner and assigned branch must match.
- Failing build or uncertain push stops; never weaken tests to unblock a task.
- A build result is not an approval. Independently review the pushed SHA afterward.

## Task 1: Trusted candidate wake

Files: new `src/coordination/prepush.ts` and tests; adapter integration/tests; minimal snapshot `headBranch` readback and schema changes.

Add optional `prepushEnabled` to coordination configuration, default false. Add optional `headBranch` to snapshot for backward compatibility; populate from provider `head.ref` if present. Prepush requires it.

Only when existing policy yields wait with owner hermes and localAgent codex, select the latest trusted Hermes-author comment containing a single strict envelope:

```text
<!-- agent-prepush:v1
owner: hermes
branch: hermes/example
expected-head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
candidate-sha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
bundle-sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
-->
```

Unknown/duplicate fields, multiple envelopes, invalid order evidence, malformed trusted request fail closed. Ignore untrusted requests. Latest request selected by updatedAt then numeric ID before testing head match, so a newer withdrawn/stale request cannot resurrect an older one. Require exact expected current head, different candidate, same repo, open PR, safe `hermes/` branch equal to current headBranch. No manual block/review/changes-requested/approval/waiting labels may be bypassed. Stale expected head quietly ignores. Do not modify existing review evidence or rules.

Create a stable separate `prepush:v1` logical delivery key with repo,PR,head,branch,candidate,digest. Exclude comment ID/time/prose. Deliver controlled instructions plus bounded JSON using the existing Desktop receipts; never start a new task. The prompt requires fixed private artifact configuration, digest/ref/ancestry checks, credential-free Docker tests/build and verify:push, an expected-old-head guarded fast-forward push, readback, and separate review afterward. The request is not deployment or merge approval.

- [ ] Write red tests for valid request, disabled, forged author, stale/newer supersession, malformed/duplicate envelope, branch mismatch, manual block, same candidate, retries/dedup and ordinary review unchanged.
- [ ] Implement pure parsing/selection and adapter integration, run focused tests green.
- [ ] Run full tests/typecheck/build/scoped lint and review the scoped diff independently before activation.

## Task 2: Isolated artifact execution and peer continuation

- [ ] Verify Docker startup and a credential-free container before enabling candidate execution.
- [ ] Configure fixed private peer export root and digest-named bundles; validate local/remote path boundaries without exposing them.
- [ ] Reject multiple refs, unrelated histories, changed candidate content, stale branch head, symlinks escaping the test input, and host credential mounts.
- [ ] Run install without lifecycle scripts, then approved tests/build offline in a resource-bounded unprivileged container. Allow only task files and dependency volume, no Docker socket or user home mounts.
- [ ] Keep source verification and push authentication outside the build container. Recheck exact unchanged remote head immediately before a lease-guarded fast-forward push and verify remote candidate afterward.
- [ ] Record durable per-candidate results separately from review votes; uncertain push reconciles by readback, never creates a new candidate.
- [ ] Update the existing blocked peer task to implement/commit/export and request pre-push verification. No Pi build, direct push, production mutation or false completion.
