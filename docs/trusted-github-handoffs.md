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

## Unpublished candidate verification

The optional `prepushEnabled` coordination setting recognizes a separate
`agent-prepush:v1` envelope from the configured trusted peer author. It is not
an approval envelope. It names only the current assigned branch, expected old
head, candidate commit and bundle digest. Unknown fields, changed ownership,
workflow blocks, stale heads and ambiguous requests cannot authorize a push.

A correction may retain `changes-requested:hermes` while its old head remains
rejected. The sole exception requires the unchanged owner policy to validate a
trusted current-head peer **Revise**, and a new trusted pre-push submission ordered
after the review evidence. Manual blocks, Reject, approval/review/waiting labels,
contradictory labels, and malformed evidence still stop verification. The selector
does not remove labels or alter votes. Both the listener and runner use this same
gate, including the runner's fresh check immediately before pushing.

After the guarded push, the old review is stale, not converted to approval. The
existing owner task must transition its superseded change-request label to the
peer-review workflow; both agents must review/attest the new exact SHA. Retain any
manual block. Failed verification leaves the old head and its rejection intact.
This is new-candidate resubmission, not automatic retry of an already-attempted
candidate. A repeated request with the same candidate facts retains its delivery
receipt and journal fences; inspect the journal and remote state before recovery.

Configure the candidate CLI separately in a private file. Its peer host, export
root, local state root, digest-pinned Docker image and trusted author identity
come from that file, never from a GitHub comment. Keep listener prepush disabled
until the runner has been independently verified. Docker must already be
available; the runner must not repair Docker, reset data or install a different
container engine automatically.

Provision the state root before running the CLI: owner-only permissions on POSIX,
or an owner/SYSTEM-only ACL on Windows. The runner does not create missing parent
directories. POSIX candidate-directory entries are synced before proceeding.
Windows retains exclusive locks and file flushes, but portable directory flushing
and automatic power-loss recovery are not claimed; inspect journals and remote
state after an uncertain interruption.

Run the compiled entrypoint with the locally approved configuration and PR number:

```sh
node dist/prepush-cli.js --config /absolute/private/prepush.json --pr 123
```

The CLI fetches fresh GitHub evidence itself; it does not accept a candidate SHA,
shell command, or export path from its command line. No eligible request returns
`skipped` before fetching an artifact. A successful result reports `pushed` only
after reading the exact candidate back from the assigned remote branch.

The peer exports a single-ref Git bundle under its SHA-256 filename. The desktop
verifies bytes, Git refs, ancestry and the current PR before executing code.
Dependency download is separated from offline testing. Build containers receive
neither host credentials nor the Docker socket. Test/build success remains
separate from both reviewer approvals. Only the exact tested commit may be
pushed with an unchanged-old-head guard; uncertain outcomes require readback.

The runner measures the extracted tracked files before dependency installation
and again after testing, using fresh offline containers. Changes to tracked
contents, modes, or paths prevent pushing; untracked generated build outputs are
allowed. Candidate directories and journals are retained privately. An existing
candidate directory, interrupted operation, or uncertain result is not retried
blindly: inspect its journal and the remote branch before any recovery.

Existing owner tasks must be explicitly configured to export and await this
verification stage instead of pushing first. Merely enabling a webhook does
not change those tasks or authorize deployment of their business changes.

Received events are durably queued. Events GitHub could not deliver while the
receiver was offline require explicit reconciliation; do not assume automatic
GitHub redelivery. Likewise, an uncertain Desktop acceptance requires inspection,
not deleting its receipt and retrying blindly.
