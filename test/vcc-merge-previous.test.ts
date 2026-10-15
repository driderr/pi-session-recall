import { describe, it, expect } from "vitest";
import { mergePrevious } from "../vcc/merge-previous.js";

describe("mergePrevious", () => {
  it("identity merge — empty existing returns fresh", () => {
    const fresh = "[Session Goal]\n- Build API";
    const result = mergePrevious("", fresh);
    expect(result).toBe(fresh);
  });

  it("identity merge — empty fresh returns existing", () => {
    const existing = "[Session Goal]\n- Build API";
    const result = mergePrevious(existing, "");
    expect(result).toBe(existing);
  });

  it("deduplicates goals", () => {
    const existing = "[Session Goal]\n- Build API";
    const fresh = "[Session Goal]\n- Build API";
    const result = mergePrevious(existing, fresh);
    const goalMatches = result.match(/- Build API/g);
    expect(goalMatches).toHaveLength(1);
  });

  it("appends new goals", () => {
    const existing = "[Session Goal]\n- Build API";
    const fresh = "[Session Goal]\n- Add auth";
    const result = mergePrevious(existing, fresh);
    expect(result).toContain("- Build API");
    expect(result).toContain("- Add auth");
  });

  it("caps goals at 8", () => {
    const existing = "[Session Goal]\n" + Array.from({ length: 7 }, (_, i) => `- Goal ${i}`).join("\n");
    const fresh = "[Session Goal]\n" + Array.from({ length: 3 }, (_, i) => `- New goal ${i}`).join("\n");
    const result = mergePrevious(existing, fresh);
    const goalLines = result.split("\n").filter(l => l.startsWith("- "));
    expect(goalLines.length).toBeLessThanOrEqual(8);
  });

  it("deduplicates commits", () => {
    const existing = "[Commits]\n- abc1234: Fix login";
    const fresh = "[Commits]\n- abc1234: Fix login\n- def5678: Add search";
    const result = mergePrevious(existing, fresh);
    const commitMatches = result.match(/- abc1234: Fix login/g);
    expect(commitMatches).toHaveLength(1);
    expect(result).toContain("- def5678: Add search");
  });

  it("caps commits at 8", () => {
    const existing = "[Commits]\n" + Array.from({ length: 8 }, (_, i) => `- hash${i}: Commit ${i}`).join("\n");
    const fresh = "[Commits]\n" + Array.from({ length: 2 }, (_, i) => `- new${i}: New ${i}`).join("\n");
    const result = mergePrevious(existing, fresh);
    const commitLines = result.split("\n").filter(l => l.startsWith("- "));
    expect(commitLines.length).toBeLessThanOrEqual(8);
  });

  it("deduplicates references", () => {
    const existing = "[References]\n- URL: https://example.com";
    const fresh = "[References]\n- URL: https://example.com\n- URL: https://new.com";
    const result = mergePrevious(existing, fresh);
    const urlMatches = result.match(/https:\/\/example\.com/g);
    expect(urlMatches).toHaveLength(1);
  });

  it("deduplicates signals", () => {
    const existing = "[Key Signals]\n- Decision: use VCC";
    const fresh = "[Key Signals]\n- Decision: use VCC\n- Decision: use SQLite";
    const result = mergePrevious(existing, fresh);
    const signalMatches = result.match(/- Decision: use VCC/g);
    expect(signalMatches).toHaveLength(1);
    expect(result).toContain("- Decision: use SQLite");
  });

  it("caps signals at 15", () => {
    const existing = "[Key Signals]\n" + Array.from({ length: 15 }, (_, i) => `- Signal ${i}`).join("\n");
    const fresh = "[Key Signals]\n" + Array.from({ length: 5 }, (_, i) => `- New signal ${i}`).join("\n");
    const result = mergePrevious(existing, fresh);
    const signalLines = result.split("\n").filter(l => l.startsWith("- "));
    expect(signalLines.length).toBeLessThanOrEqual(15);
  });

  it("outstanding context is volatile — always replaced", () => {
    const existing = "[Outstanding Context]\n- Waiting for API key";
    const fresh = "[Outstanding Context]\n- Need database credentials";
    const result = mergePrevious(existing, fresh);
    expect(result).not.toContain("Waiting for API key");
    expect(result).toContain("Need database credentials");
  });

  it("outstanding context removed when fresh is empty", () => {
    const existing = "[Outstanding Context]\n- Waiting for API key";
    const fresh = "[Session Goal]\n- Build API";
    const result = mergePrevious(existing, fresh);
    expect(result).not.toContain("[Outstanding Context]");
  });

  it("deduplicates preferences", () => {
    const existing = "[User Preferences]\n- Prefer TypeScript";
    const fresh = "[User Preferences]\n- Prefer TypeScript\n- Prefer dark mode";
    const result = mergePrevious(existing, fresh);
    const prefMatches = result.match(/- Prefer TypeScript/g);
    expect(prefMatches).toHaveLength(1);
    expect(result).toContain("- Prefer dark mode");
  });

  it("caps preferences at 10", () => {
    const existing = "[User Preferences]\n" + Array.from({ length: 10 }, (_, i) => `- Pref ${i}`).join("\n");
    const fresh = "[User Preferences]\n" + Array.from({ length: 3 }, (_, i) => `- New pref ${i}`).join("\n");
    const result = mergePrevious(existing, fresh);
    const prefLines = result.split("\n").filter(l => l.startsWith("- "));
    expect(prefLines.length).toBeLessThanOrEqual(10);
  });

  it("appends brief transcript within cap", () => {
    const existing = "[Session Goal]\n- Build API\n\n---\n\n[user] hello";
    const fresh = "[Session Goal]\n- Build API\n\n---\n\n[user] world";
    const result = mergePrevious(existing, fresh, { briefTranscriptCap: 120 });
    expect(result).toContain("[user] hello");
    expect(result).toContain("[user] world");
  });

  it("caps brief transcript at 120 lines (tail-biased)", () => {
    const existingBrief = Array.from({ length: 115 }, (_, i) => `[user] line ${i}`).join("\n");
    const freshBrief = Array.from({ length: 20 }, (_, i) => `[user] new ${i}`).join("\n");
    const existing = `[Session Goal]\n- Build API\n\n---\n\n${existingBrief}`;
    const fresh = `[Session Goal]\n- Build API\n\n---\n\n${freshBrief}`;
    const result = mergePrevious(existing, fresh, { briefTranscriptCap: 120 });
    // Should contain the "omitted" marker since total > 120
    expect(result).toContain("earlier lines omitted");
    // Should contain the tail (most recent) lines
    expect(result).toContain("[user] new 19");
  });

  it("merges files by category", () => {
    const existing = "[Files And Changes]\n- Modified: src/api.ts\n- Read: src/db.ts";
    const fresh = "[Files And Changes]\n- Modified: src/auth.ts\n- Read: src/api.ts";
    const result = mergePrevious(existing, fresh);
    expect(result).toContain("src/api.ts");
    expect(result).toContain("src/auth.ts");
    expect(result).toContain("src/db.ts");
  });

  // ── Edge cases for sectionOf() ──────────────────────────────────

  it("returns empty for summary with no section headers", () => {
    const existing = "This is a plain text summary with no headers at all.";
    const fresh = "[Session Goal]\n- Build API";
    const result = mergePrevious(existing, fresh);
    // Existing has no sections, so fresh wins
    expect(result).toContain("[Session Goal]");
    expect(result).toContain("- Build API");
  });

  it("handles malformed header (no closing bracket)", () => {
    const existing = "[Session Goal\n- Build API"; // Missing closing ]
    const fresh = "[Session Goal]\n- Add auth";
    const result = mergePrevious(existing, fresh);
    // Malformed header in existing won't be matched, so fresh wins
    expect(result).toContain("[Session Goal]");
    expect(result).toContain("- Add auth");
    // The malformed text (missing closing bracket) should not appear
    expect(result).not.toContain("[Session Goal\n- Build API");
  });

  it("ignores header-like text in brief transcript", () => {
    const existing = "[Session Goal]\n- Build API\n\n---\n\nUser asked: what about [Session Goal] changes?";
    const fresh = "[Session Goal]\n- Add auth";
    const result = mergePrevious(existing, fresh);
    // The header-like text in brief transcript should not confuse sectionOf
    expect(result).toContain("- Build API");
    expect(result).toContain("- Add auth");
  });

  it("returns first occurrence for duplicate headers", () => {
    const existing = "[Session Goal]\n- First goal\n[Session Goal]\n- Duplicate goal";
    const fresh = "[Session Goal]\n- Fresh goal";
    const result = mergePrevious(existing, fresh);
    // sectionOf should extract from first [Session Goal], which includes the duplicate
    // The merge should handle it gracefully
    expect(result).toContain("[Session Goal]");
  });

  it("handles summary with only brief transcript (no headers)", () => {
    const existing = "\n\n---\n\n[user] just some chat";
    const fresh = "[Session Goal]\n- Build API";
    const result = mergePrevious(existing, fresh);
    expect(result).toContain("[Session Goal]");
    expect(result).toContain("- Build API");
  });

  it("handles empty brief transcript gracefully", () => {
    const existing = "[Session Goal]\n- Build API\n\n---\n\n";
    const fresh = "[Session Goal]\n- Add auth";
    const result = mergePrevious(existing, fresh);
    expect(result).toContain("[Session Goal]");
  });

  // ── End edge cases ──────────────────────────────────────────────

  it("multi-section merge works end-to-end", () => {
    const existing = [
      "[Session Goal]\n- Build API",
      "[Commits]\n- abc1234: Fix login",
      "[Key Signals]\n- Decision: use VCC",
      "[Outstanding Context]\n- Waiting for API key",
      "[User Preferences]\n- Prefer TypeScript",
      "[References]\n- URL: https://example.com",
    ].join("\n\n");

    const fresh = [
      "[Session Goal]\n- Add auth",
      "[Commits]\n- def5678: Add search",
      "[Key Signals]\n- Decision: use SQLite",
      "[Outstanding Context]\n- Need DB credentials",
      "[User Preferences]\n- Prefer dark mode",
      "[References]\n- URL: https://new.com",
    ].join("\n\n");

    const result = mergePrevious(existing, fresh);
    expect(result).toContain("Build API");
    expect(result).toContain("Add auth");
    expect(result).toContain("abc1234");
    expect(result).toContain("def5678");
    expect(result).toContain("use VCC");
    expect(result).toContain("use SQLite");
    expect(result).not.toContain("Waiting for API key"); // volatile
    expect(result).toContain("Need DB credentials");
  });
});
