import { describe, it, expect } from "vitest";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../vcc/extract/preferences.js";
import type { NormalizedBlock } from "../vcc/normalize.js";

describe("extractPreferences", () => {
  it("extracts preference patterns", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "I prefer TypeScript over JavaScript" },
    ];
    const prefs = extractPreferences(blocks);
    expect(prefs.length).toBeGreaterThan(0);
  });

  it("extracts 'don't want' patterns", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "I don't want any console.log statements" },
    ];
    const prefs = extractPreferences(blocks);
    expect(prefs.length).toBeGreaterThan(0);
  });

  it("skips questions", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Can you prefer TypeScript?" },
    ];
    const prefs = extractPreferences(blocks);
    expect(prefs).toEqual([]);
  });

  it("ignores assistant messages", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "I prefer to use TypeScript" },
    ];
    const prefs = extractPreferences(blocks);
    expect(prefs).toEqual([]);
  });

  it("caps at 10 preferences", () => {
    const blocks: NormalizedBlock[] = Array.from({ length: 15 }, (_, i) => ({
      kind: "user" as const,
      text: `I prefer option ${i} for the system`,
    }));
    const prefs = extractPreferences(blocks);
    expect(prefs.length).toBeLessThanOrEqual(10);
  });
});

describe("dedupPreferencesAgainstGoals", () => {
  it("removes preferences that duplicate goals", () => {
    const prefs = ["Build the API", "Use TypeScript"];
    const goals = ["Build the API"];
    const result = dedupPreferencesAgainstGoals(prefs, goals);
    expect(result).toEqual(["Use TypeScript"]);
  });

  it("keeps preferences not in goals", () => {
    const prefs = ["Use TypeScript", "Prefer dark mode"];
    const goals = ["Build the API"];
    const result = dedupPreferencesAgainstGoals(prefs, goals);
    expect(result).toEqual(["Use TypeScript", "Prefer dark mode"]);
  });
});
