# Autonomous Review-to-Deployment Design

**Status:** proposed for operator review  
**Date:** 2026-10-05  
**Scope:** WakeWire coordination shared by multiple private application repositories

## Purpose

Opening an authorized issue or pull request should start a rigorous agent
collaboration without requiring the operator to relay messages. The agents should
challenge assumptions, test the exact proposed revision, resolve findings, and
produce one plain-English recommendation. The operator's single Merge action is
the only release authorization. A successful merge automatically deploys the
exact reviewed result to the correct runtime and verifies it. There is no second
deployment approval.

The system must support multiple private repositories on one constrained runtime
host without sharing their code, context, credentials, queues, or deployment
targets.

## Success criteria

1. An authorized issue or PR event starts the correct repository lane
   automatically.
2. The author and reviewer continue until the exact merge candidate is
   merge-ready, blocked with evidence, or not worth merging.
3. A new head or base revision invalidates earlier review and test evidence.
4. The operator receives one concise, plain-English merge summary and does not
   have to carry messages between agents.
5. Agents cannot merge. The operator's GitHub merge is the only deployment
   authorization.
6. A valid merge deploys automatically, without another approval, and records a
   verified receipt.
7. A failed deployment restores the last known-good runtime files when safe,
   prevents conflicting deployments, and opens a linked repair workflow.
8. Live business activity continues when the review computer is offline. Review
   work remains durably queued.
9. A reviewed PR may intentionally change application behavior, schedules,
   prompts, quantities, targets, or enabled states. The system exposes and tests
   that behavior diff; it does not freeze current behavior merely because the
   change affects production automation.

## Non-goals

- Automatically merging a PR.
- Treating every issue as a software defect.
- Giving reviewers production credentials or a generic production shell.
- Copying a full repository over a curated runtime workspace.
- Undoing external effects such as sent messages, emails, posts, payments, or
  database mutations during rollback.
- Claiming two independent human identities when logical agents share one GitHub
  account.

## Behavior-change authority

The deployment system separates **protected production data** from **intentional
application behavior**. Secrets, customer/runtime state, and arbitrary commands
remain forbidden. Behavior-changing source or declarative configuration is a
normal deployable artifact when the PR explicitly scopes it, offline tests cover
it, both agents approve the exact candidate, the plain-English merge summary
states the before/after behavior, and the operator merges it.

Tests, dry runs, and deployment verification never actuate business actions.
After deployment, the normal production jobs enact the newly merged behavior.
The one-time infrastructure cutover preserves existing behavior only to avoid
accidental changes during migration; it is not a permanent restriction on later
PRs.

## Topology

### Review host

A capable development machine runs the WakeWire coordinator and two isolated
repository lanes. Each lane has its own:

- repository allowlist and remote;
- durable queue and state namespace;
- long-lived T3 context;
- checkout and worktree root;
- dependency cache and test environment;
- repository adapter and deployment history.

The lanes may share the coordinator process and execution scheduler, but they
must never share task context, worktrees, credentials, or artifacts. Each lane
has distinct long-lived author and reviewer T3 contexts; one context cannot cast
both verdicts. Review jobs may run concurrently when resources permit.
Production deployment activation is serialized globally.

### Runtime host

The constrained runtime host keeps:

- Telegram/business-facing Hermes sessions;
- live schedules and business automation;
- production credentials and runtime data;
- a small, trusted, no-agent deployment executor;
- the global deployment lock and local rollback material.

It does not perform repository checkout, code review, dependency installation,
or model-driven engineering work after cutover.

### GitHub

GitHub is the durable collaboration record and event source. T3 conversations
are working context, not authority. WakeWire consumes signed repository events,
reads fresh GitHub state, and wakes only the lane registered for that repository.

## Authority model

### Operator authority

The operator is the only merger. Existing auto-merge workflows must be disabled
at cutover. Agent environments must not receive a credential or tool that can
call GitHub's merge endpoint.

Private repositories may not support enforceable branch protection on the
current GitHub plan. Therefore the practical boundary is:

1. remove every automated merge path;
2. withhold generic GitHub credentials from model processes;
3. expose only narrow broker operations for branch publication, comments, and
   status records;
4. reject deployment for direct pushes or merges without a current merge-ready
   record;
5. check the configured operator identity on the merge event, while documenting
   that a shared GitHub account cannot cryptographically distinguish a human UI
   click from an API call made with that same account.

