import { describe, expect, it } from "vitest";
import { parseFinalResponse, parseMuseSessionId } from "./muse-exec.js";

describe("parseMuseSessionId", () => {
  it("finds snake_case session ids in a --json event stream", () => {
    const jsonl = [
      '{"type":"run.started"}',
      "not json noise",
      '{"type":"turn.completed","session_id":"01a098c5-88b9-7341-b7e0-410c14986900"}',
    ].join("\n");
    expect(parseMuseSessionId(jsonl)).toBe("01a098c5-88b9-7341-b7e0-410c14986900");
  });

  it("accepts camelCase and thread variants", () => {
    expect(parseMuseSessionId('{"sessionId":"abc-123"}')).toBe("abc-123");
    expect(parseMuseSessionId('{"thread_id":"thr-1"}')).toBe("thr-1");
  });

  it("returns null when absent", () => {
    expect(parseMuseSessionId('{"type":"turn.completed"}')).toBeNull();
    expect(parseMuseSessionId("")).toBeNull();
  });
});

describe("parseFinalResponse", () => {
  it("returns the last non-empty text hit", () => {
    const jsonl = [
      '{"type":"item","text":"first"}',
      '{"type":"item","text":"  "}',
      '{"type":"done","final_response":"second"}',
    ].join("\n");
    expect(parseFinalResponse(jsonl)).toBe("second");
  });

  it("returns undefined when nothing text-bearing exists", () => {
    expect(parseFinalResponse('{"type":"turn.completed"}')).toBeUndefined();
  });
});
