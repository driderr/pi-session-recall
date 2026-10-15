// parseScoreTables + parseScoreSuffix (design §2.1) — pure parse tests: no DB, no LLM.
// Spec: test-coverage "Score-Table Parse Tests" (all 5 scenarios) + triangulation.
import { describe, it, expect } from "vitest";
import { parseScoreTables, parseScoreSuffix, PINNED_SECTIONS } from "../summarizer.js";

const TABLE_HEADER = "| Item | Score | Last-Seen |";
const TABLE_SEP = "|------|-------|-----------|";

function section(name: string, rows: string[]): string {
  return `## ${name}\n${TABLE_HEADER}\n${TABLE_SEP}\n` + rows.join("\n");
}

const DEFAULT_ROWS: Record<string, string[]> = {
  "Key Decisions": ["| VCC merge | 4 | 645 |"],
  "Patterns & Conventions": ["| Table-driven tests | 2 | 640 |"],
  "Configuration": ["| longTermMaxChars: 5000 | 1 | 600 |"],
  "Lessons Learned": ["| WAL checkpoint before backup | 3 | 620 |"],
  "Open Issues": ["| SQLITE_BUSY on mark | 2 | 610 |"],
};

/** Full 5-section table summary; `over` replaces the row list for named sections. */
function fullTables(over: Record<string, string[]> = {}): string {
  return PINNED_SECTIONS.map((s) => section(s, over[s] ?? DEFAULT_ROWS[s])).join("\n\n");
}

