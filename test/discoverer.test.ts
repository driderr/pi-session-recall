import { describe, it, expect } from "vitest";
import {
  isSubagentSession,
  matchesIgnorePatterns,
} from "../discoverer.js";

/* ------------------------------------------------------------------ */
/*  isSubagentSession                                                  */
/* ------------------------------------------------------------------ */

describe("isSubagentSession", () => {
  it("detects subagent session with run-1", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/run-1/session.jsonl"
      )
    ).toBe(true);
  });

  it("detects subagent session with run-99", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/run-99/session.jsonl"
      )
    ).toBe(true);
  });

  it("detects subagent session with run-0", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/run-0/session.jsonl"
      )
    ).toBe(true);
  });

  it("returns false for normal session path", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/2026-06-06T08-15-34-883Z_abc123.jsonl"
      )
    ).toBe(false);
  });

  it("returns false for nested non-subagent path", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/notes/session.jsonl"
      )
    ).toBe(false);
  });

  it("returns false for path containing 'run' but not subagent pattern", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/run-something/session.jsonl"
      )
    ).toBe(false);
  });

  it("detects subagent session with Windows backslashes", () => {
    expect(
      isSubagentSession(
        "C:\\Users\\user\\.pi\\agent\\sessions\\parent\\abc123\\run-1\\session.jsonl"
      )
    ).toBe(true);
  });

  it("returns false for Windows normal session path", () => {
    expect(
      isSubagentSession(
        "C:\\Users\\user\\.pi\\agent\\sessions\\2026-06-06T08-15-34-883Z_abc123.jsonl"
      )
    ).toBe(false);
  });

  it("returns false for empty path", () => {
    expect(isSubagentSession("")).toBe(false);
  });

  it("returns false for path ending in session.jsonl without run-N prefix", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/session.jsonl"
      )
    ).toBe(false);
  });

  it("returns false for run-N without session.jsonl suffix", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/run-1/other.jsonl"
      )
    ).toBe(false);
  });
});

/*  matchesIgnorePatterns                                              */
/* ------------------------------------------------------------------ */

describe("matchesIgnorePatterns", () => {
  it("matches single wildcard * against a filename", () => {
    expect(matchesIgnorePatterns("temp.jsonl", ["*.jsonl"])).toBe(true);
  });

  it("single wildcard * matches within a path segment (substring match)", () => {
    // The regex is not anchored, so *.jsonl matches the "temp.jsonl" portion
    // of "dir/temp.jsonl" — it does NOT enforce full-path matching.
    expect(matchesIgnorePatterns("dir/temp.jsonl", ["*.jsonl"])).toBe(true);
  });

  it("double wildcard ** matches across directory boundaries", () => {
    expect(matchesIgnorePatterns("dir/sub/temp.jsonl", ["**/temp.jsonl"])).toBe(
      true
    );
  });

  it("double wildcard ** matches full path", () => {
    expect(
      matchesIgnorePatterns("a/b/c/d.jsonl", ["**/*.jsonl"])
    ).toBe(true);
  });

  it("literal match works", () => {
    expect(
      matchesIgnorePatterns("/home/user/.pi/agent/sessions/ignore-me.jsonl", [
        "/home/user/.pi/agent/sessions/ignore-me.jsonl",
      ])
    ).toBe(true);
  });

  it("literal match is case sensitive", () => {
    expect(
      matchesIgnorePatterns("/home/user/FILE.jsonl", ["/home/user/file.jsonl"])
    ).toBe(false);
  });

  it("returns false when no pattern matches", () => {
    expect(
      matchesIgnorePatterns("/home/user/session.jsonl", ["*.lock"])
    ).toBe(false);
  });

  it("returns true if any of multiple patterns matches", () => {
    expect(
      matchesIgnorePatterns("/home/user/session.jsonl", [
        "*.lock",
        "*.jsonl",
      ])
    ).toBe(true);
  });

  it("returns false if none of multiple patterns match", () => {
    expect(
      matchesIgnorePatterns("/home/user/session.txt", [
        "*.lock",
        "*.jsonl",
        "*.sqlite",
      ])
    ).toBe(false);
  });

  it("returns false for empty patterns array", () => {
    expect(matchesIgnorePatterns("/home/user/session.jsonl", [])).toBe(false);
  });

  it("handles empty path with non-empty patterns", () => {
    expect(matchesIgnorePatterns("", ["*.jsonl"])).toBe(false);
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    expect(
      matchesIgnorePatterns("C:\\Users\\temp.jsonl", ["**/temp.jsonl"])
    ).toBe(true);
  });

  it("matches glob with directory prefix", () => {
    expect(
      matchesIgnorePatterns("/home/user/.pi/agent/sessions/2026-06-06T08-15-34.jsonl", [
        "**/sessions/**",
      ])
    ).toBe(true);
  });

  it("does not match when glob pattern is too specific", () => {
    expect(
      matchesIgnorePatterns("/home/user/sessions/2026-06-06T08-15-34.jsonl", [
        "**/data/**",
      ])
    ).toBe(false);
  });

  it("handles special regex characters in literal patterns", () => {
    // The function escapes regex special chars before matching
    expect(
      matchesIgnorePatterns("/home/user/file(1).jsonl", [
        "/home/user/file(1).jsonl",
      ])
    ).toBe(true);
  });

  it("handles special regex characters that should not match", () => {
    expect(
      matchesIgnorePatterns("/home/user/file(2).jsonl", [
        "/home/user/file(1).jsonl",
      ])
    ).toBe(false);
  });

  it("matches wildcard at end of path segment", () => {
    expect(
      matchesIgnorePatterns("/home/user/.pi/agent/sessions/abc123.jsonl", [
        "**/agent/sessions/*",
      ])
    ).toBe(true);
  });
});
