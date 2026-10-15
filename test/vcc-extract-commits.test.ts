import { describe, it, expect } from "vitest";
import { extractCommits, formatCommits } from "../vcc/extract/commits.js";
import type { NormalizedBlock } from "../vcc/normalize.js";

describe("extractCommits", () => {
  it("extracts commit from bash tool call", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: 'git commit -m "Fix login"' } },
      { kind: "tool_result", name: "bash", text: "[main abc1234] Fix login", isError: false },
    ];
    const commits = extractCommits(blocks);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("Fix login");
    expect(commits[0].hash).toBe("abc1234");
  });

  it("extracts commit without hash", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: 'git commit -m "Add search"' } },
    ];
    const commits = extractCommits(blocks);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("Add search");
    expect(commits[0].hash).toBeUndefined();
  });

  it("deduplicates by message+hash", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "bash", args: { command: 'git commit -m "Fix login"' } },
      { kind: "tool_result", name: "bash", text: "[main abc1234] Fix login", isError: false },
      { kind: "tool_call", name: "bash", args: { command: 'git commit -m "Fix login"' } },
      { kind: "tool_result", name: "bash", text: "[main abc1234] Fix login", isError: false },
    ];
    const commits = extractCommits(blocks);
    expect(commits).toHaveLength(1);
  });

  it("returns empty for no commits", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "hello" },
    ];
    expect(extractCommits(blocks)).toEqual([]);
  });
});

describe("formatCommits", () => {
  it("formats with hash prefix", () => {
    const commits = [{ hash: "abc1234", message: "Fix login" }];
    const lines = formatCommits(commits);
    expect(lines).toContain("abc1234: Fix login");
  });

  it("caps at 8 items", () => {
    const commits = Array.from({ length: 12 }, (_, i) => ({
      hash: `hash${i}`,
      message: `Commit ${i}`,
    }));
    const lines = formatCommits(commits);
    expect(lines.length).toBe(8);
  });
});
