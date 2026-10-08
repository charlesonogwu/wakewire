import { z } from "zod";
import type { Agent, CoordinationConfig, CoordinationSnapshot, ReviewComment } from "./policy.js";

export const stages = [
  "evidence:owner",
  "challenge:peer",
  "response:owner",
  "verdict:peer",
  "verification:owner",
] as const;
export type Stage = (typeof stages)[number];
export const isStage = (value: string): value is Stage => stages.some((stage) => stage === value);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const agent = z.enum(["codex", "hermes"]);
const text = z
  .string()
  .min(1)
  .max(4000)
  .refine((s) => s.trim() === s && !/[\r\n]/.test(s));
const impacts = z
  .array(z.enum(["website", "pi", "supabase", "apps-script", "elevenlabs", "telnyx", "cloudflare"]))
  .min(1)
  .refine(
    (a) => new Set(a).size === a.length && JSON.stringify(a) === JSON.stringify([...a].sort()),
  );
const finding = z
  .object({
    id,
    severity: z.enum(["critical", "important", "minor"]),
    component: text.max(200),
    evidence: text.max(1000),
    request: text.max(1000),
  })
  .strict();
const response = z
  .object({
    id,
    disposition: z.enum(["fixed", "accepted-risk", "disputed", "blocked"]),
    evidence: text.max(1000),
  })
  .strict();
const unique = <T extends { id: string }>(items: T[]) =>
  new Set(items.map((item) => item.id)).size === items.length;
const base = {
  pr: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  "head-sha": sha,
};
const schemas = {
  "agent-owner-evidence:v1": z
    .object({ ...base, owner: agent, "evidence-id": id, "impacts-json": impacts, summary: text })
    .strict(),
  "agent-challenge:v1": z
    .object({
      ...base,
      reviewer: agent,
      "challenge-id": id,
      "findings-json": z.array(finding).refine(unique),
      summary: text,
    })
    .strict(),
  "agent-response:v1": z
    .object({
      ...base,
      owner: agent,
      "challenge-id": id,
      "responses-json": z.array(response).refine(unique),
      summary: text,
    })
    .strict(),
  "agent-review:v2": z
    .object({
      ...base,
      reviewer: agent,
      "challenge-id": id,
      decision: z.enum(["approve", "revise", "reject"]),
      summary: text,
    })
    .strict(),
  "agent-owner-verification:v1": z
    .object({ ...base, owner: agent, "verification-id": id, summary: text })
    .strict(),
  "agent-readiness:v1": z
    .object({ ...base, "readiness-id": id, "impacts-json": impacts, summary: text })
    .strict(),
  "agent-release-authorization:v1": z
    .object({
      ...base,
      actor: id,
      source: z.enum(["github", "telegram"]),
      "authorization-id": id,
      "impacts-json": impacts,
    })
    .strict(),
  "agent-routing:v2": z
    .object({ "event-key": text, actor: agent, stage: z.enum(stages), "head-sha": sha })
    .strict(),
};
type Marker = keyof typeof schemas;
type Entry = { marker: Marker; fields: Record<string, unknown>; comment: ReviewComment };
export interface RigorousDecision {
  action: Stage | "wait" | "blocked";
  reason: string;
  stage: string;
  stageKey: string;
}

/** Wire format mirrored from lash-luxe-nyc collaboration-records.mjs (8141ccf).
 * Prose is never authority; only strict envelopes from the assigned trusted actor count. */
