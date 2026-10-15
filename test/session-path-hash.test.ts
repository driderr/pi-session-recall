import { describe, it, expect } from "vitest";
import { sessionPathHash } from "../summarizer.js";

describe("sessionPathHash", () => {
  it("output is deterministic", () => {
    const path = "/home/user/.pi/agent/sessions/session.jsonl";
    expect(sessionPathHash(path)).toBe(sessionPathHash(path));
  });

  it("output is 32 hex characters", () => {
    const hash = sessionPathHash("/some/session/path.jsonl");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("Windows paths with backslashes work", () => {
    const hash = sessionPathHash("C:\\Users\\User\\.pi\\agent\\sessions\\session.jsonl");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("empty string input produces valid hash", () => {
    const hash = sessionPathHash("");
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toBe("d41d8cd98f00b204e9800998ecf8427e"); // MD5 of empty string
  });

  it("different paths produce different hashes", () => {
    const hash1 = sessionPathHash("/path/to/session1.jsonl");
    const hash2 = sessionPathHash("/path/to/session2.jsonl");
    expect(hash1).not.toBe(hash2);
  });
});
