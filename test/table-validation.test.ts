// validateTableSummary (design §2.3) — pure header/ceiling checks: no DB, no LLM.
// (The LLM-level in-loop retry cases through mergeLongTerm land in T2.)
// Plus the pure prompt-builder contract (design §2.5, §6.1/§6.2 — pin D).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateTableSummary,
  buildTableMergePrompt,
  buildConversionPrompt,
  mergeLongTerm,
  auditDrift,
  parseScoreTables,
  pruneStaleRows,
  rowMatchConfidence,
  parseLtLastRestoredItems,
  LT_MATCH_CONFIDENCE,
  LT_META_COUNTER_KEY,
  LT_META_LAST_RESTORED_ITEMS_KEY,
} from "../summarizer.js";
import type { DriftAuditContext } from "../summarizer.js";
import { vol } from "memfs";
import * as logger from "../logger.js";
import { G } from "../types.js";
import { mockCompleteReset, mockCompleteQueue, mockCompleteCalls } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";

const CONFIG: SessionRecallConfig = { ...DEFAULT_CONFIG }; // longTermHardMaxChars 20000 (default, lt-merge-prompt-fix)

function validSummary(): string {
  const section = (name: string, row: string) =>
    `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n${row}`;
  return [
    section("Key Decisions", "| VCC merge | 4 | 645 |"),
    section("Patterns & Conventions", "| (none) | | |"),
    section("Configuration", "| longTermMaxChars: 5000 | 1 | 600 |"),
    section("Lessons Learned", "| (none) | | |"),
    section("Open Issues", "| (none) | | |"),
  ].join("\n\n");
}

/** Insert filler after the Open Issues header so the summary is exactly `target` chars. */
function padTo(target: number): string {
  const base = validSummary();
  const filler = "A".repeat(target - base.length - 1); // -1: the insert adds one trailing \n
  return base.replace("## Open Issues\n", `## Open Issues\n${filler}\n`);
}

