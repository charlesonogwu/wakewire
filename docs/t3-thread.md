# T3 thread sink

`t3-thread` is a TypeScript port of the deployed MR T WakeWire runtime's
`dist/sinks/t3-thread.js` and `t3-mcp.js` from release
`9f660827d5934bdedf7d7dc16436541cde464ca7`. It uses the installed T3 thread bridge
over MCP stdio, pinning its entry point by SHA-256. The bridge discovers existing
local credentials; do not copy tokens or private provider bindings into registration.

Missing, unreadable or checksum-mismatched bridge files do not prevent daemon
startup. Calls log `re-register T3 bridge` and raise UnreachableError so the queue
holds and retries; `probe()` reports false. An operator verifies the installed
bridge, updates its registered path/hash, and restarts the intended daemon to load
that registration. Never automatically trust a new checksum. Malformed hashes and
relative paths remain permanent configuration errors.
If the pin changes immediately before submission, the client proves no transport
was opened: only that unsent claim is released for retry. A timeout or any other
ambiguous send never releases its receipt.

The primary fields preserve the deployed registration shape. Optional
`fallbackTargets` adds ordered alternatives, each with its own complete identity:

```json
{
  "threadId": "primary-thread-id",
  "environmentId": "primary-environment-id",
  "projectId": "primary-project-id",
  "cwd": "C:/work/project",
  "fallbackTargets": [
    {
      "threadId": "fallback-thread-id",
      "environmentId": "fallback-environment-id",
      "projectId": "fallback-project-id",
      "cwd": "C:/work/project"
    }
  ],
  "stateFile": "C:/private/wakewire/receipts.db",
  "inheritPermissions": true,
  "serverPath": "C:/path/to/t3code-thread-bridge/server/dist/index.js",
  "serverSha256": "REPLACE_WITH_VERIFIED_LOWERCASE_SHA256"
}
```

All paths must be absolute. Targets must have distinct thread IDs. Unknown keys
are rejected. Set `WAKEWIRE_T3_REGISTRATION` to this private JSON file and choose
`wakewire config set sink.adapter t3-thread` for the intended WakeWire instance.
These instructions do not perform cutover: installing code changes no running
daemon, scheduled task, route, Pi service, or production configuration.

Routes name the primary thread. Every candidate is checked against `get_thread`,
`list_projects`, and project-filtered `list_threads`: thread, environment, project,
and canonical workspace path must all match. Identity mismatch fails permanently.
The deployed bridge listing limit of 100 is preserved; a target absent from that
project listing fails closed. Unknown thread errors are permanent; other read or
transport failures hold for retry. `probe()` verifies the primary's identity and
reachability without sending a message.

## T3 Code's own MCP endpoint

The pinned bridge stopped working when T3 Code began requiring
`x-t3-orchestration-protocol: 2` and removed `POST /api/orchestration/dispatch`.
Set `"transport": "t3-official-mcp"` to use T3 Code's supported endpoint instead:
`<origin>/mcp` with an OAuth bearer token. Without `transport` (or with `"bridge"`),
the pinned bridge remains the default and existing registrations parse unchanged.

```json
{
  "transport": "t3-official-mcp",
  "tokenFile": "C:/private/wakewire/t3-mcp-token.json"
}
```

These keys are added to the registration above. `tokenFile` must be absolute. An
optional `"origin"` pins the T3 server. Without it, the origin is read from
`~/.t3/userdata/server-runtime.json` (default `http://127.0.0.1:3773`), and it is
re-read once per call after a connection failure. Only loopback http origins are
accepted. The stored token is bound to the origin and `/mcp` resource it was approved
for. If T3 moves to another origin, the daemon logs
``T3 origin changed: re-run `wakewire t3 login` `` and holds deliveries until a new
login. `serverPath` and `serverSha256` may stay in the file (ignored) so switching
back is one line.

To switch the daemon over:

