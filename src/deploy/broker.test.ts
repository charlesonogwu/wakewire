import { describe, expect, it } from "vitest";
import { createBroker, createGuardedTransport } from "./broker.js";

describe("broker", () => {
  it("exposes no merge method and rejects merge endpoints", async () => {
    const calls: string[] = [];
    const transport = createGuardedTransport({
      async request(method, requestPath) {
        calls.push(`${method} ${requestPath}`);
        return { ok: true };
      },
    });
    const broker = createBroker(
      transport,
      {
        owner: "example",
        name: "one",
        branches: ["review"],
      },
      "author",
    );
    expect(Object.keys(broker).sort()).toEqual(["comment", "publishBranch", "status"]);
    await expect(transport.post("/pulls/7/merge", {})).rejects.toThrow(/merge forbidden/);
    await broker.comment({ owner: "example", name: "one", pr: 7, body: "hello" });
    await broker.status({ owner: "example", name: "one", sha: "a".repeat(40), state: "success" });
    await broker.publishBranch({
      owner: "example",
      name: "one",
      branch: "review",
      sha: "b".repeat(40),
      role: "author",
    });
    expect(calls.some((call) => call.includes("merge"))).toBe(false);
  });
});
