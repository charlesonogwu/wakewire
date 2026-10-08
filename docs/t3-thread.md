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
