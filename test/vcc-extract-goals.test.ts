import { describe, it, expect } from "vitest";
import { extractGoals } from "../vcc/extract/goals.js";
import type { NormalizedBlock } from "../vcc/normalize.js";

describe("extractGoals", () => {
  it("extracts goals from user messages", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "I want to build a REST API for the project" },
    ];
    const goals = extractGoals(blocks);
    expect(goals.length).toBeGreaterThan(0);
  });

  it("detects scope changes", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Build the API" },
      { kind: "user", text: "Actually, instead let's focus on the database first" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toContain("[Scope change]");
  });

  it("caps at 8 goals", () => {
    const blocks: NormalizedBlock[] = Array.from({ length: 15 }, (_, i) => ({
      kind: "user" as const,
      text: `Task ${i}: do something important number ${i}`,
    }));
    const goals = extractGoals(blocks);
    expect(goals.length).toBeLessThanOrEqual(8);
  });

  it("returns empty for non-goal messages", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "ok" },
      { kind: "assistant", text: "Done" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toEqual([]);
  });

  it("filters out code and paths", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "const x = 42; function foo() {}" },
      { kind: "user", text: "https://example.com/docs" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toEqual([]);
  });
});
