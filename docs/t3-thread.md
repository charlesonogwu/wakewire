# T3 thread sink

`t3-thread` delivers WakeWire events to existing T3 Code threads through the
installed `t3code-thread-bridge` programmatic client. It uses the bridge's existing
token discovery; do not put tokens in registration files. T3 must be running and
the bridge installation must be available to the account running WakeWire.

Create an explicit local JSON registration file, using absolute paths:

```json
{
  "threadIds": ["11111111-1111-4111-8111-111111111111"],
  "bridgePath": "C:/path/to/t3code-thread-bridge/server/dist/bridge.js",
  "stateFile": "C:/path/to/wakewire/receipts.db",
  "inheritPermissions": true
}
```

Set `WAKEWIRE_T3_REGISTRATION` to that file and select
`wakewire config set sink.adapter t3-thread` for the intended WakeWire instance.
These are setup instructions, not an automatic cutover: installing the code does
not change any running daemon, scheduled task, route, or service.

`threadIds` is an ordered list of unique UUIDs: primary first, then optional
fallbacks. Route targets must name the primary. A running/busy session is usable:
delivery always uses `after-current`, queuing behind the active turn. An errored
session is skipped for the next usable session. Null or stopped sessions can be
started by T3. No usable session holds the delivery for retry. Unknown thread IDs
are permanent errors, except when incomplete environment discovery prevents
distinguishing a missing thread from an offline environment. Archived threads
are configuration errors. Unknown session states are not assumed usable.

The registration is strict (unknown keys are rejected). `inheritPermissions`
explicitly acknowledges that T3 owns the thread's permissions. WakeWire preserves
the thread's runtime and interaction modes. As with the Desktop sink, routes must
use `workspace-write`; this sink cannot impose a different sandbox on an existing
T3 thread. New thread creation and prompt coalescing are disabled.

An optional `coordination` block uses the **same** schema, exact-SHA trusted-event
filter, and completion monitor as `codex-desktop`. Use the existing repository,
author IDs, waiting label and prepush settings; do not invent a second trust gate.
The existing queue, completion journal and SQLite receipts remain authoritative.

## Delivery and recovery

The receipt database stores the selected target and exact command before sending.
The prompt includes `[wakewire-delivery:"DELIVERY_ID"]`. Before dispatch, and on
retry, the sink searches projected user messages including older pages. Acceptance
is only reported after projection is verified; the target ID is recorded in logs.
Projection confirms receipt of the wake, not successful model execution or task
completion. The existing coordination monitor handles completion separately.

An ambiguous dispatch becomes `UnreachableError`, so the durable queue retries.
If the marker is projected, retry acknowledges it without sending again. Otherwise
it replays the **same persisted commandId, messageId, target and command body**.
This relies on T3's persistent orchestration command receipts: accepted command IDs
return their prior sequence instead of starting a second turn. Verified against
T3 Code 0.0.45 (`OrchestrationCommandReceiptRepository` and the command handler).
Keep that contract when updating T3. The bridge API is an installed integration,
not a bundled or pinned npm dependency; this implementation matches bridge 0.2.0.

Once a command might have been dispatched, retry stays on that target even if the
primary recovers or the selected session later errors. Switching targets then
could execute the same wake twice. Restore the selected target's connectivity to
reconcile it. Do not delete receipts or remove an in-flight target from registration.
Reusing a delivery ID with changed content is rejected. Receipt files contain
prompts and should have the same access protection as the existing WakeWire state.

All automated sink tests use fake T3 clients and temporary databases. They do not
send real wakes, book appointments, contact customers, or touch live services.
