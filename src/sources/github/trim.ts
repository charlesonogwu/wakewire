import type { WakeEvent } from "../../core/event.js";

const COMMIT_MESSAGE_LIMIT = 500;
const MAX_COMMITS = 20;

/**
 * Reduce a raw GitHub webhook payload to the few fields routes and prompts
 * need. Nothing outside this trimmed shape ever reaches the model.
 */
export function trimGithubEvent(args: {
  eventName: string;
  deliveryId: string;
  payload: Record<string, unknown>;
}): WakeEvent | null {
  const { eventName, deliveryId, payload } = args;
  const repo = repoFullName(payload);
  if (!repo) return null; // ping and other repo-less events are not routable
  const action = typeof payload.action === "string" ? payload.action : undefined;
  const kind = action ? `${eventName}.${action}` : eventName;
  const occurredAt = new Date().toISOString();

  if (eventName === "status") {
    const sha =
      typeof payload.sha === "string" && /^[a-f0-9]{40}$/.test(payload.sha) ? payload.sha : null;
    return {
      source: "github",
      kind: "status",
      deliveryId,
      occurredAt,
      summary: `status event on ${repo}`,
      payload: {
        repo,
        sha,
        senderId: isRecord(payload.sender) ? githubId(payload.sender.id) : null,
      },
    };
  }

  if (eventName === "push") {
    return trimPush({ repo, deliveryId, occurredAt, payload });
  }
  if (eventName === "pull_request") {
    return trimPullRequest({ repo, kind, action, deliveryId, occurredAt, payload });
  }
  if (eventName === "issues") {
    return trimIssue({ repo, kind, action, deliveryId, occurredAt, payload });
  }
  if (eventName === "check_run" && action === "completed") {
    const check = isRecord(payload.check_run) ? payload.check_run : {};
    const prs = Array.isArray(check.pull_requests) ? check.pull_requests : [];
    // CI completion can make a previously quiet review ready. Never infer an
    // association from a SHA or choose arbitrarily among multiple PRs.
    const number = prs.length === 1 && isRecord(prs[0]) ? prNumber(prs[0].number) : null;
    return {
      source: "github",
      kind,
      deliveryId,
      occurredAt,
      summary: `${kind} event on ${repo}`,
      payload: {
        repo,
        action,
        senderId: isRecord(payload.sender) ? githubId(payload.sender.id) : null,
        number,
        isPullRequest: number !== null,
      },
    };
  }
  if (
    eventName === "issue_comment" ||
    eventName === "pull_request_review_comment" ||
    eventName === "pull_request_review"
  ) {
    const comment = isRecord(payload.comment)
      ? payload.comment
      : eventName === "pull_request_review" && isRecord(payload.review)
        ? payload.review
        : {};
    const subject = isRecord(payload.issue)
      ? payload.issue
      : isRecord(payload.pull_request)
        ? payload.pull_request
        : {};
    return {
      source: "github",
      kind,
      deliveryId,
      occurredAt,
      summary: `${kind} event on ${repo}`,
      payload: {
        repo,
        ...(action ? { action } : {}),
        senderId: isRecord(payload.sender) ? githubId(payload.sender.id) : null,
        commentAuthorId: isRecord(comment.user) ? githubId(comment.user.id) : null,
        commentId: githubId(comment.id),
        commentBody: truncate(typeof comment.body === "string" ? comment.body : "", 4000),
        number:
          typeof subject.number === "number" &&
          Number.isSafeInteger(subject.number) &&
          subject.number > 0
            ? subject.number
            : null,
        isPullRequest: isRecord(payload.pull_request) || isRecord(subject.pull_request),
      },
    };
  }
  // Generic fallback: minimal, still routable by repo + event name.
  return {
    source: "github",
    kind,
    deliveryId,
    occurredAt,
    summary: `${kind} event on ${repo}`,
    payload: { repo, ...(action ? { action } : {}) },
  };
}