The last limitation is handled operationally: agent sandboxes and brokers never
receive the account's generic token or any merge operation. The operator keeps
the interactive GitHub session. If separate GitHub identities become available,
the same actor check becomes enforceable at the account boundary.

The GitHub merge event is deployment authorization. No Telegram message, issue
comment, label, model output, or WakeWire event can substitute for it.

### Agent authority

The author may edit only its owned branch. The reviewer may inspect exact source,
create tests in an isolated writable test area, and publish findings, but may not
edit the author's branch. Neither role may merge or deploy.

### Deployment authority

The runtime executor accepts only a coordinator-signed deployment request tied to
an actual merged PR, the verified merge SHA, a signed artifact manifest, and a
previously activated repository adapter. The executor cannot select arbitrary
paths or commands from PR text and never downloads release contents from GitHub.

## Work identity

Every work item is identified by:

- repository ID;
- issue number, when present;
- PR number;
- owner and reviewer roles;
- head SHA;
- base SHA used to form the tested candidate;
- tested candidate tree hash;
- unique request ID.

A PR number or chat thread alone is never sufficient identity.

## Lifecycle

### 1. Intake

An issue event starts requirements triage only when the repository adapter
classifies it as authorized and repairable. Duplicate reports correlate to the
existing job. Login walls, rate limits, quiet periods, ambiguous requests, and
operational outages may be recorded without starting code work.

A PR event creates or resumes its linked job. A draft PR may be inspected,
challenged, and tested, but cannot become merge-ready until it is marked ready
for review. Ambiguous PRs remain waiting. Webhook duplicates are idempotent.

### 2. Author evidence

The author publishes a structured record for the exact head and base containing:

- intended behavior;
- assumptions and conjectures;
- changed areas;
- tests run and results;
- known limitations;
- expected runtime and deployment effects.

### 3. Independent challenge

The reviewer checks out immutable source at the exact candidate, inspects every
changed safe file, and proposes concrete counterexamples. The reviewer may add
synthetic tests in a disposable test workspace. It must state files it could not
inspect and evidence it could not obtain.

The reviewer does not need to invent a defect. A valid review may approve after
documenting the challenges attempted and why the evidence was sufficient.

### 4. Resolution loop

Each finding is accepted, rejected with evidence, or marked unresolved. Accepted
findings receive a regression test when practical. Any branch update invalidates
all prior approval for the old head. Any base update invalidates the tested
candidate and requires regeneration of candidate evidence.

The loop ends in one of three durable states:

- `merge-ready`: current candidate approved, required tests successful, and no
  current blockers;
- `blocked`: evidence or infrastructure is unavailable, disagreement remains,
  or a safety boundary prevents completion;
- `not-worth-merging`: the reviewer recommends stopping and records why. This is
  advice, not authority to close or merge the PR.

Timeouts, exhausted model budgets, unavailable machines, and unknown outcomes
never become approvals.

Author and reviewer are separate T3 contexts on the review host, mapped by
repository policy. The reviewer may be a dedicated Hermes review context, but it
is not the production-credentialed Telegram Hermes process. Telegram Hermes is a
request router and result presenter only. It may wake the dedicated reviewer and
relay that reviewer's signed verdict, but it does not inspect untrusted source,
run engineering tests, or cast the verdict itself. A coordinator model cannot
impersonate both roles or manufacture the second verdict.

### 5. Plain-English readiness summary

For a merge-ready or not-worth-merging candidate, WakeWire publishes one
operator-facing summary with:

- what changes and the expected outcome;
- why the change is needed;
- the important assumptions challenged by each agent;
- findings and their resolutions;
- tests and checks that passed on the exact candidate;
- remaining limitations and risks;
- exactly what will be deployed after Merge;
- anything intentionally unchanged.

The summary names the repository, PR, head SHA, base SHA, and candidate tree. A
new revision supersedes the summary automatically. A blocked job publishes a
durable reason and next required evidence so it cannot look like work is still
silently running.

### 6. Merge validation

On merge, the coordinator reads fresh GitHub state and verifies:

- the PR has a current merge-ready record;
- the PR head that GitHub merged equals the reviewed head;
- the tested base/candidate relationship remains valid;
- required hosted checks succeeded;
- the actual merge commit tree exactly matches the tested candidate tree;
- the merge is not a direct push or unrelated commit;
- no newer release for the same repository has already been activated.

