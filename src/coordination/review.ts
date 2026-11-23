import type { Agent } from "./policy.js";

export type ParsedReview =
  | { kind: "absent" | "invalid" }
  | { kind: "review"; reviewer: Agent; decision: "approve" | "revise" | "reject"; headSha: string };

/** Only explicit declarations are protocol input; mentioning its name is prose.
 * Bare declarations and incomplete/duplicate envelopes remain invalid, not absent.
 */
export function parseReview(body: string): ParsedReview {
  const starts = [
    ...body.matchAll(/<!--[\s]*agent-review\b|^[\t ]*agent-review(?::[^\s]+)?[\t ]*\r?$/gm),
  ];
  if (starts.length === 0) return { kind: "absent" };
  if (starts.length !== 1) return { kind: "invalid" };
  const envelopes = [...body.matchAll(/<!--([\s\S]*?)-->/g)].filter((m) =>
    /^\s*agent-review\b/.test(m[1] ?? ""),
  );
  const lines = envelopes.length === 1 ? envelopes[0]?.[1]?.trim().split(/\r?\n/) : undefined;
  if (lines?.shift() !== "agent-review:v1") return { kind: "invalid" };
  const fields: Record<string, string> = {};
  const coreFields = ["reviewer", "decision", "head-sha"];
  const legacyFields = ["pr", "head", "summary", "evidence"];
  for (const line of lines) {
    const match = /^([a-z-]+):\s*(\S.*?)\s*$/.exec(line.trim());
    if (
      !match?.[1] ||
      !match[2] ||
      ![...coreFields, ...legacyFields].includes(match[1]) ||
      Object.hasOwn(fields, match[1])
    )
      return { kind: "invalid" };
    fields[match[1]] = match[2];
  }
  const { reviewer, decision, "head-sha": headSha } = fields;
  const legacyCount = legacyFields.filter((field) => Object.hasOwn(fields, field)).length;
  if (
    (reviewer !== "codex" && reviewer !== "hermes") ||
    (decision !== "approve" && decision !== "revise" && decision !== "reject") ||
    !headSha ||
    !/^[a-f0-9]{40}$/.test(headSha) ||
    (legacyCount !== 0 && legacyCount !== legacyFields.length) ||
    (legacyCount === legacyFields.length &&
      (!/^[1-9]\d*$/.test(fields.pr ?? "") || fields.head !== headSha))
  )
    return { kind: "invalid" };
  return { kind: "review", reviewer, decision, headSha };
}
