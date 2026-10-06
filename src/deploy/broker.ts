export interface RawTransport {
  request(method: string, path: string, body: unknown): Promise<unknown>;
}

export interface GuardedTransport {
  post(path: string, body: unknown): Promise<unknown>;
}

export interface Broker {
  publishBranch(input: { owner: string; name: string; branch: string; sha: string }): Promise<void>;
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

export function createBroker(transport: GuardedTransport): Broker {
  return {
    async publishBranch(input) {
      await transport.post(`/repos/${input.owner}/${input.name}/git/refs`, {
        ref: `refs/heads/${input.branch}`,
        sha: input.sha,
      });
    },
    async comment(input) {
      await transport.post(`/repos/${input.owner}/${input.name}/issues/${input.pr}/comments`, {
        body: input.body,
      });
    },
    async status(input) {
      await transport.post(`/repos/${input.owner}/${input.name}/statuses/${input.sha}`, {
        state: input.state,
      });
    },
  };
}
