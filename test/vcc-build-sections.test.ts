import { describe, it, expect } from "vitest";
import { buildSections } from "../vcc/build-sections.js";
import type { NormalizedBlock } from "../vcc/normalize.js";

describe("buildSections", () => {
  it("produces all sections from a turn", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "I want to build a REST API for the project" },
      { kind: "assistant", text: "I'll implement the API endpoint" },
      { kind: "tool_call", name: "Write", args: { path: "src/api.ts" } },
      { kind: "tool_result", name: "Write", text: "OK", isError: false },
    ];
    const sections = buildSections(blocks);
    expect(sections.goals.length).toBeGreaterThan(0);
    expect(sections.briefTranscript.length).toBeGreaterThan(0);
  });

  it("returns empty sections for empty input", () => {
    const sections = buildSections([]);
    expect(sections.goals).toEqual([]);
    expect(sections.files).toEqual([]);
    expect(sections.commits).toEqual([]);
    expect(sections.references).toEqual([]);
    expect(sections.signals).toEqual([]);
    expect(sections.outstandingContext).toEqual([]);
    expect(sections.preferences).toEqual([]);
    expect(sections.briefTranscript).toBe("");
  });

  it("extracts file activity", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { path: "src/api.ts" } },
      { kind: "tool_call", name: "Edit", args: { path: "src/db.ts" } },
    ];
    const sections = buildSections(blocks);
    expect(sections.files.length).toBeGreaterThan(0);
  });

  it("extracts outstanding context from errors", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "bash", text: "Error: connection refused", isError: true },
    ];
    const sections = buildSections(blocks);
    expect(sections.outstandingContext.length).toBeGreaterThan(0);
  });
});