describe("validateTableSummary (pure)", () => {
  it("all 5 headers and table headers under 8K validate ok", () => {
    const result = validateTableSummary(validSummary(), CONFIG);
    expect(result).toEqual({ ok: true });
  });

  it("a missing ## <name> line rejects with a reason naming the section", () => {
    const text = validSummary().replace("## Open Issues\n", "");
    const result = validateTableSummary(text, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Open Issues");
    expect(result.reason).toContain("## Open Issues");
  });

  it("a missing | Item | Score | table header rejects with a reason naming the section", () => {
    const text = validSummary().replace(
      "## Configuration\n| Item | Score | Last-Seen |\n",
      "## Configuration\n",
    );
    const result = validateTableSummary(text, CONFIG);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Configuration");
    expect(result.reason).toContain("| Item | Score |");
  });

  it("20K boundary: exactly 20,000 chars ok, 20,001 rejected (default longTermHardMaxChars)", () => {
    expect(validateTableSummary(padTo(20000), CONFIG)).toEqual({ ok: true });
    const over = validateTableSummary(padTo(20001), CONFIG);
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("20001");
    expect(over.reason).toContain("longTermHardMaxChars 20000");
  });

  it("custom longTermHardMaxChars 12000 is respected (12000 ok, 12001 rejected)", () => {
    const config: SessionRecallConfig = { ...CONFIG, longTermHardMaxChars: 12000 };
    expect(validateTableSummary(padTo(12000), config)).toEqual({ ok: true });
    const over = validateTableSummary(padTo(12001), config);
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("longTermHardMaxChars 12000");
  });

  it("ceiling check runs after the header check (header defect reported first)", () => {
    // Both defects present: missing Lessons Learned header AND over the (tiny) ceiling.
    const config: SessionRecallConfig = { ...CONFIG, longTermHardMaxChars: 100 };
    const result = validateTableSummary(padTo(1000).replace("## Lessons Learned\n", ""), config);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Lessons Learned");
  });
});

describe("buildTableMergePrompt (pure — promptText contract, lt-merge-prompt-fix D1/D2)", () => {
  it("contains the five KB section names in exactly the fixed order", () => {
    const prompt = buildTableMergePrompt("EXISTING-SUMMARY-TEXT", ["ENTRY-ONE"], CONFIG, 647);
    const names = ["Key Decisions", "Patterns & Conventions", "Configuration", "Lessons Learned", "Open Issues"];
    let last = -1;
    for (const name of names) {
      const idx = prompt.indexOf(`## ${name}`);
      expect(idx, `missing "## ${name}"`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("contains the four line markers (START before END per block) around their payload slots", () => {
    const prompt = buildTableMergePrompt("EXISTING-SUMMARY-TEXT", ["ENTRY-ONE"], CONFIG, 647);
    for (const marker of [
      "=== CURRENT KNOWLEDGE BASE START ===",
      "=== CURRENT KNOWLEDGE BASE END ===",
      "=== NEW SESSION SUMMARIES START ===",
      "=== NEW SESSION SUMMARIES END ===",
    ]) {
      expect(prompt, `missing marker ${marker}`).toContain(marker);
    }
    const kbStart = prompt.indexOf("=== CURRENT KNOWLEDGE BASE START ===");
    const kbEnd = prompt.indexOf("=== CURRENT KNOWLEDGE BASE END ===");
    const nsStart = prompt.indexOf("=== NEW SESSION SUMMARIES START ===");
    const nsEnd = prompt.indexOf("=== NEW SESSION SUMMARIES END ===");
    expect(kbStart).toBeLessThan(kbEnd);
    expect(nsStart).toBeLessThan(nsEnd);
    // The existing summary and the chunk entries sit between their markers.
    expect(prompt.slice(kbStart, kbEnd)).toContain("EXISTING-SUMMARY-TEXT");
    expect(prompt.slice(nsStart, nsEnd)).toContain("ENTRY-ONE");
  });

  it("contains the VCC input-only warning: the VCC labels must not appear in the output", () => {
    const prompt = buildTableMergePrompt("EXISTING-SUMMARY-TEXT", ["ENTRY-ONE"], CONFIG, 647);
    expect(prompt).toContain("INPUT-ONLY VCC section labels");
    expect(prompt).toContain("[Session Goal], [Files And Changes], [Key Signals], [User Preferences],");
    expect(prompt).toContain("[Brief Transcript]");
    expect(prompt).toContain("must not");
    expect(prompt).toContain("appear in your output");
  });

  it("carries the table protocol, the new rule numbering, and the exact closing line", () => {
    const prompt = buildTableMergePrompt(
      "EXISTING-SUMMARY-TEXT",
      ["ENTRY-ONE", "ENTRY-TWO"],
      CONFIG,
      647,
    );
    // Instruction block
    expect(prompt).toContain("You are merging new session summaries into a long-term knowledge base.");
    expect(prompt).toContain("The knowledge base is EXACTLY these five sections, always in this order,");
    expect(prompt).toContain("| Item | Score | Last-Seen |");
    expect(prompt).toContain("| (none) | | |");
    expect(prompt).toContain("Current session count: 647.");
    // Rules in the new numbering (lt-merge-prompt-fix D1)
    expect(prompt).toContain("1. Table input.");
    expect(prompt).toContain("(score: N)");
    expect(prompt).toContain("(N:x)");
    expect(prompt).toContain("2. Match/increment.");
    expect(prompt).toContain("3. Consolidation.");
    expect(prompt).toContain("4. Never drop rows for length, brevity, or budget.");
    expect(prompt).toContain("5. Remove a row only when a new signal directly contradicts or supersedes it.");
    expect(prompt).toContain("6. Do not apply age/score arithmetic yourself;");
    expect(prompt).toContain("7. Size is a SOFT target, not a hard limit:");
    // The stale-prune arithmetic stays code-owned (never interpolated into the prompt).
    expect(prompt).not.toContain(`- Last-Seen > ${CONFIG.stalePruneAfterSessions} AND Score < ${CONFIG.stalePruneMinScore}`);
    // Chunk join with SEPARATOR + exact closing line
    expect(prompt).toContain("ENTRY-ONE\n---\nENTRY-TWO");
    expect(prompt.endsWith("No prose before or after, no commentary.")).toBe(true);
  });

  it("the soft-budget rule interpolates the config value and the live session count", () => {
    const config: SessionRecallConfig = {
      ...CONFIG,
      longTermMaxChars: 7000,
    };
    const prompt = buildTableMergePrompt("(no previous summary)", ["E"], config, 650);
    expect(prompt).toContain("aim for roughly\n   7000 characters");
    expect(prompt).toContain("Current session count: 650.");
    expect(prompt).toContain("(no previous summary)");
  });
});

describe("buildConversionPrompt (pure — promptText contract, design §6.2)", () => {
  it("contains the full summary, both score formats, and Last-Seen to the current count", () => {
    const summary = "- VCC merge (score: 4)\n- legacy fold (4:2)\n- plain item";
    const prompt = buildConversionPrompt(summary, 910);
    expect(prompt).toContain(summary);
    expect(prompt).toContain("(score: N)");
    expect(prompt).toContain("(N:x)");
    expect(prompt).toContain("Score 1");
    expect(prompt).toContain("Last-Seen to 910");
    expect(prompt).toContain("Key Decisions, Patterns & Conventions, Configuration, Lessons Learned, Open Issues");
    expect(prompt.endsWith("Output only the converted summary.")).toBe(true);
  });
});

// ─── LLM-level in-loop validation retry through mergeLongTerm (design §3.1, pin P1) ──
// §4.1 fixture recipe (memfs homedir + seeded models.json + spied logger + LLM mock).
vi.mock("node:os", () => ({ homedir: () => "/test/sr-table-validation" }));
vi.mock("node:fs", async () => {
  const { fs } = await import("memfs");
  return {
    default: fs,
    ...fs,
    watch: () => ({ close: () => {}, closeSync: () => {} }),
    unwatchFile: () => {},
    createReadStream: fs.createReadStream,
    createWriteStream: fs.createWriteStream,
    constants: fs.constants,
  };
});

const VAL_MODELS_JSON = {
  providers: {
    local: {
      api: "openai-completions",
      baseUrl: "http://localhost:5001/v1",
      apiKey: "none",
      models: [
        { id: "test-model", name: "Test", maxTokens: 8000, contextWindow: 256000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
  },
};

/** Valid 5-section table summary with `label` as the single Key Decisions row. */
function validTables(label: string): string {
  const empty = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
  const first = `## Key Decisions\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| ${label} | 1 | 1 |`;
  return [first, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
}

/** Prose summary — no table headers, fails validateTableSummary's header check. */
const INVALID_SUMMARY = "Prose notes about the project.\n- VCC merge (score: 4)\n- plain item";

describe("mergeLongTerm validation retry (pin P1 — in-loop, one retry)", () => {
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vol.fromJSON({
      ["/test/sr-table-validation/.pi/agent/models.json"]: JSON.stringify(VAL_MODELS_JSON),
      ["/test/sr-table-validation/.pi/agent/.keep"]: "",
    });
    mockCompleteReset();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation((m) => messages.push(m));
    G.__sessionRecallLlmBusy__ = false;
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("invalid then valid: exactly 2 LLM calls, result accepted, retry prompt identical", async () => {
    mockCompleteQueue({ content: [{ type: "text", text: INVALID_SUMMARY }], stopReason: "stop" });
    mockCompleteQueue({ content: [{ type: "text", text: validTables("VALID-ROW") }], stopReason: "stop" });

    const result = await mergeLongTerm("(none)", ["chunk-entry"], CONFIG);

    expect(result.text).toBe(validTables("VALID-ROW")); // P10: result object ({ text, restoredItemTexts })
    const calls = mockCompleteCalls();
    expect(calls).toHaveLength(2);
    // Second call is the validation retry: SAME chunk input -> identical prompt.
    expect(calls[1].promptText).toBe(calls[0].promptText);
    expect(messages.join("\n")).toContain("one in-loop retry");
  });

  it("invalid twice: exactly 2 LLM calls, null returned (no third call)", async () => {
    mockCompleteQueue({ content: [{ type: "text", text: INVALID_SUMMARY }], stopReason: "stop" });
    mockCompleteQueue({ content: [{ type: "text", text: INVALID_SUMMARY }], stopReason: "stop" });

    const result = await mergeLongTerm("(none)", ["chunk-entry"], CONFIG);

    expect(result.text).toBeNull(); // P10: result object ({ text, restoredItemTexts })
    expect(mockCompleteCalls()).toHaveLength(2);
    expect(messages.join("\n")).toContain("Merge LLM output invalid after retry");
  });
});

// ─── Drift audit (design §2 — pure, no I/O) — T1 ─────────────────────────────
// Pins P4–P9 as amended by the 2026-08-25 supervisor ruling (see
// apply-progress.md "Flagged pin conflicts / deviations"): confident predicate
// = confidence >= 0.6 AND shared >= 3; D3 vanished-row step-4 gate (same-section
// partner with 0 < confidence AND shared == 1 → log only, no restore); exact-match
// shortcut (whitespace-normalized byte-identical items → confident regardless of
// shared).
const AUDIT_SECTIONS = ["Key Decisions", "Patterns & Conventions", "Configuration", "Lessons Learned", "Open Issues"] as const;

/** Valid 5-section table summary; `sections` maps section name → raw row lines. */
function table5(sections: Record<string, string[]> = {}): string {
  return AUDIT_SECTIONS.map((n) => {
    const rows = sections[n] ?? [];
    const body = rows.length > 0 ? rows.join("\n") : "| (none) | | |";
    return `## ${n}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n${body}`;
  }).join("\n\n");
}

function auditCtx(over: Partial<DriftAuditContext> = {}): DriftAuditContext {
  return { currentSessionCount: 963, mergeCount: 1, check1Enabled: true, lastRestoredItems: [], config: { ...CONFIG }, ...over };
}

describe("drift audit — A1 escape-on-insert (pipe-byte boundary, design §3.1, pin A1-h)", () => {
  it('raw-\\|-free pipe item round-trip: "Note: use a || b" dropped by merge, restored by D3, re-parsed byte-equal (pin — GREEN today)', () => {
    // The item contains a RAW pipe: the stored line parses scrambled (cells shift — score 1, lastSeen 0),
    // but D3 restores the baseline RAW line verbatim (the restore path neither escapes nor un-escapes),
    // so the healed line is byte-identical to the baseline line and re-parses exactly the same way.
    const baseline = table5({
      "Key Decisions": ["| Note: use a || b | 7 | 961 |", "| Other decision | 2 | 961 |"],
    });
    const output = table5({ "Key Decisions": ["| Other decision | 2 | 961 |"] }); // the LLM dropped the pipe row
    // The scrambled row parses as score 1 / lastSeen 0 → widen the stale gate so this pin exercises
    // the restore path, not the arithmetic-stale skip.
    const r = auditDrift(output, baseline, auditCtx({ config: { ...CONFIG, stalePruneAfterSessions: 1000, stalePruneMinScore: 5 } }));
    const baseRow = parseScoreTables(baseline).sections["Key Decisions"].find((x) => x.item === "Note: use a")!;
    expect(r.restoredItemTexts).toEqual([baseRow.item]);
    // Byte-identity: the exact baseline source line is spliced back at the section end.
    expect(r.healedText).toContain("| Note: use a || b | 7 | 961 |");
    // Re-parsed byte-equal to the original (deterministic scramble — same cells).
    const healedRow = parseScoreTables(r.healedText).sections["Key Decisions"].find((x) => x.item === "Note: use a")!;
    expect(healedRow).toEqual(baseRow);
  });

  it('escaped \\| heal round-trip (RED-first): baseline "| Note: use a \\| b | 7 | 900 |" through the Check 1/2 rebuild site and the D2 rebuild sites → re-parsed cells byte-equal to the unescaped item', () => {
    // (1) Check 1 heal (the Check 1/2 rebuild site): the escaped baseline item un-escapes to "Note: use a | b" on read;
    //     inflation 7 → 9 above the ceiling 8 heals DOWN to 8, and the rebuilt line must re-escape the
    //     literal pipe or the raw pipe scrambles the re-parsed item cell (extra cells; Score misread
    //     via the suffix fallback).
    const escBaseline = table5({ "Key Decisions": ["| Note: use a \\| b | 7 | 900 |"] });
    const escOutput = table5({ "Key Decisions": ["| Note: use a \\| b | 9 | 963 |"] });
    // The pre-fix scramble makes the healed line re-parse as score 1 / lastSeen 0 → widen the stale
    // gate so the escape defect is asserted as a cell mismatch, not masked by the D6 row drop.
    const escCtx = auditCtx({ config: { ...CONFIG, stalePruneAfterSessions: 1000, stalePruneMinScore: 5 } });
    const r1 = auditDrift(escOutput, escBaseline, escCtx);
    expect(r1.events.ceilingClampedScores).toBe(1);
    const r1row = parseScoreTables(r1.healedText).sections["Key Decisions"][0];
    expect(r1row.item).toBe("Note: use a | b"); // the unescaped item, byte-equal
    expect(r1row.score).toBe(8);                 // healed to 7 + mergeCount 1
    expect(r1row.lastSeen).toBe(963);

    // (2) D2 heals (the heal-up / clamp-down rebuild sites): the survivor's item cell (absorbed sum
    //     3 + 4 = 7) is rebuilt with the same escape contract.
    const d2Baseline = table5({
      "Key Decisions": ["| 500-msg chunk windows | 3 | 900 |", "| Structured output: a \\| b | 4 | 910 |"],
    });
    const d2Survivor = (n: number) =>
      table5({ "Key Decisions": [`| Chunking: 500-msg windows with structured output a \\| b | ${n} | 963 |`] });
    const up = auditDrift(d2Survivor(5), d2Baseline, escCtx);
    expect(up.events.raisedScoresToAbsorbedSum).toBe(1);
    expect(parseScoreTables(up.healedText).sections["Key Decisions"][0].item)
      .toBe("Chunking: 500-msg windows with structured output a | b");
    expect(parseScoreTables(up.healedText).sections["Key Decisions"][0].score).toBe(7);

    const down = auditDrift(d2Survivor(9), d2Baseline, escCtx);
    expect(down.events.raisedScoresToAbsorbedSum).toBe(1);
    expect(parseScoreTables(down.healedText).sections["Key Decisions"][0].item)
      .toBe("Chunking: 500-msg windows with structured output a | b");
    expect(parseScoreTables(down.healedText).sections["Key Decisions"][0].score).toBe(8);
  });


  it("triangulate: a lone backslash NOT followed by a pipe passes the heal byte-identical (design §6 risk 9)", () => {
    const bsBaseline = table5({ "Key Decisions": ["| C:\\temp notes | 7 | 900 |"] });
    const bsOutput = table5({ "Key Decisions": ["| C:\\temp notes | 9 | 963 |"] });
    const r = auditDrift(bsOutput, bsBaseline, auditCtx());
    expect(r.events.ceilingClampedScores).toBe(1);
    // escapeItemCell escapes `|` only: a lone backslash is not an escape to the parser (it requires
    // `\` immediately followed by `|`), so it round-trips byte-identically through the heal rewrite.
    expect(r.healedText).toContain("| C:\\temp notes | 8 | 963 |");
    expect(parseScoreTables(r.healedText).sections["Key Decisions"][0].item).toBe("C:\\temp notes");
  });
  });

describe("drift audit — Check 1 ceiling", () => {
  it("13 → 18 → 14: inflation above the per-row ceiling heals to baseline + mergeCount; Last-Seen stays (post-heal Δ = 1 is legit)", () => {
    const baseline = table5({
      "Key Decisions": [
        "| Subagent chunks: 500-msg window; structured output | 13 | 961 |",
        "| Tier 2 merge: single tier2 file | 13 | 961 |",
      ],
    });
    const output = table5({
      "Key Decisions": [
        "| Subagent chunks: 500-msg window; structured output | 18 | 963 |",
        "| Tier 2 merge: single tier2 file | 14 | 963 |",
      ],
    });
    const r = auditDrift(output, baseline, auditCtx());
    expect(r.healedText).toContain("| Subagent chunks: 500-msg window; structured output | 14 | 963 |");
    // Sibling row that moved 13 → 14 (exactly at the ceiling) is NOT healed.
    expect(r.healedText).toContain("| Tier 2 merge: single tier2 file | 14 | 963 |");
    expect(r.events.ceilingClampedScores).toBe(1);
    expect(r.events.revertedLastSeenRewrites).toBe(0);
    expect(r.restoredItemTexts).toEqual([]);
  });

  it("D4 skip: counter absent → no ceiling heal (score 20 stands) while a laundering pair in the same output IS reverted (Check 2 is not counter-gated)", () => {
    const baseline = table5({
      "Key Decisions": [
        "| Subagent chunks: 500-msg window; structured output | 13 | 961 |",
        "| Chunk size intentional for subagent context | 1 | 937 |",
      ],
    });
    const output = table5({
      "Key Decisions": [
        "| Subagent chunks: 500-msg window; structured output | 20 | 961 |",
        "| Chunk size intentional for subagent context | 1 | 963 |",
      ],
    });
    const r = auditDrift(output, baseline, auditCtx({ check1Enabled: false }));
    expect(r.healedText).toContain("| Subagent chunks: 500-msg window; structured output | 20 | 961 |");
    expect(r.healedText).toContain("| Chunk size intentional for subagent context | 1 | 937 |");
    expect(r.events.ceilingClampedScores).toBe(0);
    expect(r.events.revertedLastSeenRewrites).toBe(1);
  });
});

describe("drift audit — D2 consolidation sum", () => {
  const BASE = table5({
    "Key Decisions": [
      "| 500-msg chunk windows | 3 | 900 |",
      "| Structured chunk output | 4 | 910 |",
    ],
  });
  const survivorOut = (n: number) =>
    table5({ "Key Decisions": [`| Chunking: 500-msg windows with structured output | ${n} | 963 |`] });

  it("survivor below the absorbed sum (3 + 4 = 7) is healed UP to the sum (5 → 7)", () => {
    const r = auditDrift(survivorOut(5), BASE, auditCtx());
    expect(r.healedText).toContain("| Chunking: 500-msg windows with structured output | 7 | 963 |");
    expect(r.events.raisedScoresToAbsorbedSum).toBe(1);
    expect(r.restoredItemTexts).toEqual([]);
  });

  it("survivor at sum + 1 stands (8)", () => {
    const r = auditDrift(survivorOut(8), BASE, auditCtx());
    expect(r.healedText).toContain("| Chunking: 500-msg windows with structured output | 8 | 963 |");
    expect(r.events.raisedScoresToAbsorbedSum).toBe(0);
  });

  it("survivor above sum + 1 is clamped DOWN to sum + 1 (9 → 8)", () => {
    const r = auditDrift(survivorOut(9), BASE, auditCtx());
    expect(r.healedText).toContain("| Chunking: 500-msg windows with structured output | 8 | 963 |");
    expect(r.events.raisedScoresToAbsorbedSum).toBe(1);
  });

  it("survivor Last-Seen is untouched by the sum rule (stays 963 in all three cases)", () => {
    for (const n of [5, 8, 9]) {
      const r = auditDrift(survivorOut(n), BASE, auditCtx());
      const line = r.healedText.split("\n").find((l) => l.startsWith("| Chunking:"));
      expect(line).toMatch(/ \| 963 \|$/);
    }
  });

  it("D2 under check1Enabled: false: auditDrift(survivorOut(5), BASE, auditCtx({ check1Enabled: false })) → survivor stands, counters 0", () => {
    // Both BASE rows pair confidently with the survivor (|G(b)| == 1 → absorbed), so with the D2
    // gate (bAbsorbed.length >= 2 && ctx.check1Enabled) off, the sum rule never fires: no heal,
    // no vanish/restore, no uncertain count — the survivor's 5 stands, byte-identical.
    const r = auditDrift(survivorOut(5), BASE, auditCtx({ check1Enabled: false }));
    expect(r.healedText).toBe(survivorOut(5));
    expect(r.events).toEqual({ ceilingClampedScores: 0, raisedScoresToAbsorbedSum: 0, revertedLastSeenRewrites: 0, confirmedRemovals: 0, stalePrunedRows: 0, unmatchedVanishedRows: 0 });
    expect(r.restoredItemTexts).toEqual([]);
  });
});

describe("drift audit — Check 2 join", () => {
  it("937 → 963 → 937: laundering revert on a confident pair (Δscore = 0 ≠ 1)", () => {
    const baseline = table5({ "Lessons Learned": ["| Chunk size intentional for subagent context | 1 | 937 |"] });
    const output = table5({ "Lessons Learned": ["| Chunk size intentional for subagent context | 1 | 963 |"] });
    const r = auditDrift(output, baseline, auditCtx());
    expect(r.healedText).toContain("| Chunk size intentional for subagent context | 1 | 937 |");
    expect(r.events.revertedLastSeenRewrites).toBe(1);
    expect(r.events.ceilingClampedScores).toBe(0);
    expect(r.restoredItemTexts).toEqual([]);
  });

  it("C1 light rephrase is a confident pair: Last-Seen reverts to the baseline value (900)", () => {
    const baseline = table5({ "Patterns & Conventions": ["| Use git worktrees for parallel sessions | 4 | 900 |"] });
    const output = table5({ "Patterns & Conventions": ["| Use git worktrees for parallel dev sessions | 4 | 963 |"] });
    const r = auditDrift(output, baseline, auditCtx());
    expect(r.healedText).toContain("| Use git worktrees for parallel dev sessions | 4 | 900 |");
    expect(r.events.revertedLastSeenRewrites).toBe(1);
  });

  it("C4 heavy rewrite is uncertain → log only: no revert, no restore, no ceiling action (supervisor literal fixture)", () => {
    const baseline = table5({ "Lessons Learned": ["| Prefer explicit params in subagent tasks | 3 | 850 |"] });
    const output = table5({ "Lessons Learned": ["| Task scoping discipline | 1 | 963 |"] });
    const r = auditDrift(output, baseline, auditCtx());
    expect(r.events.unmatchedVanishedRows).toBe(1);
    expect(r.restoredItemTexts).toEqual([]); // vanished row's same-section partner has shared == 1 → gate: no restore
    expect(r.events.revertedLastSeenRewrites).toBe(0);
    expect(r.events.ceilingClampedScores).toBe(0);
    expect(r.events.confirmedRemovals).toBe(0);
    expect(r.healedText).toBe(output); // no line changed at all
    expect(rowMatchConfidence("Prefer explicit params in subagent tasks", "Task scoping discipline")).toBeCloseTo(1 / 3, 2);
  });

  it("C2 split is accounted for: no restore; fragments keep score 1 / Last-Seen 963 (new-row treatment — no ceiling heal, no D2 sum on fragments)", () => {
    const baseline = table5({ "Key Decisions": ["| Chunking: 500-msg windows with structured output | 2 | 880 |"] });
    const output = table5({
      "Key Decisions": [
        "| 500-msg chunk windows | 1 | 963 |",
        "| Structured chunk output (Topics + takeaways) | 1 | 963 |",
      ],
    });
    const r = auditDrift(output, baseline, auditCtx());
    expect(r.restoredItemTexts).toEqual([]);
    expect(r.events).toEqual({ ceilingClampedScores: 0, raisedScoresToAbsorbedSum: 0, revertedLastSeenRewrites: 0, confirmedRemovals: 0, stalePrunedRows: 0, unmatchedVanishedRows: 0 });
    expect(r.healedText).toBe(output);
  });

  it("C6 section move: no confident same-section pair → move logged, baseline NOT restored (no duplicate row)", () => {
    const baseline = table5({ "Configuration": ["| Discord fetch config | 5 | 930 |"] });
    const output = table5({ "Key Decisions": ["| Discord fetch config | 5 | 963 |"] });
    const r = auditDrift(output, baseline, auditCtx());
    expect(r.restoredItemTexts).toEqual([]);
    expect(r.healedText).toBe(output);
    expect(r.events).toEqual({ ceilingClampedScores: 0, raisedScoresToAbsorbedSum: 0, revertedLastSeenRewrites: 0, confirmedRemovals: 0, stalePrunedRows: 0, unmatchedVanishedRows: 0 });
  });

  it("one-token ratio-1.0 pair is NOT confident (shared guard): 'Vite' vs 'Vite migration plan' → vanished, shared==1 gate → log only, no restore", () => {
    const baseline = table5({ "Key Decisions": ["| Vite | 2 | 900 |"] });
    const output = table5({ "Key Decisions": ["| Vite migration plan | 1 | 963 |"] });
    const r = auditDrift(output, baseline, auditCtx());
    expect(rowMatchConfidence("Vite", "Vite migration plan")).toBe(1.0);
    expect(r.restoredItemTexts).toEqual([]);
    expect(r.events.unmatchedVanishedRows).toBe(1);
  });
});

describe("drift audit — D3 vanished rows", () => {
  it("first non-stale vanishing restores the row verbatim at the end of its section and records the item", () => {
    const baseline = table5({
      "Key Decisions": [
        "| Vite migration | 2 | 900 |",
        "| grep unique-string for patch verification | 4 | 950 |",
      ],
    });
    const output = table5({ "Key Decisions": ["| Vite migration | 2 | 900 |"] });
    const r = auditDrift(output, baseline, auditCtx({ lastRestoredItems: [] }));
    expect(r.restoredItemTexts).toEqual(["grep unique-string for patch verification"]);
    expect(r.events.confirmedRemovals).toBe(0);
    // The baseline row's RAW line is re-inserted at the END of its section, byte-identical (4/950).
    expect(r.healedText).toContain("| Vite migration | 2 | 900 |\n| grep unique-string for patch verification | 4 | 950 |\n");
  });

  it("D3 two-merge loop (webpack/Vite, literal): merge N restores verbatim + records; merge N+1 is a confirmed removal", () => {
    const mergeNBaseline = table5({ "Key Decisions": ["| Build system: webpack 5 | 5 | 940 |"] });
    const mergeNOutput = table5({ "Key Decisions": ["| Build system: Vite | 1 | 963 |"] });
    const rN = auditDrift(mergeNOutput, mergeNBaseline, auditCtx({ lastRestoredItems: [] }));
    expect(rN.restoredItemTexts).toEqual(["Build system: webpack 5"]);
    expect(rN.events.confirmedRemovals).toBe(0);
    expect(rN.healedText).toContain("| Build system: webpack 5 | 5 | 940 |");

    // Merge N+1 (next run, session count 964): baseline = merge N's healed text (restored webpack
    // present, Vite present); the LLM drops webpack again; Vite is matched → +1.
    const mergeN1Output = table5({ "Key Decisions": ["| Build system: Vite | 2 | 964 |"] });
    const rN1 = auditDrift(mergeN1Output, rN.healedText, auditCtx({ currentSessionCount: 964, lastRestoredItems: ["Build system: webpack 5"] }));
    expect(rN1.restoredItemTexts).toEqual([]);
    expect(rN1.events.confirmedRemovals).toBe(1);
    expect(rN1.healedText).not.toContain("webpack");
  });

  it("C5 arithmetically-stale vanishing is log only (no restore, no lastRestoredItems record)", () => {
    const baseline = table5({ "Lessons Learned": ["| Old note | 2 | 813 |"] });
    const output = table5({}); // Lessons Learned → placeholder
    const r = auditDrift(output, baseline, auditCtx()); // config stale 100/3, current 963 → age 150
    expect(r.restoredItemTexts).toEqual([]);
    expect(r.events.confirmedRemovals).toBe(0);
    expect(r.healedText).toBe(output);
  });

  it("two-restore positioning/order: two vanished rows in one section → both restored at the section end, reverse baseline order, both recorded in restoredItemTexts", () => {
    // Both vanished rows are non-stale (ages 63/13 ≤ 100), share no tokens with the surviving output
    // row (conf 0 → no step-4 gate, no D5 count), and are not in lastRestoredItems → both restore.
    const baseline = table5({
      "Key Decisions": [
        "| Vite migration | 2 | 900 |",
        "| grep unique-string for patch verification | 4 | 950 |",
      ],
    });
    const output = table5({ "Key Decisions": ["| Subagent task scoping | 3 | 963 |"] });
    const r = auditDrift(output, baseline, auditCtx({ lastRestoredItems: [] }));
    // Both recorded in restoredItemTexts in baseline order...
    expect(r.restoredItemTexts).toEqual(["Vite migration", "grep unique-string for patch verification"]);
    // ...but rendered in REVERSE baseline order at the section end: both inserts share one
    // afterLine (the section's lastNonBlank), and the repeated same-index splices place the
    // later-baseline row ABOVE the earlier-baseline row.
    expect(r.healedText).toContain(
      "| Subagent task scoping | 3 | 963 |\n| grep unique-string for patch verification | 4 | 950 |\n| Vite migration | 2 | 900 |\n",
    );
    expect(r.events).toEqual({ ceilingClampedScores: 0, raisedScoresToAbsorbedSum: 0, revertedLastSeenRewrites: 0, confirmedRemovals: 0, stalePrunedRows: 0, unmatchedVanishedRows: 0 });
  });
});

describe("drift audit — heal mechanics", () => {
  it("heal is line-rewrite only: the healed text differs from the output by exactly the healed row's line", () => {
    const baseline = table5({
      "Key Decisions": [
        "| Row one stays | 3 | 961 |",
        "| Row two inflates | 5 | 961 |",
        "| Row three stays | 2 | 961 |",
      ],
    });
    const output = table5({
      "Key Decisions": [
        "| Row one stays | 3 | 961 |",
        "| Row two inflates | 9 | 963 |",
        "| Row three stays | 2 | 961 |",
      ],
    });
    const r = auditDrift(output, baseline, auditCtx());
    const outLines = output.split("\n");
    const healedLines = r.healedText.split("\n");
    expect(healedLines).toHaveLength(outLines.length);
    const diffIdx = healedLines.map((l, i) => (l === outLines[i] ? -1 : i)).filter((i) => i !== -1);
    expect(diffIdx).toEqual([4]); // exactly row 2's line — row 1, row 3, headers, other sections byte-identical
    expect(healedLines[4]).toBe("| Row two inflates | 6 | 963 |");
    expect(r.events.ceilingClampedScores).toBe(1);
  });

  it("exact-match shortcut: an unchanged 2-token row is confident via byte-identity — paired, never vanished, never duplicated (supervisor fixture)", () => {
    const baseline = table5({ "Key Decisions": ["| Vite build | 2 | 900 |"] });
    const output = table5({ "Key Decisions": ["| Vite build | 2 | 963 |"] });
    const r = auditDrift(output, baseline, auditCtx());
    expect(r.restoredItemTexts).toEqual([]); // without the shortcut this row would be vanished → restored (duplicated)
    expect(r.healedText).toContain("| Vite build | 2 | 900 |"); // laundering revert (Δ = 0)
    expect(r.healedText).not.toContain("| Vite build | 2 | 963 |");
    expect(r.events.revertedLastSeenRewrites).toBe(1);
  });

  it("idempotent on clean output (triangulation): healedText === outputText, all events zero", () => {
    const t = table5({
      "Key Decisions": ["| Stable decision | 7 | 963 |"],
      "Lessons Learned": ["| Stable lesson | 2 | 963 |"],
    });
    const r = auditDrift(t, t, auditCtx());
    expect(r.healedText).toBe(t);
    expect(r.events).toEqual({ ceilingClampedScores: 0, raisedScoresToAbsorbedSum: 0, revertedLastSeenRewrites: 0, confirmedRemovals: 0, stalePrunedRows: 0, unmatchedVanishedRows: 0 });
    expect(r.restoredItemTexts).toEqual([]);
  });

  it("malformed-pair MUST-NOT-throw: extra cells / lone backslash / empty-after-trim item / non-numeric score → result without throwing; merge level returns { text, restoredItemTexts }", async () => {
    // Structurally odd output rows against an all-placeholder baseline: whatever the parser does
    // (scramble, fallback, or drop), the pipeline returns a shaped result without throwing.
    const malformed = table5({
      "Key Decisions": [
        "| Too | many | cells | in | this | 5 | 963 |",
        "| C:\\temp notes | 7 | 963 |",
        "|    | 3 | 963 |",
        "| Non numeric score row | abc | 963 |",
      ],
    });
    const baseline = table5({});
    const r = auditDrift(malformed, baseline, auditCtx());
    expect(typeof r.healedText).toBe("string");
    expect(Array.isArray(r.restoredItemTexts)).toBe(true);
    // The five non-D6 counters must be 0 (empty baseline → no pairing, no heal, no restore, no
    // uncertain count). D6 is bounded by the row count: the extra-cells row scrambles through the
    // parse fallback to lastSeen 0 / score 0 → arithmetically stale → pruned (D6 doing its job on
    // garbage, not a pipeline defect — recorded in apply-progress as the T7 RED-turned-fix).
    expect(r.events.ceilingClampedScores).toBe(0);
    expect(r.events.raisedScoresToAbsorbedSum).toBe(0);
    expect(r.events.revertedLastSeenRewrites).toBe(0);
    expect(r.events.confirmedRemovals).toBe(0);
    expect(r.events.unmatchedVanishedRows).toBe(0);
    expect(r.events.stalePrunedRows).toBeGreaterThanOrEqual(0);
    expect(r.events.stalePrunedRows).toBeLessThanOrEqual(4);

    // Merge level: the same malformed LLM output still validates (headers intact, under 8K) and the
    // merge returns the { text, restoredItemTexts } result object.
    vol.fromJSON({
      ["/test/sr-table-validation/.pi/agent/models.json"]: JSON.stringify(VAL_MODELS_JSON),
      ["/test/sr-table-validation/.pi/agent/.keep"]: "",
    });
    mockCompleteReset();
    mockCompleteQueue({ content: [{ type: "text", text: malformed }], stopReason: "stop" });
    G.__sessionRecallLlmBusy__ = false;
    const result = await mergeLongTerm("(none)", ["chunk-entry"], CONFIG);
    expect(typeof result.text).toBe("string");
    expect(result.text).not.toBeNull();
    expect(Array.isArray(result.restoredItemTexts)).toBe(true);
  });
});

describe("pruneStaleRows — D6 boundary", () => {
  it("at-limit survives, one-over is pruned, matched row at age 0 survives (explicit config 100/10)", () => {
    const text = table5({
      "Open Issues": [
        "| Row X at limit | 10 | 863 |",
        "| Row Y over limit | 9 | 862 |",
        "| Row Z matched | 1 | 963 |",
      ],
    });
    const cfg: SessionRecallConfig = { ...CONFIG, stalePruneAfterSessions: 100, stalePruneMinScore: 10 };
    const res = pruneStaleRows(text, 963, cfg);
    expect(res.pruned).toBe(1);
    const prunedLine = "| Row Y over limit | 9 | 862 |";
    expect(res.text).not.toContain(prunedLine);
    expect(res.text).toContain("| Row X at limit | 10 | 863 |");
    expect(res.text).toContain("| Row Z matched | 1 | 963 |");
    // Non-row lines (headers, separators, placeholders) stay byte-identical.
    expect(res.text.split("\n")).toEqual(text.split("\n").filter((l) => l !== prunedLine));
  });

  it("auditDrift: unparseable prose baseline is a no-op and must not throw — checks/restore skip, the D6 prune still runs on the output", () => {
    const baseline = "Legacy prose notes.\n- old item (score: 5)";
    const output = table5({ "Open Issues": ["| Fresh row | 1 | 963 |", "| Ancient weak row | 1 | 700 |"] });
    const r = auditDrift(output, baseline, auditCtx());
    expect(r.healedText).not.toContain("Ancient weak row"); // age 263 > 100 AND 1 < 3 → pruned
    expect(r.healedText).toContain("| Fresh row | 1 | 963 |"); // age 0 → survives
    expect(r.events.stalePrunedRows).toBe(1);
    expect(r.restoredItemTexts).toEqual([]);
    expect(r.events.ceilingClampedScores).toBe(0);
    expect(r.events.revertedLastSeenRewrites).toBe(0);
  });

  it("rows-exist-but-unparseable no-op: 4 of 5 sections headered WITH rows → parseable === false, rows > 0 → checks/restore skip, restoredItemTexts empty, D6 prune still ran, no throw", () => {
    // Four sections carry table headers WITH rows; the fifth (Open Issues) has its section header
    // but NO table header => parseable === false yet rows > 0 (the DIVERGENCE case, design §3.6).
    const baseline = [
      "## Key Decisions",
      "| Item | Score | Last-Seen |",
      "|------|-------|-----------|",
      "| Anchor | 13 | 961 |",
      "| To be restored | 5 | 950 |",
      "",
      "## Patterns & Conventions",
      "| Item | Score | Last-Seen |",
      "|------|-------|-----------|",
      "| Pattern one | 4 | 940 |",
      "",
      "## Configuration",
      "| Item | Score | Last-Seen |",
      "|------|-------|-----------|",
      "| Config row | 2 | 930 |",
      "",
      "## Lessons Learned",
      "| Item | Score | Last-Seen |",
      "|------|-------|-----------|",
      "| Lesson row | 3 | 920 |",
      "",
      "## Open Issues",
      "prose only — no table header in this section",
    ].join("\n");
    const baseParsed = parseScoreTables(baseline);
    expect(baseParsed.parseable).toBe(false);
    const baseRowCount = Object.values(baseParsed.sections).reduce((n, rows) => n + rows.length, 0);
    expect(baseRowCount).toBeGreaterThan(0);

    // The output would fire a Check 1 clamp (Anchor 13 -> 20) and a D3 restore ("To be restored"
    // vanished); it also carries one stale-weak row (age 263 > 200, score 1 < 5) D6 must still prune.
    const output = table5({
      "Key Decisions": ["| Anchor | 20 | 961 |", "| Stale weak | 1 | 700 |"],
      "Patterns & Conventions": ["| Pattern one | 4 | 940 |"],
      "Configuration": ["| Config row | 2 | 930 |"],
      "Lessons Learned": ["| Lesson row | 3 | 920 |"],
      "Open Issues": ["| Issue row | 1 | 961 |"],
    });

    const r = auditDrift(output, baseline, auditCtx()); // no throw

    // Pinned no-op: checks/restore skip — the would-be clamp and restore do NOT fire
    // (RED today: the flag is dead — with rows > 0 the checks/restore run, so the restore fires).
    expect(r.restoredItemTexts).toEqual([]);
    expect(r.healedText).toContain("| Anchor | 20 | 961 |");            // no Check 1 clamp
    expect(r.healedText).not.toContain("| To be restored | 5 | 950 |"); // no D3 restore
    // D6 prune STILL ran on the healed text (unconditional tail);
    // everything else zero (uncertain counting included).
    expect(r.healedText).not.toContain("| Stale weak | 1 | 700 |");
    expect(r.events).toEqual({ ceilingClampedScores: 0, raisedScoresToAbsorbedSum: 0, revertedLastSeenRewrites: 0, confirmedRemovals: 0, stalePrunedRows: 1, unmatchedVanishedRows: 0 });
  });
});

describe("rowMatchConfidence — threshold bands", () => {
  it("LT_MATCH_CONFIDENCE is the named 0.6 threshold", () => {
    expect(LT_MATCH_CONFIDENCE).toBe(0.6);
  });

  it("design §2.3 calibration: confident cases ≥ 0.6 (boundary inclusive), C4 ≈ 0.33 < 0.6", () => {
    // C1 light rephrase
    expect(rowMatchConfidence("Use git worktrees for parallel sessions", "Use git worktrees for parallel dev sessions")).toBe(1.0);
    // D2 absorbed rows → survivor (both confident per §2.3 calibration)
    expect(rowMatchConfidence("500-msg chunk windows", "Chunking: 500-msg windows with structured output")).toBe(1.0);
    expect(rowMatchConfidence("Structured chunk output", "Chunking: 500-msg windows with structured output")).toBe(1.0);
    // C2 fragments vs the split baseline (frag1 = 1.0; frag2 = exactly 0.6 — boundary inclusive, `>=`)
    expect(rowMatchConfidence("Chunking: 500-msg windows with structured output", "500-msg chunk windows")).toBe(1.0);
    expect(rowMatchConfidence("Chunking: 500-msg windows with structured output", "Structured chunk output (Topics + takeaways)")).toBe(0.6);
    // C4 heavy rewrite: 1/3 < 0.6
    expect(rowMatchConfidence("Prefer explicit params in subagent tasks", "Task scoping discipline")).toBeCloseTo(1 / 3, 2);
    // Identical items
    expect(rowMatchConfidence("Discord fetch config", "Discord fetch config")).toBe(1.0);
    // Disjoint items
    expect(rowMatchConfidence("alpha beta", "gamma delta")).toBe(0);
  });
});

describe("parseLtLastRestoredItems", () => {
  it('parses a JSON string array: "[\\"a\\"]" → ["a"], "[]" → [], garbage → [], null → []', () => {
    expect(parseLtLastRestoredItems('["a"]')).toEqual(["a"]);
    expect(parseLtLastRestoredItems("[]")).toEqual([]);
    expect(parseLtLastRestoredItems("not-json{")).toEqual([]);
    expect(parseLtLastRestoredItems(null)).toEqual([]);
    // triangulation
    expect(parseLtLastRestoredItems('["a", "b"]')).toEqual(["a", "b"]);
    expect(parseLtLastRestoredItems("[1]")).toEqual([]); // non-string element → []
    expect(parseLtLastRestoredItems('"str"')).toEqual([]); // not an array → []
  });

  it("the two new meta keys are exactly lt_meta_counter and lt_meta_last_restored_items (A7)", () => {
    expect(LT_META_COUNTER_KEY).toBe("lt_meta_counter");
    expect(LT_META_LAST_RESTORED_ITEMS_KEY).toBe("lt_meta_last_restored_items");
  });
});