1. Run `wakewire t3 login --registration <t3-registration.json>` (or set
   `WAKEWIRE_T3_REGISTRATION`). It registers a client named "WakeWire" with a
   loopback redirect, prints the T3 approval URL, and waits once on 127.0.0.1.
2. Open the URL and approve in your signed-in T3 session (or with a pairing code).
   Choose **Operate** access (`orchestration:read orchestration:operate`). Read-only
   access is refused. The token is stored in the registration's `tokenFile`, or by
   default `t3-mcp-token.json` next to the registration. It is restricted to the
   current user (owner-only ACL on Windows, 0600 elsewhere). It is never printed or logged.
3. Add `"transport": "t3-official-mcp"` and `"tokenFile"` to `t3-registration.json`.
4. Restart the scheduled task (or daemon) that loads this registration.

**Re-approval is needed every 30 days.** T3 issues no refresh token. `wakewire t3 status`
shows the expiry date and days left, never the token. With fewer than 5 days left,
the daemon logs a warning once a day. While the token is still valid, it also sends a
short notice to the first fallback target (the orchestrator), or the primary if there is
none. The notice is **at-most-once per expiry**. It is claimed in the receipt database
before sending. A failed send is retried with the same `clientRequestId`, which T3
deduplicates. A crash mid-send leaves the claim in place, and that notice is never
retried, so it can be missed; the daily log warning still appears. The token file is re-read on every call, so a fresh
`wakewire t3 login` takes effect without a restart.

With this transport, a missing, unreadable, malformed, expired or rejected token
(HTTP 401/403) logs ``re-approve T3 access: run `wakewire t3 login` `` and **holds**
deliveries; it never drops them. The log names the reason (for example the OS error
code or the malformed fields), never the file content. It repeats at most once per
10 minutes per reason.
A request that T3 refused for auth reasons, or that never connected, provably was not
submitted. Only that unsent claim is released for retry.

Mapping onto T3's tools (exact names, or a uniquely prefixed variant found via
`tools/list`):

| Adapter call | T3 tool | Notes |
| --- | --- | --- |
| `get_thread` | `t3_thread_read` | `view: "messages"`; `thread.threadId`, `projectId`, `status`, `pendingRequestCount`, `archived` |
| `list_projects` | `t3_project_list` | paginated by `nextCursor`; project `id` + `workspaceRoot` |
| `send_message` | `t3_thread_send` | `mode: "queue"` only (the old `after-current`), plus `clientRequestId` |

`t3_thread_list` is not used: `t3_thread_read` is authoritative for thread identity.
The project listing only supplies the workspace path. If the project is absent from a
listing that ended early (20 pages), the delivery is held, not failed. A send succeeds
only on an exact acknowledgement: `threadId` equal to the target, a string
`messageId`, and `delivery` of `started`, `queued` or `steered`. Any other response
takes the uncertain path. The fence is kept, the sink reconciles read-only, and it
never resends.

`clientRequestId` is derived from the delivery ID and content hash. T3 deduplicates
sends by it, so a retry of the same delivery never double-sends. The receipt fence and
marker reconciliation still apply. Reconciliation scans the most recent 1000 thread
items for the user message carrying the delivery marker.

The official endpoint serves one T3 environment, so identity is thread +
project + canonical workspace path + not archived; `environmentId` is still required in the
registration but is only compared by the bridge. Readiness: a pending human request
or `waiting` status holds (BusyError); `failed` advances to the next fallback;
`idle`, `running`, `completed`, `interrupted` and `cancelled` accept a queued message;
other states (`preparing`, `queued`, `starting`, unknown) hold.

## Session selection and permissions

A session or latest turn in `error`, or attention state `error`, advances to the
next registered target. If all providers/sessions failed, the queue holds for retry.
Fallbacks must never perform review of the PR they implement. For Lash & Luxe,
Solider (`a8cd2ec8-24b2-4b94-bcbe-9bf075aabd7b`) is primary and the orchestrator
(`75f3174e-5df9-4c24-89a1-4c6aee1f93c3`) is the routing fallback. The orchestrator
re-routes the wake to a suitable owner; it does not self-review. A PR's assigned
reviewer must not become its fallback implementer without a new independent reviewer.
Human approval, input and plan requests hold with `BusyError`; they are never
bypassed through a fallback. The deployed allowlist is preserved: attention must
be `working`, `done` or `idle`, and session status `running`, `ready` or `stopped`.
Starting or unknown states hold. Running threads receive `after-current`, allowing
T3 to queue the message. No new threads are created and prompts are not coalesced.