function trimPush(args: {
  repo: string;
  deliveryId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): WakeEvent {
  const { repo, deliveryId, occurredAt, payload } = args;
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  const branch = ref.replace(/^refs\/(heads|tags)\//, "");
  const pusher =
    isRecord(payload.pusher) && typeof payload.pusher.name === "string"
      ? payload.pusher.name
      : "unknown";
  const compareUrl = typeof payload.compare === "string" ? payload.compare : "";
  const rawCommits = Array.isArray(payload.commits) ? payload.commits : [];
  const commits = rawCommits.slice(0, MAX_COMMITS).map((c) => trimCommit(c));
  const commitCount = rawCommits.length;
  const plural = commitCount === 1 ? "commit" : "commits";
  return {
    source: "github",
    kind: "push",
    deliveryId,
    occurredAt,
    summary: `${commitCount} ${plural} pushed to ${repo}:${branch} by ${pusher}`,
    payload: {
      repo,
      branch,
      pusher,
      compareUrl,
      commitCount,
      ...(commitCount > MAX_COMMITS ? { commitsTruncatedTo: MAX_COMMITS } : {}),
      commits,
    },
  };
}

function trimCommit(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const message = typeof raw.message === "string" ? raw.message : "";
  const author =
    isRecord(raw.author) && typeof raw.author.name === "string" ? raw.author.name : "unknown";
  const filesChanged =
    arrayLength(raw.added) + arrayLength(raw.removed) + arrayLength(raw.modified);
  return {
    sha: typeof raw.id === "string" ? raw.id : "",
    author,
    message: truncate(message, COMMIT_MESSAGE_LIMIT),
    filesChanged,
  };
}

function trimPullRequest(args: {
  repo: string;
  kind: string;
  action: string | undefined;
  deliveryId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): WakeEvent {
  const { repo, kind, action, deliveryId, occurredAt, payload } = args;
  const pr = isRecord(payload.pull_request) ? payload.pull_request : {};
  const number = prNumber(payload.number ?? pr.number);
  const title = typeof pr.title === "string" ? truncate(pr.title, 200) : "";
  const author = isRecord(pr.user) && typeof pr.user.login === "string" ? pr.user.login : "unknown";
  const url = typeof pr.html_url === "string" ? pr.html_url : "";
  const headBranch = isRecord(pr.head) && typeof pr.head.ref === "string" ? pr.head.ref : "";
  const baseBranch = isRecord(pr.base) && typeof pr.base.ref === "string" ? pr.base.ref : "";
  return {
    source: "github",
    kind,
    deliveryId,
    occurredAt,
    summary: `PR #${number ?? "?"} ${action ?? ""} on ${repo}: ${title}`.trim(),
    payload: {
      repo,
      ...(action ? { action } : {}),
      number: number ?? null,
      senderId: isRecord(payload.sender) ? githubId(payload.sender.id) : null,
      isPullRequest: true,
      title,
      author,
      url,
      branch: headBranch,
      baseBranch,
      body: truncate(typeof pr.body === "string" ? pr.body : "", 1000),
    },
  };
}

function trimIssue(args: {
  repo: string;
  kind: string;
  action: string | undefined;
  deliveryId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): WakeEvent {
  const { repo, kind, action, deliveryId, occurredAt, payload } = args;
  const issue = isRecord(payload.issue) ? payload.issue : {};
  const number = typeof issue.number === "number" ? issue.number : undefined;
  const title = typeof issue.title === "string" ? truncate(issue.title, 200) : "";
  const author =
    isRecord(issue.user) && typeof issue.user.login === "string" ? issue.user.login : "unknown";
  const url = typeof issue.html_url === "string" ? issue.html_url : "";
  return {
    source: "github",
    kind,
    deliveryId,
    occurredAt,
    summary: `Issue #${number ?? "?"} ${action ?? ""} on ${repo}: ${title}`.trim(),
    payload: {
      repo,
      ...(action ? { action } : {}),
      number: number ?? null,
      title,
      author,
      url,
      body: truncate(typeof issue.body === "string" ? issue.body : "", 1000),
    },
  };
}

function repoFullName(payload: Record<string, unknown>): string | null {
  const repository = payload.repository;
  if (isRecord(repository) && typeof repository.full_name === "string") {
    return repository.full_name;
  }
  return null;
}

function githubId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return null;
}

function prNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated]`;
}