If the merge method produces a different tree than the tested candidate, the
deployment stops, fences that release, opens a linked repair job, and sends one
operator notice. The merged code remains in GitHub; robots do not revert the
default branch. The same response applies when any post-merge authorization
check fails. The repository's release queue pauses immediately and may resume
only for the linked reviewed repair release.

### 7. Automatic deployment

A validated merge durably creates a deployment intent before changing runtime
state. An advisory busy check runs without a lock. When the affected service may
become available, the executor acquires its adapter-defined scheduler admission
lease, which prevents a new business job from starting, then rechecks that the
service is idle while holding that lease. Only then may it acquire the Pi-wide
activation lock with a fencing token and recheck release ordering. Lock
acquisition is bounded and nonblocking: if the lease, idle recheck, activation
lock, or ordering check is unavailable, the executor releases anything it holds
and returns the deployment to pending unless runtime state is uncertain. Only
activation and rollback hold the global lock. A pending deployment does not
prevent the other repository from preparing its artifact or reaching its own
idle window.

The previously activated repository adapter supplies a trusted, versioned
definition of:

- deployable file manifest or artifact builder;
- fixed runtime target;
- files and directories that must never be copied;
- idle/busy checks;
- offline, non-actuating verification commands;
- service reload rules;
- backup and rollback procedure;
- compatibility and irreversible-change declarations.

The PR cannot rewrite its own production target or weaken shared executor safety
rules. An adapter change requires separate review, explicit adapter-policy tests,
and its own operator-merged adapter-policy PR; that Merge is its activation
authorization. It cannot govern an application merge in the same release that
introduces it.

The review host builds the immutable artifact from the actual merge SHA, signs a
manifest containing every file hash and compatibility declaration, and sends the
artifact directly to the runtime executor. The executor verifies the signature,
hashes, adapter version, target identity, architecture, runtime versions, and
release ordering before activation. Dependencies are either already declared
compatible or included as target-compatible artifacts; deployment never performs
an unbounded dependency installation on the runtime host.

The executor backs up the prior manifest, activates atomically where possible,
and performs bounded verification. Documentation-only merges may produce a
verified `nothing-to-deploy` receipt.

### 8. Receipt or recovery

Success records the merge SHA, deployed manifest and hashes, verification output,
previous release, timestamps, and fencing token. The operator receives
`merged, deployed, and verified` only after this receipt exists.

On failure:

1. record the failed phase before retrying or rolling back;
2. restore the previous compatible file manifest when safe;
3. verify restoration;
4. retain the global lock if runtime state is uncertain;
5. create a linked repair issue/PR and wake the correct repository lane with
   sanitized evidence;
6. pause that repository's release queue so the same bad manifest cannot be
   reintroduced;
7. notify the operator once with the deployed/rolled-back/uncertain outcome.

The failed merged PR cannot be reopened on GitHub. Recovery occurs through a new,
linked repair job. No second deployment approval is needed for a safe rollback.
A future corrected release still requires the operator to merge its PR. A paused
repository resumes only for a release explicitly linked as the repair, after its
normal review and merge. An uncertain runtime state fences all activation until a
bounded operator recovery command verifies the installed manifest and clears the
fence; clearing the fence does not approve or redeploy the failed release.

Releases with an irreversible or rollback-unsafe state transition cannot become
merge-ready until their adapter records a separately reviewed recovery procedure
and compatibility proof. If rollback is unsafe after activation begins, the
executor fences the runtime and reports the required operator recovery instead
of attempting a destructive guess.

## Durable state

The coordinator persists, per repository:

- issue-to-PR job identity and current state;
- owner/reviewer assignment;
- exact source, base, candidate, and merge identities;
- challenges, findings, responses, and limitations;
- test commands, results, and artifact digests;
- readiness summary and notification receipt;
- deployment intent and phase journal;
- current and previous release manifests;
- verification and rollback receipts;
- paused/fenced state and reason.

Records are written before external mutations. After restart, the coordinator
re-reads GitHub and runtime state before continuing. Unknown delivery or deploy
outcomes are reconciled, never blindly repeated.

The coordinator periodically reconciles merged PRs and current release records so
a missed webhook cannot lose a deployment. The runtime executor keeps a durable
receipt outbox and resends unacknowledged receipts idempotently after connectivity
returns.

