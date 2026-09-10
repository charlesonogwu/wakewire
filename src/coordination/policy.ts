export type Agent = "codex" | "hermes";
export interface ReviewComment {
  authorId: string;
  id: number;
  body: string;
  updatedAt: string;
}
export interface CoordinationSnapshot {
  repository: string;
  state: "open" | "closed";
  headSha: string | null;
  headRepository: string;
  body: string;
  labels: readonly string[];
  checks: "success" | "pending" | "failure";
  comments: readonly ReviewComment[];
}
export interface CoordinationConfig {
  expectedRepository: string;
  localAgent: Agent;
  trustedAuthorIds: Readonly<Record<Agent, readonly string[]>>;
  waitingLabel: string;
}
export interface CoordinationResult {
  action: "ignore" | "wait" | "fix" | "review" | "verify" | "ready" | "blocked";
  reason: string;
  headSha: string | null;
  owner: Agent | null;
}
const agents = ["codex", "hermes"] as const;
const impacts = new Set(["website", "pi", "supabase", "elevenlabs", "cloudflare"]);
const validSha = (value: string | null): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const isAgent = (value: string | undefined): value is Agent =>
  value === "codex" || value === "hermes";

/** Strict newline-separated key: value fields in exactly one HTML envelope.
 * Unknown/duplicate keys, versions and partial envelopes fail closed.
 */
function parseEnvelope(body: string, marker: string, keys: readonly string[]) {
  if (body.split(marker).length !== 2) return null;
  const envelopes = [...body.matchAll(/<!--([\s\S]*?)-->/g)].filter((match) =>
    match[1]?.includes(marker),
  );
  if (envelopes.length !== 1) return null;
  const lines = envelopes[0]?.[1]?.trim().split(/\r?\n/);
  if (!lines || lines.shift() !== `${marker}:v1`) return null;
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = /^([a-z-]+):\s*(\S.*?)\s*$/.exec(line.trim());
    if (!match?.[1] || !match[2] || !keys.includes(match[1]) || Object.hasOwn(fields, match[1])) {
      return null;
    }
    fields[match[1]] = match[2];
  }
  return keys.every((key) => Object.hasOwn(fields, key)) ? fields : null;
}

/** Pure policy: labels never substitute for trusted current-SHA review votes.
 * Shared account IDs cannot distinguish physical authors: reviewer markers identify
 * logical agents, so a shared account can cast both votes. Use separate IDs for
 * independently authenticated reviewers.
 * Labels: agent:AGENT, review:AGENT, changes-requested:AGENT, approved:AGENT,
 * blocked:coordination and the configured waiting label. Other labels are inert.
 */
