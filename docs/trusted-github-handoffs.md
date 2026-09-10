# Trusted GitHub comment handoffs

GitHub routes can opt into immutable sender and comment-author ID filters:

```json
{
  "repo": "acme/api",
  "events": ["issue_comment.created"],
  "senderIds": ["123"],
  "commentAuthorIds": ["123"],
  "commentMarker": "<!-- handoff: implementer -> reviewer -->"
}
```

Both configured identities must match. A trusted editor cannot turn a comment
written by an untrusted account into a trusted handoff. Missing identities fail
closed. The marker must occupy an exact standalone line within the first 4,000
characters. A marker is not a credential: keep webhook signature verification
enabled and configure both identity filters. Existing routes without these
filters retain their previous behavior.

Comment metadata is supported for issue comments, PR review comments, and PR
reviews. Only selected metadata is forwarded; issue authors are never used as
comment authors. Comment text remains untrusted input even from an allowed
account. Before editing a branch, the receiver must separately verify current
PR ownership, assignment, head SHA, and the authorized scope. These filters do
not implement that policy or authorize production operations.

## Windows Desktop integration status

An experimental `codex-desktop` adapter uses the installed bundled Desktop MCP
connector's `read_thread` and `send_message_to_thread` tools. It never starts an
app-server or loads a separate copy of the conversation. Desktop owns admission
and execution; a successful result means message acceptance, not completed work.

Registration must explicitly name one thread, its local workspace, a receipt
database, the installed connector path and SHA-256, and the inherited local pipe.
Set `WAKEWIRE_DESKTOP_REGISTRATION` to that local JSON file, with keys `threadId`,
`cwd`, `stateFile`, `serverPath`, `serverSha256`, `pipePath`, and
`inheritPermissions: true`. Never commit this file. Protect it with owner-only
filesystem permissions. App updates or restarts may require registration again.
This integration depends on the installed connector and is not a stable public
Desktop webhook API.

Only existing local threads and explicitly opted-in `workspace-write` routes
are supported. **Desktop's existing permissions are inherited**; this adapter
cannot enforce a narrower sandbox. It rejects read-only routes rather than
silently weakening them. Keep model settings unchanged. Unknown state or a busy
conversation postpones delivery. Missing/wrong thread or workspace is rejected.

SQLite records a durable fence before submission. A dropped response or crash
leaves the delivery uncertain and blocks automatic resend; inspect the target
conversation and reconcile manually. Do not delete uncertain receipts to retry.
The existing queue's delivery identifier is passed through to this ledger.

The local diagnostic `scripts/desktop-connection-probe.mjs` accepts an installed
connector path and, optionally, `--send-once`. Without that flag it only probes
reachability. With it, one fixed synthetic message is sent after the calling
conversation becomes idle, at most once per thread, with a ten-minute deadline.
It does not install a daemon, register webhooks, or enable business handoffs.

## Dual-review delivery gate

The opt-in coordination gate reads current GitHub evidence before delivering work.
Both logical agents must explicitly approve the same current commit, with passing
checks, before readiness is reported. An old approval, a label by itself, or a
self-declared marker from an untrusted account cannot establish readiness.
Branch owners make corrections; the other agent reviews. Missing owner evidence
requires verification rather than an inferred approval. Merge and deployment
remain separately authorized actions, never webhook commands.

Subscribe coordination routes to PR and comment changes, completed check runs,
and commit `status` events. Some CI providers finish through commit statuses
rather than check runs. Status events resolve current, same-repository open PRs
through the commit association API, then fetch each PR's fresh evidence. Stale
commits and fork associations do not authorize a wake. Multiple current matches
are processed individually rather than selecting an arbitrary first match.

This gate does not install an implementer on a peer machine. The peer's existing
reviewer and owner-task dispatcher must be configured separately. In particular,
a peer prohibited from building locally needs an off-machine pre-push verification
handoff; do not bypass its build-before-push rule to make the queue advance.

Using the same GitHub account for both agents identifies logical roles, not two
independently authenticated people. Separate trusted account IDs give stronger
identity separation. The event receiver cannot enforce the Desktop task's tool
permissions: those remain inherited as described above.

## Dedicated signed ingress

To expose only GitHub webhooks through a tunnel, configure a listen-mode GitHub
source and set both `WAKEWIRE_GITHUB_SOURCE_ID` and
`WAKEWIRE_GITHUB_INGRESS_PORT` before daemon startup. The dedicated listener binds
`127.0.0.1` and accepts only `POST /github`, with a 1 MiB body limit and the source's
GitHub HMAC secret. Point the tunnel at this dedicated port, **not the management
API port**. Unknown paths are not forwarded to management. No tunnel or GitHub
hook is installed merely by these code changes.

Received events are durably queued. Events GitHub could not deliver while the
receiver was offline require explicit reconciliation; do not assume automatic
GitHub redelivery. Likewise, an uncertain Desktop acceptance requires inspection,
not deleting its receipt and retrying blindly.
