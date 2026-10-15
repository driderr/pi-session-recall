// extractSignalTable + sessionSourceToken (design §2.4, pins A/P4/P8, C1, D3) —
// pure extraction tests: no DB, no LLM.
// Spec: session-recall "Short-Term Injection Emits Compact Signal Table"
// (all 7 scenarios) + test-coverage "Signal Table Extraction Tests".
import { describe, it, expect } from "vitest";
import { extractSignalTable, sessionSourceToken, sessionPathHash } from "../summarizer.js";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";

const CONFIG: SessionRecallConfig = { ...DEFAULT_CONFIG }; // maxTokens 500 -> stBudget 2000

/** VCC-shaped unmerged content: [Session Goal] then [Key Signals] (byte-identical convention). */
function vcc(signals: string[] = [], goals: string[] = [], extra?: string): string {
  const parts: string[] = [];
  if (goals.length > 0) parts.push("[Session Goal]\n" + goals.map((g) => `- ${g}`).join("\n"));
  if (signals.length > 0) parts.push("[Key Signals]\n" + signals.map((s) => `- ${s}`).join("\n"));
  if (extra) parts.push(extra);
  return parts.join("\n\n");
}

const OLD_PATH = "/pi/agent/sessions/2026-08-20T05-38-26-803Z_01a03246-f773-7c64-9e31-1a6d56d480a6.jsonl";
const NEW_PATH = "/pi/agent/sessions/2026-08-24T05-38-26-803Z_01b03246-f773-7c64-9e31-1a6d56d480a7.jsonl";