`inheritPermissions: true` explicitly acknowledges T3's existing thread permissions.
The MCP client cannot pass runtime/interaction overrides. As with the deployed
adapter, routes must use `workspace-write`; this sink cannot impose a different
sandbox on an existing T3 thread.

An optional `coordination` block uses the existing CoordinationConfigSchema,
CoordinationAdapter exact-SHA trust filter, and CoordinationCompletionMonitor.
The MR T-specific IssueGateAdapter is not ported: this integration preserves the
Lash & Luxe release's PR coordination and completion flow.

## Receipts, uncertainty and status

The deployed receipt identity is preserved: the primary key is `deliveryId`, and
the content hash is SHA-256 of `[primaryThreadId, prompt]`. A `sending` fence is
persisted before MCP submission. Successful `sent: true`, `verified: true`
acknowledgement must identify the chosen thread/environment and `after-current`.
It confirms message projection, not model success or completed engineering work.

The only receipt schema extension records the selected fallback thread. Existing
three-column receipt tables migrate without discarding records; old receipts
refer to the primary. Successful receipts return the original target after restart.
Prompts include `[wakewire-delivery:"DELIVERY_ID"]` to support manual inspection.

After an ambiguous send, unverified projection or pending receipt, the sink makes
a read-only reconciliation attempt on the recorded target: verify its identities,
then inspect up to 20 pages of 50 recent turns for a **user** message containing the
exact delivery marker. A match marks the receipt sent and returns success without
calling `send_message`. Otherwise it remains uncertain and throws PermanentError:
**never resend and never switch to a fallback after possible submission**. The sink
emits an error log with delivery ID, selected thread and `status: "uncertain"`.
The existing queue persists `status: "failed"` and the reconciliation reason,
visible via authenticated `GET /api/deliveries?status=failed` and delivery history.
The failed item releases its FIFO slot so later items continue. Completion-monitor
attempts also log uncertainty and transition the existing job to `needs-attention`.
No additional queue, status store or periodic Desktop heartbeat is introduced.

The branch owner or orchestrator investigates uncertainty by joining the failed
delivery row to the log's delivery ID and selected thread, then inspecting that
thread for the marker. The CompletionMonitor's attention/follow-up wakes or the
next actionable GitHub event re-wake the owner under the existing exact-SHA gates;
they are not proof the earlier wake was delivered. A pending receipt can be retried
for read-only reconciliation, but absent evidence always remains uncertain.

Inspect the selected thread and receipt before any manual reconciliation. Do not
blindly replay a failed queue item: replay creates a new delivery identity. Do not
delete receipts to force a resend. A provider failing after submission does not
justify sending the same wake to another provider because acceptance is uncertain.

## Deliberate additions to the deployed port

- Strict registration, duplicate-target rejection and ordered per-target identities.
- Provider/session error fallback before submission, retaining human-request gates.
- Persisted fallback target, delivery marker and explicit success/uncertainty logs.
- Explicit unknown-thread PermanentError classification, with sanitized error text.
- Lash & Luxe CoordinationCompletionMonitor wiring instead of MR T's issue gate.
- Database closure in `finally` even if MCP shutdown fails.
- Recoverable bridge-pin failures with explicit re-registration logs.
- Read-only marker reconciliation of ambiguous sends and pending receipts.

The direct programmatic-client command-replay approach from the first PR revision
is removed. Conservative pending-receipt behavior is intentional. Tests use fake
MCP clients, temporary databases and synthetic events; no real bookings, customer
messages, payments or production actions are performed.