export function evaluateCoordination(
  snapshot: CoordinationSnapshot,
  config: CoordinationConfig,
): CoordinationResult {
  let owner: Agent | null = null;
  const result = (action: CoordinationResult["action"], reason: string): CoordinationResult => ({
    action,
    reason,
    headSha: snapshot.headSha,
    owner,
  });
  if (snapshot.state === "closed" || snapshot.repository !== config.expectedRepository) {
    return result("ignore", "Closed or foreign repository");
  }
  if (snapshot.labels.includes("blocked:coordination"))
    return result("blocked", "Manual coordination block");
  if (!validSha(snapshot.headSha) || snapshot.headRepository !== config.expectedRepository) {
    return result("blocked", "Invalid head SHA or fork head");
  }
  const handoff = parseEnvelope(snapshot.body, "agent-handoff", [
    "origin",
    "owner",
    "reviewer",
    "impacts",
  ]);
  if (
    !handoff ||
    !isAgent(handoff.owner) ||
    handoff.origin !== handoff.owner ||
    !isAgent(handoff.reviewer) ||
    handoff.reviewer === handoff.owner ||
    !handoff.impacts?.split(",").every((impact) => impacts.has(impact.trim()))
  ) {
    return result("blocked", "Invalid handoff metadata");
  }
  owner = handoff.owner;
  const peer = handoff.reviewer;
  const ownerLabels = agents.map((agent) => `agent:${agent}`);
  const approvalLabels = agents.map((agent) => `approved:${agent}`);
  const workflows = agents.flatMap((agent) => [`review:${agent}`, `changes-requested:${agent}`]);
  if (
    !config.waitingLabel.trim() ||
    [...ownerLabels, ...approvalLabels, ...workflows, "blocked:coordination"].includes(
      config.waitingLabel,
    )
  ) {
    return result("blocked", "Invalid waiting label configuration");
  }
  workflows.push(config.waitingLabel);
  const known = new Set([...ownerLabels, ...approvalLabels, ...workflows]);
  const labels = snapshot.labels;
  if (
    labels.some(
      (label) =>
        /^(agent|review|changes-requested|approved|blocked|waiting):/.test(label) &&
        !known.has(label),
    ) ||
    labels.filter((label) => ownerLabels.includes(label)).length !== 1 ||
    !labels.includes(`agent:${owner}`) ||
    labels.filter((label) => workflows.includes(label)).length > 1 ||
    labels.filter((label) => approvalLabels.includes(label)).length > 1 ||
    labels.includes(`review:${owner}`) ||
    labels.includes(`changes-requested:${peer}`)
  ) {
    return result("blocked", "Contradictory or unknown coordination labels");
  }
  type Vote = { decision: string; time: number; id: number };
  const latest: Partial<Record<Agent, Vote>> = {};
  const seen = new Set<number>();
  for (const comment of snapshot.comments) {
    if (
      !agents.some((agent) => config.trustedAuthorIds[agent].includes(comment.authorId)) ||
      !comment.body.includes("agent-review")
    )
      continue;
    const review = parseEnvelope(comment.body, "agent-review", [
      "reviewer",
      "decision",
      "head-sha",
    ]);
    if (
      !review ||
      !isAgent(review.reviewer) ||
      !["approve", "revise", "reject"].includes(review.decision ?? "") ||
      !validSha(review["head-sha"] ?? null)
    )
      return result("blocked", "Malformed trusted review");
    if (!config.trustedAuthorIds[review.reviewer].includes(comment.authorId)) continue;
    const time = Date.parse(comment.updatedAt);
    if (
      !Number.isFinite(time) ||
      !Number.isSafeInteger(comment.id) ||
      comment.id <= 0 ||
      seen.has(comment.id)
    ) {
      return result("blocked", "Invalid or duplicate review ordering evidence");
    }
    seen.add(comment.id);
    if (review["head-sha"] !== snapshot.headSha) continue;
    const previous = latest[review.reviewer];
    if (!previous || time > previous.time || (time === previous.time && comment.id > previous.id)) {
      latest[review.reviewer] = { decision: review.decision ?? "", time, id: comment.id };
    }
  }
  if (agents.some((agent) => latest[agent]?.decision === "reject"))
    return result("blocked", "Current review rejects head");
  if (
    agents.some(
      (agent) => labels.includes(`approved:${agent}`) && latest[agent]?.decision !== "approve",
    )
  ) {
    return result("blocked", "Approval label contradicts current evidence");
  }
  if (labels.includes(`changes-requested:${owner}`) && latest[peer]?.decision === "approve") {
    return result("blocked", "Change request contradicts current peer approval");
  }
  if (
    latest[peer]?.decision === "revise" &&
    config.localAgent === owner &&
    labels.includes(`changes-requested:${owner}`)
  ) {
    return result("fix", "Peer requested owner changes on current head");
  }
  if (
    agents.every((agent) => latest[agent]?.decision === "approve") &&
    snapshot.checks === "success"
  ) {
    return result("ready", "Both agents approve current head and checks succeeded");
  }
  if (config.localAgent !== owner && labels.includes(`review:${config.localAgent}`)) {
    return result("review", "Local peer review requested");
  }
  if (
    config.localAgent === owner &&
    latest[peer]?.decision === "approve" &&
    latest[owner]?.decision !== "approve"
  ) {
    return result(
      "verify",
      "Run owner verification and post the owner's current-head review attestation; do not infer approval",
    );
  }
  return result("wait", "Incomplete review or checks");
}