describe("parseScoreTables", () => {
  it("5 pinned sections with valid rows parse to per-section rows (item/score/lastSeen)", () => {
    const parsed = parseScoreTables(fullTables());
    expect(parsed.parseable).toBe(true);
    expect(parsed.sections["Key Decisions"]).toEqual([
      { item: "VCC merge", score: 4, lastSeen: 645 },
    ]);
    expect(parsed.sections["Patterns & Conventions"]).toEqual([
      { item: "Table-driven tests", score: 2, lastSeen: 640 },
    ]);
    expect(parsed.sections["Configuration"]).toEqual([
      { item: "longTermMaxChars: 5000", score: 1, lastSeen: 600 },
    ]);
    expect(parsed.sections["Lessons Learned"]).toEqual([
      { item: "WAL checkpoint before backup", score: 3, lastSeen: 620 },
    ]);
    expect(parsed.sections["Open Issues"]).toEqual([
      { item: "SQLITE_BUSY on mark", score: 2, lastSeen: 610 },
    ]);
  });

  it("sections record always has all 5 pinned keys (empty arrays for absent sections)", () => {
    const parsed = parseScoreTables("");
    expect(Object.keys(parsed.sections).sort()).toEqual([...PINNED_SECTIONS].sort());
    for (const name of PINNED_SECTIONS) {
      expect(parsed.sections[name]).toEqual([]);
    }
  });

  it("malformed 1-cell and 2-cell rows are handled without throwing", () => {
    const parsed = parseScoreTables(
      fullTables({
        "Key Decisions": [
          "| only-item |",
          "| two-cell | 5 |",
          "|  | 9 | 9 |",
          "| (none) | | |",
        ],
      }),
    );
    // 1-cell row: kept, no score cell -> no suffix -> 1, lastSeen 0.
    // 2-cell row: kept, Score cell 5 parsed, no Last-Seen cell -> 0.
    // Empty first cell and the (none) placeholder: dropped.
    expect(parsed.sections["Key Decisions"]).toEqual([
      { item: "only-item", score: 1, lastSeen: 0 },
      { item: "two-cell", score: 5, lastSeen: 0 },
    ]);
  });

  it("legacy (score: N) and (N:x) score suffixes parse when the Score cell is not an integer", () => {
    const parsed = parseScoreTables(
      fullTables({
        "Key Decisions": [
          "| VCC merge (score: 4) |  |  |",
          "| legacy fold (4:2) |  |  |",
          "| no suffix at all |  |  |",
        ],
      }),
    );
    expect(parsed.sections["Key Decisions"]).toEqual([
      { item: "VCC merge", score: 4, lastSeen: 0 },
      { item: "legacy fold", score: 4, lastSeen: 0 },
      { item: "no suffix at all", score: 1, lastSeen: 0 },
    ]);
  });

  it("(none) placeholder is a present section with no items; parseable stays true", () => {
    const parsed = parseScoreTables(
      fullTables({ "Open Issues": ["| (none) | | |"] }),
    );
    expect(parsed.parseable).toBe(true);
    expect(parsed.sections["Open Issues"]).toEqual([]);
  });

  it("zero-tables prose signals fallback (parseable false)", () => {
    const parsed = parseScoreTables(
      "Just some prose about decisions and patterns,\nwith no table headers at all.",
    );
    expect(parsed.parseable).toBe(false);
  });

  it("1 of 5 sections missing its header makes parseable false (all-5 predicate)", () => {
    const text = [
      ...PINNED_SECTIONS.filter((s) => s !== "Configuration").map((s) => section(s, DEFAULT_ROWS[s])),
    ].join("\n\n");
    expect(parseScoreTables(text).parseable).toBe(false);
  });

  it("section present but missing its table header makes parseable false", () => {
    const text = fullTables().replace(
      "## Lessons Learned\n" + TABLE_HEADER + "\n",
      "## Lessons Learned\n",
    );
    expect(parseScoreTables(text).parseable).toBe(false);
  });

  // ─── Triangulation ──────────────────────────────────────────────────────

  it("|---| separator rows are skipped (both exact and spaced variants)", () => {
    const parsed = parseScoreTables(
      fullTables({
        "Key Decisions": ["|------|-------|-----------|", "| a | 1 | 2 |", "| --- | --- | --- |", "| b | 2 | 3 |"],
      }),
    );
    expect(parsed.sections["Key Decisions"]).toEqual([
      { item: "a", score: 1, lastSeen: 2 },
      { item: "b", score: 2, lastSeen: 3 },
    ]);
  });

  it("\\| escaping round-trips in item text", () => {
    const parsed = parseScoreTables(
      fullTables({ "Key Decisions": ["| a \\| b | 3 | 10 |"] }),
    );
    expect(parsed.sections["Key Decisions"]).toEqual([{ item: "a | b", score: 3, lastSeen: 10 }]);
  });

  it("6th/unknown sections are ignored (only the 5 pinned keys exist)", () => {
    const text = fullTables() + "\n\n## Totally Unknown\n| whatever | 1 | 1 |\n\n## Also Unknown\n| Item | Score | Last-Seen |\n| x | 1 | 1 |";
    const parsed = parseScoreTables(text);
    expect(parsed.parseable).toBe(true);
    expect(Object.keys(parsed.sections).sort()).toEqual([...PINNED_SECTIONS].sort());
  });

  it("content before the first ## line is ignored", () => {
    const text = "Preamble prose that mentions nothing structured.\n\n" + fullTables();
    const parsed = parseScoreTables(text);
    expect(parsed.parseable).toBe(true);
    expect(parsed.sections["Key Decisions"]).toEqual([{ item: "VCC merge", score: 4, lastSeen: 645 }]);
  });

  it("trailing whitespace on a section header is tolerated", () => {
    const text = fullTables().replace("## Key Decisions\n", "## Key Decisions   \n");
    expect(parseScoreTables(text).parseable).toBe(true);
  });

  it("rows outside any table (before the header line) are not parsed", () => {
    const parsed = parseScoreTables(
      fullTables({ "Key Decisions": [] }).replace(
        "## Key Decisions\n" + TABLE_HEADER,
        "## Key Decisions\n| stray | 9 | 9 |\n" + TABLE_HEADER,
      ),
    );
    expect(parsed.sections["Key Decisions"]).toEqual([]);
  });
});

describe("parseScoreSuffix", () => {
  it("modern (score: N) suffix is stripped and the score returned", () => {
    expect(parseScoreSuffix("VCC merge (score: 4)")).toEqual({ text: "VCC merge", score: 4 });
    expect(parseScoreSuffix("item (score: 12)")).toEqual({ text: "item", score: 12 });
  });

  it("legacy (N:x) suffix strips to the first number", () => {
    expect(parseScoreSuffix("legacy item (4:2)")).toEqual({ text: "legacy item", score: 4 });
    expect(parseScoreSuffix("other (10:99)")).toEqual({ text: "other", score: 10 });
  });

  it("no suffix returns the text unchanged with score null", () => {
    expect(parseScoreSuffix("plain item")).toEqual({ text: "plain item", score: null });
    expect(parseScoreSuffix("")).toEqual({ text: "", score: null });
  });

  it("suffix only counts at the end of the text", () => {
    expect(parseScoreSuffix("(score: 4) mid text")).toEqual({ text: "(score: 4) mid text", score: null });
  });
});
