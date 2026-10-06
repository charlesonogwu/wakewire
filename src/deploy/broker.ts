import type { Role } from "./types.js";

export interface RawTransport {
  request(method: string, path: string, body: unknown): Promise<unknown>;
}

export interface GuardedTransport {
  post(path: string, body: unknown): Promise<unknown>;
}

export interface BrokerScope {
  owner: string;
  name: string;
  branches: string[];
}

export interface Broker {
  publishBranch(input: {
    owner: string;
    name: string;
    branch: string;
    sha: string;
    role: Role;
  }): Promise<void>;
  comment(input: { owner: string; name: string; pr: number; body: string }): Promise<void>;
  status(input: { owner: string; name: string; sha: string; state: string }): Promise<void>;
}

export function createGuardedTransport(inner: RawTransport): GuardedTransport {
  return {
    async post(requestPath, body) {
      if (requestPath.includes("/merge")) throw new Error("merge forbidden");
      const allowed =
        /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(requestPath) ||
        /^\/repos\/[^/]+\/[^/]+\/statuses\/[0-9a-f]{40}$/.test(requestPath) ||
        /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.test(requestPath);
      if (!allowed) throw new Error(`endpoint forbidden: ${requestPath}`);
      return inner.request("POST", requestPath, body);
    },
  };
}

export function createBroker(transport: GuardedTransport, scope: BrokerScope, role: Role): Broker {
  const assertRepository = (input: { owner: string; name: string }) => {
    if (input.owner !== scope.owner || input.name !== scope.name) {
      throw new Error("repository is outside the broker lane");
    }
  };
  return {
    async publishBranch(input) {
      assertRepository(input);
      if (!scope.branches.includes(input.branch))
        throw new Error("branch is outside the owned lane");
      if (role !== "author") throw new Error("publish requires the author role");
      await transport.post(`/repos/${input.owner}/${input.name}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: input.sha,
      });
    },
    async comment(input) {
      assertRepository(input);
      await transport.post(`/repos/${input.owner}/${input.name}/issues/${input.pr}/comments`, {
        body: input.body,
      });
    },
    async status(input) {
      assertRepository(input);
      await transport.post(`/repos/${input.owner}/${input.name}/statuses/${input.sha}`, {
        state: input.state,
      });
    },
  };
}
