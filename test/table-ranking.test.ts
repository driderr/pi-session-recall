// rankTablesForInjection (design §2.2, pin B/P5) — pure ranking tests: no DB, no LLM.
// Spec: session-recall "Long-Term Injection Ranks Tables by Recency-Weighted Score"
// (rank arithmetic, clamp, sort, fill, emit) + test-coverage "Table Ranking Tests".
import { describe, it, expect } from "vitest";
import { rankTablesForInjection, PINNED_SECTIONS, type ParsedScoreTables } from "../summarizer.js";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";

function parsedFrom(sections: Partial<Record<string, Array<[string, number, number]>>>): ParsedScoreTables {
  const out: Record<string, Array<{ item: string; score: number; lastSeen: number }>> = {};
  for (const name of PINNED_SECTIONS) {
    out[name] = (sections[name] ?? []).map(([item, score, lastSeen]) => ({ item, score, lastSeen }));
  }
  return { parseable: true, sections: out };
}

const CONFIG: SessionRecallConfig = { ...DEFAULT_CONFIG }; // halfLife 50, longTermMaxChars 5000

describe("rankTablesForInjection", () => {
  it("rank arithmetic at the half-life: 50 sessions old -> weight 0.5; current -> weight 1.0", () => {
    const parsed = parsedFrom({
      "Key Decisions": [
        ["fifty-old", 10, 50],
        ["fresh", 10, 100], // weight 1.0 -> rank 10
      ],
    });
    const ranked = rankTablesForInjection(parsed, 100, CONFIG);
    const rows = ranked.sections[0].rows;
    // fresh first (rank 10 > 5)
    expect(rows[0].item).toBe("fresh");
    expect(rows[0].rank).toBe(10); // weight 1.0
    expect(rows[1].item).toBe("fifty-old");
    expect(rows[1].rank).toBe(5); // 10 * (1 / (1 + 50/50)) = 10 * 0.5
  });

  it("regressed lastSeen clamps sessions_since to 0 (weight 1.0, the safe direction)", () => {
    const parsed = parsedFrom({
      "Key Decisions": [["regressed", 7, 645]],
    });
    const ranked = rankTablesForInjection(parsed, 106, CONFIG);
    expect(ranked.sections[0].rows[0].rank).toBe(7); // max(0, 106 - 645) = 0 -> weight 1.0
  });

  it("fresh score-1 row outranks a stale score-15 row (1.0 > ~0.71)", () => {
    const parsed = parsedFrom({
      "Key Decisions": [
        ["stale-high", 15, 0],
        ["fresh-low", 1, 1000],
      ],
    });
    const ranked = rankTablesForInjection(parsed, 1000, CONFIG);
    const rows = ranked.sections[0].rows;
    expect(rows[0].item).toBe("fresh-low");
    expect(rows[0].rank).toBe(1);
    expect(rows[1].item).toBe("stale-high");
    expect(rows[1].rank).toBeCloseTo(15 / 21, 10);
  });

  it("per-section sort is rank descending (spec 7.5/5.0/1.0 order) with item-asc tie-break", () => {
    // current = 100, all rows 50 sessions old -> weight exactly 0.5 (half-life 50):
    //   rank-7.5:    15 * 0.5 = 7.5
    //   rank-5.0-*:  10 * 0.5 = 5.0  (tie on rank AND score -> item asc)
    //   rank-1.0:    2  * 0.5 = 1.0
    const parsed = parsedFrom({
      "Key Decisions": [
        ["rank-1.0", 2, 50],
        ["rank-5.0-b", 10, 50],
        ["rank-7.5", 15, 50],
        ["rank-5.0-a", 10, 50],
      ],
    });
    const ranked = rankTablesForInjection(parsed, 100, CONFIG);
    const rows = ranked.sections[0].rows;
    expect(rows.map((r) => r.item)).toEqual(["rank-7.5", "rank-5.0-a", "rank-5.0-b", "rank-1.0"]);
    expect(rows.map((r) => r.rank)).toEqual([7.5, 5, 5, 1]);
  });

  it("equal-rank tie-break prefers the higher score (4 @ half-life age beats 2 @ fresh)", () => {
    const parsed = parsedFrom({
      "Key Decisions": [
        ["low-score-fresh", 2, 100],  // 2 * 1.0 = 2.0
        ["high-score-stale", 4, 50],  // 4 * 0.5 = 2.0
      ],
    });
    const ranked = rankTablesForInjection(parsed, 100, CONFIG);
    const items = ranked.sections[0].rows.map((r) => r.item);
    expect(items).toEqual(["high-score-stale", "low-score-fresh"]);
  });

  it("budget fill drops lowest-rank rows last (dropped count + remaining rows asserted)", () => {
    const parsed = parsedFrom({
      "Key Decisions": [
        ["r5", 5, 100],
        ["r4", 4, 100],
        ["r3", 3, 100],
        ["r2", 2, 100],
        ["r1", 1, 100],
      ],
    });
    // Skeleton 76 + three row lines of 17 = 127 exactly; the 4th row would need 144.
    const tiny: SessionRecallConfig = { ...CONFIG, longTermMaxChars: 127 };
    const ranked = rankTablesForInjection(parsed, 100, tiny);
    expect(ranked.sections).toHaveLength(1);
    const rows = ranked.sections[0].rows;
    expect(rows).toHaveLength(3);
    // Highest rank first; the kept set is an exact prefix of the rank order.
    expect(rows.map((r) => r.item)).toEqual(["r5", "r4", "r3"]);
    expect(rows.every((r) => r.item !== "r2" && r.item !== "r1")).toBe(true);
    expect(ranked.sections[0].dropped).toBe(2);
    expect(ranked.totalDropped).toBe(2);
    expect(ranked.markdown.length).toBeLessThanOrEqual(tiny.longTermMaxChars);
  });

  it("global cross-section fill: highest-rank row across sections is accepted first; the second section's skeleton is paid on its first accepted row", () => {
    // "Lessons Learned" (later in PINNED_SECTIONS order) holds the top-ranked rows.
    // Budget only fits one section skeleton + a few rows -> Key Decisions must lose out
    // on rank, not on prompt order.
    const parsed = parsedFrom({
      "Key Decisions": [
        ["kd-a", 3, 100],
        ["kd-b", 2, 100],
      ],
      "Lessons Learned": [
        ["ll-top", 9, 100],
        ["ll-second", 5, 100],
      ],
    });
    const skeletonLen = "## Lessons Learned\n\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n".length;
    const rowLen = (item: string, score: number, lastSeen: number) => `| ${item} | ${score} | ${lastSeen} |\n`.length;
    const config: SessionRecallConfig = { ...CONFIG, longTermMaxChars: skeletonLen + rowLen("ll-top", 9, 100) + rowLen("ll-second", 5, 100) };
    const ranked = rankTablesForInjection(parsed, 100, config);
    expect(ranked.sections.map((s) => s.name)).toEqual(["Lessons Learned"]);
    expect(ranked.sections[0].rows.map((r) => r.item)).toEqual(["ll-top", "ll-second"]);
    // Both Key Decisions rows dropped even though its section comes first in prompt order.
    expect(ranked.totalDropped).toBe(2);
    expect(ranked.markdown.length).toBeLessThanOrEqual(config.longTermMaxChars);
  });

  it("a second section is emitted only when its skeleton + first row fit the remaining budget", () => {
    const parsed = parsedFrom({
      "Key Decisions": [["kd-a", 9, 100]],
      "Lessons Learned": [["ll-a", 5, 100]],
    });
    const kdSkeleton = "## Key Decisions\n\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n".length;
    const kdRow = "| kd-a | 9 | 100 |\n".length; // 19
    // Budget fits the KD skeleton + row plus the join, but NOT the LL skeleton + row.
    const config: SessionRecallConfig = { ...CONFIG, longTermMaxChars: kdSkeleton + kdRow + 2 };
    const ranked = rankTablesForInjection(parsed, 100, config);
    expect(ranked.sections.map((s) => s.name)).toEqual(["Key Decisions"]);
    expect(ranked.totalDropped).toBe(1);
    // Same rows, budget that also fits the LL skeleton + row + join:
    const llSkeleton = "## Lessons Learned\n\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n".length;
    const llRow = "| ll-a | 5 | 100 |\n".length; // 19
    const config2: SessionRecallConfig = { ...CONFIG, longTermMaxChars: kdSkeleton + kdRow + 2 + llSkeleton + llRow };
    const ranked2 = rankTablesForInjection(parsed, 100, config2);
    expect(ranked2.sections.map((s) => s.name)).toEqual(["Key Decisions", "Lessons Learned"]);
    expect(ranked2.totalDropped).toBe(0);
    expect(ranked2.markdown.length).toBeLessThanOrEqual(config2.longTermMaxChars);
  });

  it("output is table markdown under per-section headers", () => {
    const parsed = parsedFrom({
      "Key Decisions": [["VCC merge", 4, 645]],
      "Open Issues": [["WAL lock", 2, 610]],
    });
    const ranked = rankTablesForInjection(parsed, 700, CONFIG);
    expect(ranked.markdown).toContain("## Key Decisions");
    expect(ranked.markdown).toContain("## Open Issues");
    expect(ranked.markdown).toContain("| Item | Score | Last-Seen |");
    expect(ranked.markdown).toContain("|------|-------|-----------|");
    expect(ranked.markdown).toContain("| VCC merge | 4 | 645 |");
    expect(ranked.markdown).toContain("| WAL lock | 2 | 610 |");
    // Sections render in PINNED_SECTIONS order regardless of rank order.
    expect(ranked.markdown.indexOf("## Key Decisions")).toBeLessThan(ranked.markdown.indexOf("## Open Issues"));
    // Per-section markdown is skeleton + row lines.
    expect(ranked.sections[0].markdown.startsWith("## Key Decisions\n\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n")).toBe(true);
  });

  it("zero-row input renders empty markdown (caller falls back to the raw dump)", () => {
    const ranked = rankTablesForInjection(parsedFrom({}), 100, CONFIG);
    expect(ranked.markdown).toBe("");
    expect(ranked.sections).toEqual([]);
    expect(ranked.totalDropped).toBe(0);
  });

  it("half-life 100 is respected (config-driven, not hardcoded 50)", () => {
    const parsed = parsedFrom({
      "Key Decisions": [["aged", 10, 0]],
    });
    const config: SessionRecallConfig = { ...CONFIG, recencyHalfLifeSessions: 100 };
    const ranked = rankTablesForInjection(parsed, 100, config); // 100 sessions old
    expect(ranked.sections[0].rows[0].rank).toBe(5); // 10 * 1/(1 + 100/100)
  });
});