export function evaluateRigorous(
  snapshot: CoordinationSnapshot,
  config: CoordinationConfig,
  owner: Agent,
  peer: Agent,
  declared: string[],
): RigorousDecision | null {
  const entries: Entry[] = [];
  let active = false;
  const done = (
    action: RigorousDecision["action"],
    stage: string,
    reason: string,
    key = "none",
  ): RigorousDecision => ({ action, stage, reason, stageKey: key });
  const blocked = (reason: string) => done("blocked", "blocked", reason);
  const seen = new Set<number>();
  for (const comment of snapshot.comments) {
    if (
      ![...config.trustedAuthorIds.codex, ...config.trustedAuthorIds.hermes].includes(
        comment.authorId,
      )
    )
      continue;
    const envelopes = [
      ...comment.body.matchAll(/<!--\s*(agent-[\w-]+:v\d+)\s*\n([\s\S]*?)\n\s*-->/g),
    ].filter((m) => Object.hasOwn(schemas, m[1] ?? ""));
    if (!envelopes.length) continue;
    // Historical records do not activate the new protocol or wake a changed head.
    if (
      !envelopes.some((m) =>
        new RegExp(`^head-sha: ${snapshot.headSha}$`, "m").test((m[2] ?? "").replaceAll("\r", "")),
      )
    )
      continue;
    active = true;
    if (envelopes.length !== 1 || comment.body.length > 8192)
      return blocked("Malformed rigorous envelope");
    const envelope = envelopes[0];
    if (!envelope) continue;
    const marker = envelope[1] as Marker;
    const fields: Record<string, unknown> = {};
    try {
      for (const line of (envelope[2] ?? "").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 1) throw new Error();
        const key = line.slice(0, colon).trim();
        if (Object.hasOwn(fields, key)) throw new Error();
        const value = line.slice(colon + 1).trim();
        fields[key] = key.endsWith("-json") ? JSON.parse(value) : value;
      }
      const parsed = schemas[marker].parse(fields);
      Object.assign(fields, parsed);
    } catch {
      return blocked("Malformed rigorous record");
    }
    if (fields["head-sha"] !== snapshot.headSha) continue;
    const actor =
      marker === "agent-routing:v2"
        ? fields.actor
        : marker === "agent-challenge:v1" || marker === "agent-review:v2"
          ? fields.reviewer
          : owner;
    if (actor !== "codex" && actor !== "hermes") return blocked("Invalid rigorous actor");
    // Routing records are controller-authored; accept the configured owner or peer controller.
    if (marker !== "agent-routing:v2" && !config.trustedAuthorIds[actor].includes(comment.authorId))
      continue;
    if (
      !Number.isSafeInteger(comment.id) ||
      comment.id <= 0 ||
      seen.has(comment.id) ||
      !Number.isFinite(Date.parse(comment.updatedAt))
    )
      return blocked("Invalid rigorous record ordering");
    seen.add(comment.id);
    if (marker !== "agent-routing:v2" && fields.pr !== snapshot.number)
      return blocked("Rigorous record PR mismatch");
    entries.push({ marker, fields, comment });
  }
  if (!active) return null;
  if (!Number.isSafeInteger(snapshot.number) || !snapshot.number)
    return blocked("Missing rigorous PR identity");
  entries.sort(
    (a, b) =>
      Date.parse(a.comment.updatedAt) - Date.parse(b.comment.updatedAt) ||
      a.comment.id - b.comment.id,
  );
  const records = entries.filter((e) => e.marker !== "agent-routing:v2");
  let cursor = -1;
  const next = (marker: Marker, challenge?: unknown) => {
    const index = records.findIndex(
      (e, i) =>
        i > cursor &&
        e.marker === marker &&
        (challenge === undefined || e.fields["challenge-id"] === challenge),
    );
    if (index < 0) return undefined;
    cursor = index;
    return records[index];
  };
  let latest: Entry | undefined;
  const stage = (value: Stage, actor: Agent): RigorousDecision => {
    const key = `${snapshot.repository}:${snapshot.number}:${snapshot.headSha}:${value}:${latest?.comment.id ?? "none"}`;
    // A matching route is optional (records themselves trigger webhooks), but a newer
    // conflicting route must never override the derived stage or its evidence identity.
    const route = entries.filter((e) => e.marker === "agent-routing:v2").at(-1);
    if (
      route &&
      route.fields.stage === value &&
      route.fields["event-key"] === key &&
      route.fields.actor !== actor
    )
      return blocked("Rigorous route actor mismatch");
    return done(
      actor === config.localAgent ? value : "wait",
      value,
      `Rigorous collaboration requires ${value}`,
      key,
    );
  };
  const evidence = next("agent-owner-evidence:v1");
  if (!evidence) {
    const expected = `${snapshot.repository}:${snapshot.number}:${snapshot.headSha}:evidence:owner:none`;
    const route = entries.find(
      (e) =>
        e.marker === "agent-routing:v2" &&
        e.fields["event-key"] === expected &&
        e.fields.stage === "evidence:owner" &&
        e.fields.actor === owner,
    );
    if (!route) return done("wait", "evidence:owner", "No current owner evidence route");
    return stage("evidence:owner", owner);
  }
  if (
    evidence.fields.owner !== owner ||
    JSON.stringify(evidence.fields["impacts-json"]) !== JSON.stringify([...declared].sort())
  )
    return blocked("Owner evidence role or impacts mismatch");
  latest = evidence;
  const challenge = next("agent-challenge:v1");
  if (!challenge) return stage("challenge:peer", peer);
  if (challenge.fields.reviewer !== peer) return blocked("Challenge reviewer mismatch");
  latest = challenge;
  const challengeId = challenge.fields["challenge-id"];
  const findingIds = (challenge.fields["findings-json"] as z.infer<typeof finding>[]).map(
    (f) => f.id,
  );
  for (;;) {
    const answer = next("agent-response:v1", challengeId);
    if (!answer) return stage("response:owner", owner);
    if (answer.fields.owner !== owner) return blocked("Response owner mismatch");
    const answers = answer.fields["responses-json"] as z.infer<typeof response>[];
    if (answers.some((a) => !findingIds.includes(a.id)))
      return blocked("Response finding mismatch");
    latest = answer;
    if (findingIds.some((id) => !answers.some((a) => a.id === id)))
      return stage("response:owner", owner);
    if (answers.some((a) => a.disposition === "fixed" || a.disposition === "blocked"))
      return blocked("Response requires new head or resolution");
    const verdict = next("agent-review:v2", challengeId);
    if (!verdict) return stage("verdict:peer", peer);
    if (verdict.fields.reviewer !== peer) return blocked("Verdict reviewer mismatch");
    latest = verdict;
    if (verdict.fields.decision === "reject") return blocked("Peer rejected current head");
    if (verdict.fields.decision === "revise") continue;
    break;
  }
  const verification = next("agent-owner-verification:v1");
  if (!verification) return stage("verification:owner", owner);
  if (verification.fields.owner !== owner) return blocked("Verification owner mismatch");
  return done(
    "wait",
    "waiting:charles",
    "Rigorous verification recorded; Charles alone decides merge",
    String(verification.comment.id),
  );
}