describe("sessionSourceToken (pin A)", () => {
  it("timestamp basename -> MM-DDTHH:MM:SS (16 chars)", () => {
    expect(sessionSourceToken(NEW_PATH)).toBe("08-24T05:38:26");
    expect(sessionSourceToken(OLD_PATH)).toBe("08-20T05:38:26");
  });

  it("non-timestamp basename -> 8-char sessionPathHash prefix", () => {
    const subagent = "/pi/agent/sessions/abc123/run-3/session.jsonl";
    const token = sessionSourceToken(subagent);
    expect(token).toBe(sessionPathHash(subagent).slice(0, 8));
    expect(token).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("extractSignalTable", () => {
  it("only Constraint:/Decision:/Status: prefixes are parsed (Pattern: and non-bullets ignored)", () => {
    const content = vcc(
      [
        "Constraint: maxTokens stays 500",
        "Decision: use VCC for short-term memory",
        "Status: merge flow verified",
        "Pattern: avoid globalThis for config",
        "not a bullet line at all",
      ],
      ["Build the signal table"],
    );
    const result = extractSignalTable(
      [{ sessionPath: NEW_PATH, content }],
      CONFIG,
    );
    expect(result.rows.map((r) => r.signal)).toEqual([
      "maxTokens stays 500",
      "use VCC for short-term memory",
      "merge flow verified",
    ]);
  });

  it("prefix is stripped from the emitted signal text", () => {
    const result = extractSignalTable(
      [{ sessionPath: NEW_PATH, content: vcc(["Decision: use VCC for short-term memory"], []) }],
      CONFIG,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].signal).toBe("use VCC for short-term memory");
  });

  it("cross-session dedup keeps one copy with the NEWER session's source token", () => {
    const result = extractSignalTable(
      [
        { sessionPath: OLD_PATH, content: vcc(["Decision: use VCC for short-term memory"], []) },
        { sessionPath: NEW_PATH, content: vcc(["Decision: use VCC for short-term memory"], []) },
      ],
      CONFIG,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].source).toBe("08-24T05:38:26");
    expect(result.rows[0].sessionPath).toBe(NEW_PATH);
    expect(result.dropped).toBe(0);
  });

  it("N-session (5) 2K budget filled newest-first; a 9K-content session no longer starves the others", () => {
    // Oldest session carries a ~9.4K content blob (bulk in the ignored [Files And Changes]
    // section) with only 2 short signals — its table cost is the 2 rows, not 9K.
    const big = "[Files And Changes]\n" + "- big file edit line\n".repeat(450); // ~9.5K — comfortably > 9000
    const mid = (prefix: string) =>
      vcc([1, 2, 3].map((i) => `Decision: ${prefix} decision ${i} ` + "x".repeat(160)), []);
    const inputs = [
      { sessionPath: OLD_PATH, content: vcc(["Decision: oldest decision", "Status: oldest status"], ["Oldest goal"], big) },
      { sessionPath: "/pi/agent/sessions/2026-08-21T05-38-26-803Z_01c03246-f773-7c64-9e31-1a6d56d480a8.jsonl", content: mid("second") },
      { sessionPath: "/pi/agent/sessions/2026-08-22T05-38-26-803Z_01d03246-f773-7c64-9e31-1a6d56d480a9.jsonl", content: mid("third") },
      { sessionPath: "/pi/agent/sessions/2026-08-23T05-38-26-803Z_01e03246-f773-7c64-9e31-1a6d56d480aa.jsonl", content: mid("fourth") },
      { sessionPath: NEW_PATH, content: mid("newest") },
    ];
    expect(inputs[0].content.length).toBeGreaterThan(9000);
    const result = extractSignalTable(inputs, CONFIG);
    expect(result.markdown.length).toBeLessThanOrEqual(2000);
    // Newest rows present; the oldest session's rows are the ones dropped.
    expect(result.markdown).toContain("newest decision");
    expect(result.markdown).not.toContain("oldest decision");
    expect(result.markdown).not.toContain("oldest status");
    expect(result.dropped).toBeGreaterThanOrEqual(2);
    // Rows render newest-first.
    const signals = result.rows.map((r) => r.signal);
    expect(signals[0]).toContain("newest decision");
  });

  it("zero-signal session contributes its [Session Goal] lines (D3 — not raw VCC, not skipped)", () => {
    const result = extractSignalTable(
      [{ sessionPath: NEW_PATH, content: vcc([], ["Fix the WAL checkpoint", "Add the drain gate"]) }],
      CONFIG,
    );
    expect(result.rows.map((r) => r.signal)).toEqual([
      "Fix the WAL checkpoint",
      "Add the drain gate",
    ]);
  });

  it("all sessions zero signals: goal lines used, newest-first under the 2K budget", () => {
    const result = extractSignalTable(
      [
        { sessionPath: OLD_PATH, content: vcc([], ["Old goal"]) },
        { sessionPath: NEW_PATH, content: vcc([], ["New goal"]) },
      ],
      CONFIG,
    );
    expect(result.rows.map((r) => r.signal)).toEqual(["New goal", "Old goal"]);
    expect(result.markdown.length).toBeLessThanOrEqual(2000);
  });

  it("table format: ### Recent Signals header + | Signal | Source | with short tokens (no paths/basenames)", () => {
    const result = extractSignalTable(
      [{ sessionPath: NEW_PATH, content: vcc(["Decision: something"], []) }],
      CONFIG,
    );
    expect(result.markdown.startsWith("### Recent Signals (not yet merged)\n\n| Signal | Source |\n|--------|--------|\n")).toBe(true);
    expect(result.markdown).toContain("| something | 08-24T05:38:26 |\n");
    for (const row of result.rows) {
      expect(row.source.length).toBeLessThanOrEqual(16);
    }
    expect(result.markdown).not.toContain(".jsonl");
  });

  it("two distinct paths sharing a timestamp token both switch to their 8-char MD5 prefix", () => {
    const p1 = "/pi/agent/sessions/2026-08-24T05-38-26-803Z_01a03246.jsonl";
    const p2 = "/other/parent/2026-08-24T05-38-26-803Z_01b03246.jsonl";
    const result = extractSignalTable(
      [
        { sessionPath: p1, content: vcc(["Decision: first"], []) },
        { sessionPath: p2, content: vcc(["Decision: second"], []) },
      ],
      CONFIG,
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].source).toBe(sessionPathHash(p2).slice(0, 8));
    expect(result.rows[1].source).toBe(sessionPathHash(p1).slice(0, 8));
    for (const row of result.rows) expect(row.source).toMatch(/^[0-9a-f]{8}$/);
  });

  // ─── Triangulation ──────────────────────────────────────────────────────

  it("| in signal text is escaped and the escape counts toward the budget", () => {
    // stBudget 240 (maxTokens 60). Header is exactly 77 chars; the escaped row line
    // is 34 chars (the \\| escape counts a char) -> 111 total. The 2nd row (162) would
    // need 273, so it is dropped — the escape-inclusive length is what fits.
    const config: SessionRecallConfig = { ...CONFIG, maxTokens: 60 };
    const result = extractSignalTable(
      [
        { sessionPath: NEW_PATH, content: vcc(["Status: a | b check", "Decision: " + "y".repeat(140)], []) },
      ],
      config,
    );
    expect(result.markdown).toContain("a \\| b check");
    expect(result.markdown.length).toBe(111); // header 77 + escaped row line 34
    expect(result.dropped).toBe(1);
  });

  it("intra-session duplicate signals collapse to the first occurrence", () => {
    const result = extractSignalTable(
      [{ sessionPath: NEW_PATH, content: vcc(["Decision: same thing", "Decision: same thing", "Status: other"], []) }],
      CONFIG,
    );
    expect(result.rows.map((r) => r.signal)).toEqual(["same thing", "other"]);
    expect(result.dropped).toBe(0);
  });

  it("stop-at-first-non-fitting row: later smaller rows are dropped too", () => {
    // stBudget 200 (maxTokens 50). Header 77 + newest row line 122 = 199 (fits 200).
    // The OLDER "tiny" row (26) would need 225 -> it stops the fill and is dropped
    // even though it alone would fit the budget.
    const config: SessionRecallConfig = { ...CONFIG, maxTokens: 50 };
    const result = extractSignalTable(
      [
        { sessionPath: OLD_PATH, content: vcc(["Status: tiny"], []) }, // would fit alone...
        { sessionPath: NEW_PATH, content: vcc(["Decision: " + "z".repeat(100)], []) },
      ],
      config,
    );
    // Newest row accepted (with header); the OLDER tiny row is dropped by the stop rule.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].signal).toBe("z".repeat(100));
    expect(result.markdown.length).toBe(199);
    expect(result.dropped).toBe(1);
    expect(result.markdown).not.toContain("tiny");
  });

  it("zero-row input renders empty markdown", () => {
    const result = extractSignalTable(
      [{ sessionPath: NEW_PATH, content: "[Files And Changes]\n- only files\n" }],
      CONFIG,
    );
    expect(result.markdown).toBe("");
    expect(result.rows).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("session with signals does not also emit its goal lines (signals win)", () => {
    const result = extractSignalTable(
      [{ sessionPath: NEW_PATH, content: vcc(["Decision: decided"], ["A goal line"]) }],
      CONFIG,
    );
    expect(result.rows.map((r) => r.signal)).toEqual(["decided"]);
  });
});
