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

This change does **not** enable safe automatic delivery to a conversation that
is already loaded by another Codex Desktop runtime. A separately spawned
app-server can have its own in-memory view of the same persisted thread.
Checking that server's status is not a cross-process reservation.

The required next integration is delivery through the existing Desktop owner,
with serialized admission and completion correlated to the exact turn. Do not
treat hook timers, file-age checks, or a private app-server as proof of exclusive
ownership. Keep automatic delivery disabled until an isolated end-to-end probe
verifies the owner-routed connection, interruption, retries, and deduplication.
