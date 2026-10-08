# Rigorous collaboration routing

This layer targets the exact record and routing formats in lash-luxe-nyc merge 8141ccf, `ops/coordination/collaboration-records.mjs` and `github-client.mjs`. It is stacked on the unchanged approved T3 adapter b144e47. It does not deploy or modify the live daemon.

Trusted current-head rigorous records select the stage independently of prose or stale approval labels. Owner stages are evidence:owner, response:owner and verification:owner; reviewer stages are challenge:peer and verdict:peer. Stage prompts name the corresponding strict marker, and never request legacy approvals. Codex reviewers never edit Hermes branches. A completed owner verification stops at waiting:charles and grants no merge or rollout authority.

The initial evidence stage requires a trusted agent-routing:v2 envelope whose repository, PR, head, actor, stage and event key match. Subsequent record sequences derive the stage from owner evidence, matching challenge, complete response, verdict and fresh verification. A route cannot skip those prerequisites. Records are ordered by GitHub update time and numeric ID; malformed current records, duplicate IDs, wrong roles/impacts and rejected or blocked findings fail closed. Older-head records are historical. Current trusted protocol records suppress the legacy dual-approval policy; PRs without them retain agent-review:v1 support. Role-specific trusted author IDs still apply. Routing is controller-authored and accepts either configured trusted controller ID, matching the shared GitHub account deployment.

Snapshots include the PR number. Old-head rigorous comment webhooks are consumed without sending, even if another stage is now active. Closed/fork/foreign PR and manual block gates remain. Removing the Codex at-mention has no policy effect; structured records carry routing data.

The existing durable completion monitor journals each stage and its evidence key separately. It completes when trusted stage evidence advances, supersedes changed heads/evidence, retains bounded resume attempts, and does not wait for obsolete agent-review:v1 votes. No heartbeat or second delivery queue is added. The existing T3 receipt and conservative reconciliation remain unchanged.

Tests include actual #130 owner evidence (6053004224) and routing (6052968684) comment bodies, plus both roles, revise cycles, exact-SHA filtering, idempotency, malformed/trust cases and completion progression. Only public coordination metadata is copied. JSON fixtures contain no customer data or credentials.