## Shared WakeWire responsibilities

The public, generic package may implement:

- signed event intake and deduplication;
- repository registry and lane routing;
- review state machine and exact-revision invalidation;
- bounded T3 wake delivery;
- structured evidence parsing;
- readiness summary generation;
- deployment transaction state, global locking, and receipts;
- crash recovery and reconciliation;
- generic interfaces for testing and deployment adapters.

It must not contain private repository names, runtime paths, customer data,
credentials, business rules, or production commands.

## Private repository responsibilities

Each application repository owns a private adapter defining:

- repairable issue classification;
- author and reviewer routing;
- supported source-file types;
- exact CI-equivalent test commands and runtime versions;
- deployable artifact allowlist;
- fixed runtime destination and protected paths;
- busy checks and service ownership;
- non-actuating health verification;
- backup, compatibility, and rollback rules.

Adapters are tested like production code. One repository's adapter cannot import
or reference the other's adapter.

## Isolation and resource rules

- Separate repository roots, queues, T3 contexts, worktrees, virtualenvs,
  `node_modules`, caches, artifacts, and state namespaces.
- No production `.env`, browser profile, messaging token, database URL, or
  customer data on the review host.
- Model processes receive no host keyring, generic GitHub token, deployment key,
  Docker socket, or arbitrary production network access.
- Tests run with bounded CPU, memory, time, output, process count, and network.
- Repository reviews may run concurrently; runtime activation is serialized.
- Runtime deployment waits while the affected business service is busy. Waiting
  happens outside the global activation lock, does not require a second approval,
  and is not reported as failure.
- A deployment for one repository must not restart or modify the other
  repository's services.

## Cutover

1. Inventory each current reviewer, auto-merge path, deployer, runtime target,
   and rollback mechanism.
2. Create two isolated review-host projects and install CI-matching runtimes.
3. Implement and test the generic coordinator in dry-run mode.
4. Add and independently review one private adapter per repository.
5. Disable existing automatic merge and Pi engineering-review workers.
6. Run one synthetic PR per repository through review and dry-run deployment.
7. Enable real merge-triggered deployment for one repository at a time.
8. Verify recovery from duplicate events, host restart, busy runtime, failed
   verification, and failed rollback before enabling the second repository.

During cutover, exactly one coordinator may admit work for a repository. Old and
new systems must not claim the same issue or PR.

## Acceptance tests

The implementation is not complete until automated or controlled tests prove:

- correct repository routing for simultaneous events;
- duplicate-event deduplication;
- stale head and stale base invalidation;
- author/reviewer separation and immutable review source;
- independent reviewer test execution without branch mutation;
- blocked and not-worth-merging states do not become ready;
- no agent-accessible merge operation;
- direct pushes do not deploy;
- merge-tree mismatch does not deploy;
- one-click merge creates exactly one deployment intent;
- a missed merge webhook is recovered by reconciliation exactly once;
- a lost deployment acknowledgment is recovered from the receipt outbox;
- cross-repository deployments serialize with fencing;
- busy/offline runtime remains pending without losing authorization;
- partial activation rolls back the exact previous manifest;
- restart reconciliation does not duplicate deployment;
- rollback uncertainty fences later deployments;
- a verified operator recovery can clear a fence without approving the failed
  release;
- a failed release cannot be reintroduced except through its linked reviewed
  repair release;
- the runtime rejects unsigned, wrong-architecture, wrong-runtime, and
  same-merge adapter updates;
- documentation-only merge returns `nothing-to-deploy`;
- one repository cannot access or restart the other's runtime;
- operator summaries are concise, accurate, and invalidated by new revisions.

## Decisions from cross-agent review

- GitHub, not chat memory, is the durable collaboration record.
- The runtime host retains business agents; engineering review moves off-host.
- One shared coordinator is acceptable; repository state and adapters are not
  shared.
- Merge is the sole deployment authorization and does not require a second
  operator action.
- Automatic rollback restores runtime files only; robots never revert GitHub's
  default branch.
- A deployment delay caused by a busy or offline runtime is pending work, not a
  request for another approval.
- Agent labels under one GitHub account represent logical roles, not independent
  authenticated people; source/test isolation and narrow brokers provide the
  practical independence available today.
