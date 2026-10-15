import { describe, it, expect } from "vitest";
import { formatSummary, capBrief } from "../vcc/format.js";
import type { VccSections } from "../vcc/build-sections.js";

describe("formatSummary", () => {
  it("formats multi-section summary", () => {
    const sections: VccSections = {
      goals: ["Build API", "Add auth"],
      files: ["Modified: src/api.ts"],
      commits: [],
      references: [],
      signals: ["Decision: use TypeScript"],
      outstandingContext: [],
      preferences: [],
      briefTranscript: "",
    };
    const summary = formatSummary(sections);
    expect(summary).toContain("[Session Goal]");
    expect(summary).toContain("- Build API");
    expect(summary).toContain("[Files And Changes]");
    expect(summary).toContain("[Key Signals]");
    expect(summary).not.toContain("[Commits]"); // empty sections omitted
  });

  it("returns empty string for empty sections", () => {
    const sections: VccSections = {
      goals: [], files: [], commits: [], references: [],
      signals: [], outstandingContext: [], preferences: [],
      briefTranscript: "",
    };
    expect(formatSummary(sections)).toBe("");
  });

  it("includes brief transcript separated by ---", () => {
    const sections: VccSections = {
      goals: ["Build API"],
      files: [], commits: [], references: [],
      signals: [], outstandingContext: [], preferences: [],
      briefTranscript: "[user] fix the build",
    };
    const summary = formatSummary(sections);
    expect(summary).toContain("\n\n---\n\n");
    expect(summary).toContain("[user] fix the build");
  });
});

describe("capBrief", () => {
  it("returns text unchanged when within limit", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    expect(capBrief(lines, 120)).toBe(lines);
  });

  it("truncates to cap with tail bias", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const capped = capBrief(lines, 120);
    const cappedLines = capped.split("\n");
    // Should include the "omitted" marker
    expect(cappedLines.some(l => l.includes("earlier lines omitted"))).toBe(true);
  });
});
