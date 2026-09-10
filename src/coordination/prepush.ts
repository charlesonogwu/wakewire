import {
  type CoordinationConfig,
  type CoordinationSnapshot,
  evaluateCoordination,
} from "./policy.js";

export interface PrepushCandidate {
  branch: string;
  expectedHead: string;
  candidateSha: string;
  bundleSha256: string;
}

const keys = ["owner", "branch", "expected-head", "candidate-sha", "bundle-sha256"];
const sha = (value: string | undefined): value is string =>
  value !== undefined && value.length === 40 && /^[a-f0-9]+$/.test(value);

// Deliberately narrower than Git's ref grammar: only bounded, inert branch data.
function safeBranch(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length <= 200 &&
    /^hermes\/[A-Za-z0-9_./-]+$/.test(value) &&
    !value.includes("..") &&
    value
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          !part.startsWith(".") &&
          !part.endsWith(".") &&
          !part.endsWith(".lock"),
      )
  );
}

function parseRequest(body: string): PrepushCandidate | null {
  if (body.split("agent-prepush").length !== 2) return null;
  const envelopes = [...body.matchAll(/<!--([\s\S]*?)-->/g)].filter((match) =>
    match[1]?.includes("agent-prepush"),
  );
  if (envelopes.length !== 1) return null;
  const lines = envelopes[0]?.[1]?.trim().split(/\r?\n/);
  if (lines?.shift() !== "agent-prepush:v1") return null;
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([a-z0-9-]+):[ \t]*(\S+)[ \t]*$/.exec(line);
    if (!match?.[1] || !match[2] || !keys.includes(match[1]) || Object.hasOwn(fields, match[1]))
      return null;
    fields[match[1]] = match[2];
  }
  if (
    fields.owner !== "hermes" ||
    !safeBranch(fields.branch) ||
    !sha(fields["expected-head"]) ||
    !sha(fields["candidate-sha"]) ||
    fields["bundle-sha256"]?.length !== 64 ||
    !/^[a-f0-9]+$/.test(fields["bundle-sha256"])
  )
    return null;
  return {
    branch: fields.branch,
    expectedHead: fields["expected-head"],
    candidateSha: fields["candidate-sha"],
    bundleSha256: fields["bundle-sha256"],
  };
}

/** Pure shared gate for a fresh snapshot, including the unchanged review policy.
 * Malformed trusted evidence invalidates the batch. Select latest BEFORE checking
 * head/branch/candidate eligibility, so stale or withdrawn requests cannot revive
 * earlier requests. Untrusted authors never influence selection or ordering.
 */
export function selectPrepushRequest(
  snapshot: CoordinationSnapshot,
  config: CoordinationConfig,
): PrepushCandidate | null {
  if (config.prepushEnabled !== true || config.localAgent !== "codex") return null;
  const decision = evaluateCoordination(snapshot, config);
  if (
    decision.action !== "wait" ||
    decision.owner !== "hermes" ||
    snapshot.state !== "open" ||
    snapshot.repository !== config.expectedRepository ||
    snapshot.headRepository !== config.expectedRepository ||
    !safeBranch(snapshot.headBranch) ||
    snapshot.labels.some(
      (label) =>
        label === config.waitingLabel ||
        /^(review|changes-requested|approved|blocked|waiting):/.test(label),
    )
  )
    return null;
  const seen = new Set<number>();
  let latest: { request: PrepushCandidate; time: number; id: number } | undefined;
  for (const comment of snapshot.comments) {
    if (
      !config.trustedAuthorIds.hermes.includes(comment.authorId) ||
      !comment.body.includes("agent-prepush")
    )
      continue;
    const time = Date.parse(comment.updatedAt);
    if (
      !Number.isFinite(time) ||
      !Number.isSafeInteger(comment.id) ||
      comment.id <= 0 ||
      seen.has(comment.id)
    )
      return null;
    seen.add(comment.id);
    const request = parseRequest(comment.body);
    if (!request) return null;
    if (!latest || time > latest.time || (time === latest.time && comment.id > latest.id))
      latest = { request, time, id: comment.id };
  }
  const request = latest?.request;
  return request &&
    request.expectedHead === snapshot.headSha &&
    request.branch === snapshot.headBranch &&
    request.candidateSha !== request.expectedHead
    ? request
    : null;
}
