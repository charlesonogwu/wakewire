# Windows Existing-Thread Handoffs Implementation Plan

**Goal:** Safely resume an existing Windows Desktop conversation for explicitly authorized GitHub handoffs.

**Architecture:** Keep WakeWire's signed ingress and durable queue. Add bounded comment metadata and opt-in immutable actor/author filters. Coordinate access to the existing conversation using a verified supported lifecycle mechanism; never assume a private server sees another server's active turn.

**Constraints:** Public code/tests must use synthetic repositories, identities and paths. No customer operations, deployment, merge, secret disclosure, live webhook registration, or active-conversation injection during development. Preserve default route behavior. Keep automatic delivery disabled until real Desktop coexistence is verified.

## Task 1: Trusted comment routing

- [ ] Add `src/sources/github/comment-handoff.test.ts` covering real signed-event-shaped inputs through trimming and routing. Require sender ID and comment author ID; reject missing or substituted identities. Do not confuse issue author with comment author. Verify bounded body and known fields only.
- [ ] Run the test and record intended failures before implementation.
- [ ] Add optional numeric-string `senderIds`, `commentAuthorIds`, and bounded `commentMarker` to GitHub matching; require exact string identity matches and exact marker lines. Extract comment metadata only for comment/review events, without copying private irrelevant provider fields.
- [ ] Run focused tests, typecheck, and existing routing tests. Test configuration persistence normalization so new filters are not silently stripped.

## Task 2: Desktop coexistence

Implementation update: the installed bundled Desktop MCP connector was discovered
and tested read-only, then with one harmless active-task message. The message was
received by the same live Desktop conversation. The experimental adapter now uses
that owner-routed connector, not hooks or a private app-server. It verifies one
registered local task/workspace and uses a durable sending fence. Queue coalescing
is disabled for this adapter to preserve receipt identities. Live GitHub ingress
and unattended branch actions remain disabled. The idle-wake probe subsequently
passed through the existing Desktop owner with one durable sent receipt; do not
repeat the completed probe. Follow the dual-review plan for remaining activation.

- [ ] Investigate supported Codex lifecycle hooks or shared-server coordination and document limitations with Windows runtime evidence.
- [ ] Implement a narrowly scoped guard only if every participating turn can share the same authority. Missing registration, corrupt state, duplicate ownership or uncertain liveness must hold delivery rather than spawn competing work.
- [ ] Test simultaneous acquisition, stale completion, interruption, process exit, and missing hook registration. Do not use elapsed time alone to declare a live worker dead.
- [ ] Run a synthetic isolated conversation probe before any real target turn. If supported hooks cannot enforce safety, keep this portion explicitly incomplete.

## Task 3: Delivery and activation

- [ ] Audit Windows executable resolution, hidden process startup and permissions. Configure no live secrets in source.
- [ ] Validate trusted handoff plus exact PR head/ownership and durable deduplication before actions; bound revision cycles and suppress self-originated output.
- [ ] Run full tests/build, scan the scoped diff for private data, and push a reviewable fork PR.
- [ ] Install only after source and coexistence checks pass. Use private authenticated ingress and a durable missed-event recovery mechanism. Test signed synthetic deliveries and service restart. Do not claim activation until verified.
