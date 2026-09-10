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
