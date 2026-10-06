import { describe, expect, it } from "vitest";
import { clearFence, initialFence, release, retain, tryAcquire } from "./fence.js";

describe("fence", () => {
  it("rejects a stale token and every direct clear", () => {
    const first = tryAcquire(initialFence(), 1);
    expect(first.result).toBe("acquired");
    expect(tryAcquire(first.state, 1).result).toBe("busy");
    expect(() => clearFence()).toThrow(/forbidden/);
  });

  it("retains an uncertainty fence", () => {
    const held = tryAcquire(initialFence(), 2).state;
    const fenced = retain(held, 2, "rollback failed");
    expect(tryAcquire(release(fenced, 2), 3).result).toBe("fenced");
  });
});
