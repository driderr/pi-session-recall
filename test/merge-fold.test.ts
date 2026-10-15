// Fold loop (design §2.7, pins D/G) — LLM-level fold tests.
// §4.1 fixture recipe (memfs homedir + seeded models.json + spied logger)
// plus the session-start-merge-flow in-memory DB convention.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vol } from "memfs";
import { createRequire } from "node:module";
import * as logger from "../logger.js";
import {
  ensureSchema,
  packMergeChunks,
  runMergeFold,
  mergeLongTerm,
  sqliteReadLongTerm,
  sqliteMarkSessionSummariesMerged,
  sqliteWriteLongTerm,
  sqliteGetMeta,
  sqliteSetMeta,
  readMergeQuarantine,
  recordMergeFailure,
  md5Content,
  takeDriftEvents,
  LT_META_COUNTER_KEY,
  LT_META_LAST_RESTORED_ITEMS_KEY,
} from "../summarizer.js";
import type { MergeFoldIo, MergeChunk } from "../summarizer.js";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";
import { G } from "../types.js";
import {
  mockCompleteReset,
  mockCompleteQueue,
  mockCompleteCalls,
} from "@earendil-works/pi-ai";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// Unique per-file memfs homedir (avoids cross-file memfs collisions).
vi.mock("node:os", () => ({ homedir: () => "/test/sr-merge-fold" }));
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

const MODELS_JSON = {
  providers: {
    local: {
      api: "openai-completions",
      baseUrl: "http://localhost:5001/v1",
      apiKey: "none",
      models: [
        {
          id: "test-model",
          name: "Test",
          maxTokens: 8000,
          contextWindow: 256000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  },
};

const A = "/pi/agent/sessions/sess-a.jsonl";
const B = "/pi/agent/sessions/sess-b.jsonl";
const C = "/pi/agent/sessions/sess-c.jsonl";
// 100-char content -> rendered entry > mergeChunkChars(100) -> one chunk per session.
const CONTENT_A = "Alpha fresh " + "a".repeat(100);
const CONTENT_B = "Beta fresh " + "b".repeat(100);
const CONTENT_C = "Gamma fresh " + "c".repeat(100);
const CONFIG: SessionRecallConfig = { ...DEFAULT_CONFIG, mergeChunkChars: 100, mergeMaxChunksPerRun: 8 };

function createDb(): any {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function insertUnmerged(db: any, path: string, content: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO session_summaries " +
    "(session_path, version, summary, char_count, merge_count, updated_at) " +
    "VALUES (?, 1, ?, ?, ?, ?)",
  ).run(path, content, content.length, 1, new Date().toISOString());
  db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run(content, path);
}

function unmergedRows(db: any): Array<{ session_path: string; unmerged_fresh_content: string }> {
  return db.prepare(
    "SELECT session_path, unmerged_fresh_content FROM session_summaries " +
    "WHERE unmerged_fresh_content IS NOT NULL AND length(unmerged_fresh_content) > 0 " +
    "ORDER BY updated_at ASC",
  ).all();
}

/** A valid 5-section table summary with `label` as the single Key Decisions row —
 *  passes validateTableSummary (design §2.3) under the default config, so the fold's
 *  mock LLM responses survive the T2 validation gate with one call each. */
function validTables(label: string): string {
  const empty = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
  const first = `## Key Decisions\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| ${label} | 1 | 1 |`;
  return [first, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
}

/** Prose (no table headers) — fails validateTableSummary's header check. */
const INVALID_SUMMARY = "Prose notes only.\n- some item (score: 2)";

function okText(label: string): unknown {
  return { content: [{ type: "text", text: validTables(label) }], stopReason: "stop" };
}

function invalidText(): unknown {
  return { content: [{ type: "text", text: INVALID_SUMMARY }], stopReason: "stop" };
}

describe("runMergeFold (design §2.7)", () => {
  let db: any;
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = createDb();
    vol.fromJSON({
      ["/test/sr-merge-fold/.pi/agent/models.json"]: JSON.stringify(MODELS_JSON),
      ["/test/sr-merge-fold/.pi/agent/.keep"]: "",
    });
    mockCompleteReset();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
    G.__sessionRecallLlmBusy__ = false;
    G.__sessionRecallMergeInProgress__ = false;
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  it("carry-forward: chunk N+1's existing summary is chunk N's output (not the baseline)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks).toHaveLength(2);

    mockCompleteQueue(okText("O1-OUTPUT-ABC"));
    mockCompleteQueue(okText("O2-OUTPUT-DEF"));
    const result = await runMergeFold(db, chunks, "S0-BASELINE-XYZ", [], CONFIG);

    expect(result.processedChunks).toBe(2);
    expect(result.lastSummary).toContain("O2-OUTPUT-DEF");
    const calls = mockCompleteCalls();
    expect(calls).toHaveLength(2);
    // Call 1: baseline as the existing summary + chunk 1's entry.
    expect(calls[0].promptText).toContain("S0-BASELINE-XYZ");
    expect(calls[0].promptText).toContain(CONTENT_A);
    expect(calls[0].promptText).not.toContain(CONTENT_B);
    // Call 2: carry-forward output of chunk 1 (baseline gone) + chunk 2's entry.
    expect(calls[1].promptText).toContain("O1-OUTPUT-ABC");
    expect(calls[1].promptText).not.toContain("S0-BASELINE-XYZ");
    expect(calls[1].promptText).toContain(CONTENT_B);
  });

  it("existing summary is passed unclamped (full text in the prompt)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    const baseline = "C".repeat(7757); // > 5000 (longTermMaxChars below)
    mockCompleteQueue(okText("OUT"));

    await runMergeFold(db, chunks, baseline, [], { ...CONFIG, longTermMaxChars: 5000 });

    const prompt = mockCompleteCalls()[0].promptText;
    expect(prompt).toContain("C".repeat(7757)); // full baseline — no front-clamp (lt-merge-prompt-fix D3)
  });

  it("write-then-mark order per chunk; mark receives exactly the chunk's paths", async () => {
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(okText("O1-OUTPUT-ABC"));
    mockCompleteQueue(okText("O2-OUTPUT-DEF"));

    const order: string[] = [];
    const markPaths: string[][] = [];
    let midRunLongTerm: { summary: string } | null = null;
    const io: MergeFoldIo = {
      write: (d, summary, n, merged) => {
        order.push("write");
        sqliteWriteLongTerm(d, summary, n, merged);
      },
      mark: (d, paths) => {
        order.push("mark");
        markPaths.push(paths);
        if (markPaths.length === 1) {
          midRunLongTerm = sqliteReadLongTerm(d) as { summary: string } | null; // read AFTER write#1
        }
        sqliteMarkSessionSummariesMerged(d, paths);
      },
    };

    await runMergeFold(db, chunks, "base", [], CONFIG, io);

    expect(order).toEqual(["write", "mark", "write", "mark"]);
    expect(markPaths[0]).toEqual([A]);
    expect(markPaths[1]).toEqual([B]);
    // write#1 already stood (long_term bumped with chunk 1's output) before mark#1.
    expect(midRunLongTerm?.summary).toContain("O1-OUTPUT-ABC");
    const final = sqliteReadLongTerm(db);
    expect(final?.summary).toContain("O2-OUTPUT-DEF");
    // merged_sessions accumulates both chunk hashes, persisted inside the write.
    expect(Array.isArray(final?.mergedSessions)).toBe(true);
    expect(final?.mergedSessions).toHaveLength(2);
  });

  it("write succeeds, mark throws — next run re-merges that chunk only (no content lost)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeFoldChunks(db);
    mockCompleteQueue(okText("O1-OUTPUT-ABC"));
    mockCompleteQueue(okText("O2-OUTPUT-DEF"));

    let markCalls = 0;
    const io: MergeFoldIo = {
      mark: (d, paths) => {
        markCalls++;
        if (markCalls === 2) throw new Error("SQLITE_BUSY"); // mark for chunk 2 (session B)
        sqliteMarkSessionSummariesMerged(d, paths);
      },
    };

    await expect(runMergeFold(db, chunks, "base", [], CONFIG, io)).rejects.toThrow("SQLITE_BUSY");

    // Chunk 1 (A) persisted: marked + written. Chunk 2 (B): write stood but mark threw.
    expect(unmergedRow(db, A)).toBeNull();
    const bStillUnmerged = unmergedRow(db, B);
    expect(bStillUnmerged).toBe(CONTENT_B); // no content lost before the re-merge
    expect(sqliteReadLongTerm(db)?.summary).toContain("O2-OUTPUT-DEF"); // write#2 stood

    // Next run: re-pack the remaining unmerged (B only) and re-merge it.
    const remaining = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].paths).toEqual([B]);
    mockCompleteQueue(okText("O3-REMERGED"));
    const baseline = sqliteReadLongTerm(db)?.summary ?? "";
    const result2 = await runMergeFold(db, remaining, baseline, sqliteReadLongTerm(db)?.mergedSessions ?? [], CONFIG);
    expect(result2.processedChunks).toBe(1);
    expect(unmergedRow(db, B)).toBeNull();
    expect(sqliteReadLongTerm(db)?.summary).toContain("O3-REMERGED");
  });

  it("stop-on-failure leaves earlier chunks persisted (no LLM call for later chunks)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    insertUnmerged(db, C, CONTENT_C);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks).toHaveLength(3);
    mockCompleteQueue(okText("O1-OUTPUT-ABC"));
    mockCompleteQueue({ content: [], stopReason: "error", errorMessage: "boom" });

    const result = await runMergeFold(db, chunks, "base", [], CONFIG);

    expect(result.stoppedAtChunk).toBe(1);
    expect(result.processedChunks).toBe(1);
    expect(mockCompleteCalls()).toHaveLength(2); // NO call for chunk 3 (C)
    expect(unmergedRow(db, A)).toBeNull(); // chunk 1 persisted
    expect(unmergedRow(db, B)).toBe(CONTENT_B); // failed chunk left unmerged
    expect(unmergedRow(db, C)).toBe(CONTENT_C); // never touched
    const logged = messages.join("\n");
    expect(logged).toContain("chunk 1 failed"); // 0-based chunk index in the fold log
    expect(logged).toContain("sess-b.jsonl");   // chunk 2's first-session basename
    expect(logged).toContain("boom");           // failure reason via mergeLongTerm's error log
  });

  it("per-run budget caps chunks; a subsequent run processes the remainder", async () => {
    const paths: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const p = `/pi/agent/sessions/sess-${String(i).padStart(2, "0")}.jsonl`;
      paths.push(p);
      insertUnmerged(db, p, `S${i} fresh ` + String(i).repeat(100));
    }
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks).toHaveLength(10);

    for (let i = 0; i < 8; i++) mockCompleteQueue(okText(`O${i + 1}`));
    const result1 = await runMergeFold(db, chunks, "base", [], CONFIG);
    expect(result1.processedChunks).toBe(8);
    expect(mockCompleteCalls()).toHaveLength(8);
    expect(messages.join("\n")).toContain("run budget 8");
    expect(messages.join("\n")).toContain("2 chunk(s) deferred");
    expect(unmergedRow(db, paths[8])).not.toBeNull();
    expect(unmergedRow(db, paths[9])).not.toBeNull();

    const remaining = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(remaining).toHaveLength(2);
    mockCompleteQueue(okText("O9"));
    mockCompleteQueue(okText("O10"));
    const result2 = await runMergeFold(db, remaining, "O8", [], CONFIG);
    expect(result2.processedChunks).toBe(2);
    expect(mockCompleteCalls()).toHaveLength(10);
    expect(unmergedRow(db, paths[9])).toBeNull();
  });

  it("model uses the primary configured model with the pinned options", async () => {
    insertUnmerged(db, A, CONTENT_A);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(okText("O"));

    await runMergeFold(db, chunks, "base", [], CONFIG);

    const call = mockCompleteCalls()[0];
    const model = call.model as { id: string; reasoning: boolean };
    expect(model.id).toBe("test-model");
    expect(model.reasoning).toBe(true);
    expect(call.options).not.toHaveProperty("maxTokens"); // output-token cap removed (lt-merge-prompt-fix D2)
    expect(call.options.reasoningEffort).toBe("low");
  });

  it("empty chunks: no LLM call, long_term untouched", async () => {
    const result = await runMergeFold(db, [], "base", [], CONFIG);
    expect(result.processedChunks).toBe(0);
    expect(result.lastSummary).toBeNull();
    expect(result.busySkipped).toBe(false);
    expect(mockCompleteCalls()).toHaveLength(0);
    expect(sqliteReadLongTerm(db)).toBeNull();
  });

  it("busySkipped: true when the LLM busy flag is pre-held (no LLM call)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(okText("O"));
    G.__sessionRecallLlmBusy__ = true;

    const result = await runMergeFold(db, chunks, "base", [], CONFIG);

    expect(result.busySkipped).toBe(true);
    expect(result.processedChunks).toBe(0);
    expect(mockCompleteCalls()).toHaveLength(0);
  });
  it("LTROW MODE: executed fold logs `LTROW MODE LEGACY` as its first log line — before the budget log (P1 byte-exact)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks).toHaveLength(2);
    mockCompleteQueue(okText("O1"));

    const result = await runMergeFold(db, chunks, "base", [], { ...CONFIG, mergeMaxChunksPerRun: 1 });

    expect(result.processedChunks).toBe(1);
    expect(messages[0]).toBe("LTROW MODE LEGACY"); // P1 — byte-exact; the fold's first log line
    const budgetIdx = messages.findIndex((m) => m.startsWith("merge fold: run budget"));
    expect(budgetIdx, "budget log fires, after the MODE line").toBeGreaterThan(0);
  });

  it("LTROW MODE: busy-skipped fold (lock pre-held) still logs `LTROW MODE LEGACY` (P1)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    G.__sessionRecallLlmBusy__ = true;

    const result = await runMergeFold(db, chunks, "base", [], CONFIG);

    expect(result.busySkipped).toBe(true);
    expect(messages).toContain("LTROW MODE LEGACY"); // P1 — the flag record is logged even when the fold body skips
  });

  it("fold-internal calls do not re-acquire busy (no self-deadlock)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(okText("O1"));
    mockCompleteQueue(okText("O2"));

    const result = await runMergeFold(db, chunks, "base", [], CONFIG);

    expect(result.processedChunks).toBe(2);
    expect(mockCompleteCalls()).toHaveLength(2); // the run's own flag must not skip chunk 2
    expect(messages.join("\n")).not.toContain("LLM call skipped");
  });

  it("validation-failed chunk: invalid twice -> 2 LLM calls, strike on chunk head, run stops, earlier chunks persisted", async () => {
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks).toHaveLength(2);
    mockCompleteQueue(okText("O1-OUTPUT-ABC")); // chunk 1 succeeds
    mockCompleteQueue(invalidText());            // chunk 2: invalid, then...
    mockCompleteQueue(invalidText());            // ...invalid after the one in-loop retry

    const result = await runMergeFold(db, chunks, "base", [], CONFIG);

    expect(result.processedChunks).toBe(1);
    expect(result.stoppedAtChunk).toBe(1);
    expect(mockCompleteCalls()).toHaveLength(3); // 1 (chunk 1) + 2 (chunk 2 incl. validation retry)
    // Strike on the chunk HEAD (B): failures 1, not yet quarantined.
    expect(readMergeQuarantine(db, B)?.failures).toBe(1);
    expect(readMergeQuarantine(db, A)).toBeNull();
    expect(unmergedRow(db, A)).toBeNull();   // earlier chunk persisted
    expect(unmergedRow(db, B)).toBe(CONTENT_B); // failed chunk left unmerged
  });

  it("invalid then valid chunk: 2 LLM calls, chunk persisted, no strike", async () => {
    insertUnmerged(db, A, CONTENT_A);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(invalidText());          // first call invalid...
    mockCompleteQueue(okText("O1-RECOVERED")); // validation retry succeeds

    const result = await runMergeFold(db, chunks, "base", [], CONFIG);

    expect(result.processedChunks).toBe(1);
    expect(result.stoppedAtChunk).toBeNull();
    expect(mockCompleteCalls()).toHaveLength(2);
    expect(readMergeQuarantine(db, A)).toBeNull(); // no strike
    expect(unmergedRow(db, A)).toBeNull();
    expect(sqliteReadLongTerm(db)?.summary).toContain("O1-RECOVERED");
    // Retry used the SAME chunk input (identical prompt).
    const calls = mockCompleteCalls();
    expect(calls[1].promptText).toBe(calls[0].promptText);
  });

  it("prompt is the table protocol with Current session count = mergedSessions.size after the chunk add (pins D/H)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(okText("O1"));

    // Baseline carries 2 merged-session hashes; the chunk adds A's hash -> size 3.
    await runMergeFold(db, chunks, "base", ["seed-hash-1", "seed-hash-2"], CONFIG);

    const prompt = mockCompleteCalls()[0].promptText;
    expect(prompt).toContain("| Item | Score | Last-Seen |");
    expect(prompt).toContain("Match/increment");
    expect(prompt).toContain("1. Table input.");
    expect(prompt).toContain("4. Never drop rows for length, brevity, or budget."); // renumbered (lt-merge-prompt-fix D1)
    expect(prompt).toContain("Current session count: 3.");
    // D6 replacement: the stale-prune arithmetic is code-owned and out of the prompt (P13).
    expect(prompt).toContain("6. Do not apply age/score arithmetic yourself;");
    expect(prompt).not.toContain("- Last-Seen > 100 AND Score < 3");
    expect(prompt).toContain("aim for roughly\n   5000 characters");
    expect(prompt.endsWith("No prose before or after, no commentary.")).toBe(true);
  });
});

// ─── Drift audit — fold counter mechanics (T2 / design §3, pins P1–P3, P7, P10, P11) ───

describe("drift audit — fold counter mechanics", () => {
  let db: any;
  let logSpy: ReturnType<typeof vi.spyOn>;

  /** Valid 5-section tables with a single Key Decisions row (passes validateTableSummary). */
  const tablesRow = (item: string, score: number, lastSeen: number): string => {
    const empty = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
    const first = `## Key Decisions\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| ${item} | ${score} | ${lastSeen} |`;
    return [first, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
  };
  const emptyTables = (): string => {
    const empty = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
    return [empty("Key Decisions"), empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
  };
  const okTables = (text: string): unknown => ({ content: [{ type: "text", text }], stopReason: "stop" });

  beforeEach(() => {
    db = createDb();
    vol.fromJSON({
      ["/test/sr-merge-fold/.pi/agent/models.json"]: JSON.stringify(MODELS_JSON),
      ["/test/sr-merge-fold/.pi/agent/.keep"]: "",
    });
    mockCompleteReset();
    logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});
    G.__sessionRecallLlmBusy__ = false;
    G.__sessionRecallMergeInProgress__ = false;
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  it("counter increments once per successful chunk (+2); per-chunk mergeCount = counterAtRunStart + successfulMerges + 1", async () => {
    sqliteSetMeta(db, LT_META_COUNTER_KEY, "5");
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks).toHaveLength(2);

    // Baseline row 13/961. Chunk 1 output 20/961 -> healed to 19 (ceiling 13 + mergeCount 6,
    // NOT 18 under a stale mergeCount 5). Chunk 2 (carry-forward 19/961) output 26/961 ->
    // stands exactly at the ceiling 19 + mergeCount 7 (NOT healed to 25 under mergeCount 6).
    mockCompleteQueue(okTables(tablesRow("Subagent chunks 500", 20, 961)));
    mockCompleteQueue(okTables(tablesRow("Subagent chunks 500", 26, 961)));
    const result = await runMergeFold(db, chunks, tablesRow("Subagent chunks 500", 13, 961), [], CONFIG);
    expect(result.processedChunks).toBe(2);

    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("7"); // 5 + 2 — exactly once per successful chunk
    const final = sqliteReadLongTerm(db)?.summary ?? "";
    expect(final).toContain("| Subagent chunks 500 | 26 | 961 |");
    const carry = mockCompleteCalls()[1].promptText;
    expect(carry).toContain("| Subagent chunks 500 | 19 | 961 |"); // chunk 1's HEALED output (19 = 13 + 6)
    expect(carry).not.toContain("| Subagent chunks 500 | 20 | 961 |");
  });

  it(`quarantine-skip formula: 3-chunk fold, chunk 1 quarantined (counter "1" + 2 prior failures pre-seeded + mockCompleteQueue({ content: [], stopReason: "error" })) → chunk 2's ceiling is 13+2=15 (healed from 16), not 13+3=16 — pins counterAtRunStart + successfulMerges + 1`, async () => {
    sqliteSetMeta(db, LT_META_COUNTER_KEY, "1");
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    insertUnmerged(db, C, CONTENT_C);
    // Two prior failures pre-seeded for chunk 1's head (A): the in-run failure is the 3rd strike
    // -> quarantine + `continue` (chunk 1 never reaches write/mark -> not a successful merge).
    recordMergeFailure(db, A, md5Content(CONTENT_A), Date.now());
    recordMergeFailure(db, A, md5Content(CONTENT_A), Date.now());
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks).toHaveLength(3);

    const baselineScore = 13;
    const outputScore = 16;
    mockCompleteQueue({ content: [], stopReason: "error", errorMessage: "boom" }); // chunk 1 fails in-run (null text)
    mockCompleteQueue(okTables(tablesRow("Anchor", outputScore, 961))); // chunk 2 inflates 13 -> 16
    mockCompleteQueue(okTables(tablesRow("Anchor", baselineScore + 2, 961))); // chunk 3 keeps the value
    const result = await runMergeFold(db, chunks, tablesRow("Anchor", baselineScore, 961), [], CONFIG);
    expect(result.processedChunks).toBe(2);
    expect(result.quarantinedPaths).toEqual([A]);
    expect(readMergeQuarantine(db, A)?.failures).toBe(3); // 2 pre-seeded + 1 in-run
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("3"); // 1 + 2 successful chunks only

    // The formula is pinned via the OBSERVED ceiling, not a "2 not 3" literal (design §6 risk 1):
    // chunk 2's Check 1 ceiling = baseline + counterAtRunStart + successfulMerges + 1, and with
    // chunk 1 quarantined, successfulMerges = 0 at chunk 2 (NOT the loop index 1 the old formula used).
    const mergeCountAtChunk2 = 1 + 0 + 1;
    const expectedCeiling = baselineScore + mergeCountAtChunk2; // 15 — chunk 2's 16 heals DOWN to this
    // Observable on chunk 3's prompt (the 3rd LLM call): it carries chunk 2's HEALED output as the
    // existing summary. Under today's loop-index formula (1 + 1 + 1 = 3) the ceiling is 16 and the
    // raw 16 carries forward unhealed (RED).
    const chunk3Prompt = mockCompleteCalls()[2].promptText;
    expect(chunk3Prompt).toContain(`| Anchor | ${expectedCeiling} | 961 |`);
    expect(chunk3Prompt).not.toContain(`| Anchor | ${outputScore} | 961 |`);
    // The healed value stands in the final long_term (chunk 3's output 15 <= 15 + 3 = 18).
    const final = sqliteReadLongTerm(db)?.summary ?? "";
    expect(final).toContain(`| Anchor | ${expectedCeiling} | 961 |`);
  });

  it("multi-chunk summing: 2-chunk fold, chunk 1 audit fires a Check 1 clamp, chunk 2 audit fires a D2 raise → takeDriftEvents() after the fold reports ceilingClampedScores = 1 AND raisedScoresToAbsorbedSum = 1 (sum), not the last chunk's audit only", async () => {
    takeDriftEvents(); // drain residue — the accumulator is process-wide globalThis
    sqliteSetMeta(db, LT_META_COUNTER_KEY, "0"); // D4: Check 1 + the D2 sum heal need lt_meta_counter present (mergeCount 1 = 0 + 0 + 1)
    const empty = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
    const mk = (kd: string) => [kd, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
    const parts = "\n| 500-msg chunk windows | 3 | 900 |\n| Structured chunk output | 4 | 910 |";
    const header = `## Key Decisions\n| Item | Score | Last-Seen |\n|------|-------|-----------|`;
    const baseline = mk(`${header}\n| Anchor | 13 | 961 |${parts}`);
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks).toHaveLength(2);

    // Chunk 1: inflate Anchor 13 -> 20 (above its ceiling 13 + mergeCount 1 = 14 -> heal-down,
    // ceilingClampedScores +1); the D2-fixture-shape rows pass through unchanged.
    mockCompleteQueue(okTables(mk(`${header}\n| Anchor | 20 | 961 |${parts}`)));
    // Chunk 2 (carry-forward baseline = chunk 1's HEALED output): consolidate the two rows
    // (sum 7) into a survivor at score 5 -> D2 heal-up to 7 (raisedScoresToAbsorbedSum +1).
    mockCompleteQueue(okTables(mk(`${header}\n| Anchor | 14 | 961 |\n| Chunking: 500-msg windows with structured output | 5 | 963 |`)));
    const result = await runMergeFold(db, chunks, baseline, [], CONFIG);
    expect(result.processedChunks).toBe(2);

    // A7 (pin A7-c, Decision 1): the drain reports the FOLD TOTALS — both chunks' audits summed
    // per field. Under today's replace semantics only chunk 2's audit survives (ceilingClampedScores
    // would read 0 — the named RED).
    const totals = takeDriftEvents();
    expect(totals.ceilingClampedScores).toBe(1);        // chunk 1's clamp (chunk 2 fires none)
    expect(totals.raisedScoresToAbsorbedSum).toBe(1);   // chunk 2's D2 raise (chunk 1 fires none)

    // TRIANGULATE (drain reset): a second fold whose audit fires nothing reports fresh zeros —
    // cumulative-since-last-drain, not process-lifetime.
    insertUnmerged(db, A, CONTENT_A);
    const chunks2 = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks2).toHaveLength(1);
    const finalSummary = sqliteReadLongTerm(db)?.summary ?? "";
    mockCompleteQueue(okTables(finalSummary)); // byte-identical output -> no audit events
    await runMergeFold(db, chunks2, finalSummary, sqliteReadLongTerm(db)?.mergedSessions ?? [], CONFIG);
    expect(takeDriftEvents()).toEqual({ ceilingClampedScores: 0, raisedScoresToAbsorbedSum: 0, revertedLastSeenRewrites: 0, confirmedRemovals: 0, stalePrunedRows: 0, unmatchedVanishedRows: 0 });
  });

  it("no counter increment on validation failure/strike (meta keys byte-identical)", async () => {
    sqliteSetMeta(db, LT_META_COUNTER_KEY, "5");
    sqliteSetMeta(db, LT_META_LAST_RESTORED_ITEMS_KEY, "[]");
    insertUnmerged(db, A, CONTENT_A);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(invalidText()); // invalid first call...
    mockCompleteQueue(invalidText()); // ...and invalid in-loop retry -> null-text strike
    const result = await runMergeFold(db, chunks, tablesRow("Anchor row", 4, 950), [], CONFIG);
    expect(result.stoppedAtChunk).toBe(0);
    expect(result.processedChunks).toBe(0);
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("5");      // not incremented
    expect(sqliteGetMeta(db, LT_META_LAST_RESTORED_ITEMS_KEY)).toBe("[]");  // unchanged
    expect(unmergedRow(db, A)).toBe(CONTENT_A);                     // strike leaves the chunk unmerged
  });

  it("mark throws after the increment — increment stands, re-merge increments again", async () => {
    sqliteSetMeta(db, LT_META_COUNTER_KEY, "5");
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(okTables(tablesRow("O1", 1, 1)));
    mockCompleteQueue(okTables(tablesRow("O2", 1, 1)));

    let markCalls = 0;
    const io: MergeFoldIo = {
      mark: (d, paths) => {
        markCalls++;
        if (markCalls === 2) throw new Error("SQLITE_BUSY"); // mark for chunk 2
        sqliteMarkSessionSummariesMerged(d, paths);
      },
    };
    await expect(runMergeFold(db, chunks, "base", [], CONFIG, io)).rejects.toThrow("SQLITE_BUSY");
    // Chunk 2's write stood, so its increment stands too (write-then-mark semantics).
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("7");

    // Second run re-merges the remaining chunk (B) -> increments again (counts both completions).
    mockCompleteQueue(okTables(tablesRow("O3", 1, 1)));
    const remaining = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(remaining).toHaveLength(1);
    const result2 = await runMergeFold(db, remaining, sqliteReadLongTerm(db)?.summary ?? "", sqliteReadLongTerm(db)?.mergedSessions ?? [], CONFIG);
    expect(result2.processedChunks).toBe(1);
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("8");
    expect(unmergedRow(db, B)).toBeNull();
  });

  it("restored-row list persists at the write->mark site; a no-restore chunk replaces it with []", async () => {
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    expect(chunks).toHaveLength(2);

    // Chunk 1 output drops the baseline row -> D3 restore fires (age 0, not stale, empty lastRestoredItems).
    mockCompleteQueue(okTables(emptyTables()));
    // Chunk 2 keeps the restored row -> no restore -> restored-items list replaced with "[]".
    mockCompleteQueue(okTables(tablesRow("Old note", 4, 950)));

    const order: string[] = [];
    let restoredItemsAtFirstMark: string | null = null;
    let counterAtFirstMark: string | null = null;
    const io: MergeFoldIo = {
      write: (d, summary, n, merged) => { order.push("write"); sqliteWriteLongTerm(d, summary, n, merged); },
      mark: (d, paths) => {
        order.push("mark");
        if (restoredItemsAtFirstMark === null) {
          restoredItemsAtFirstMark = sqliteGetMeta(d, LT_META_LAST_RESTORED_ITEMS_KEY);
          counterAtFirstMark = sqliteGetMeta(d, LT_META_COUNTER_KEY);
        }
        sqliteMarkSessionSummariesMerged(d, paths);
      },
    };
    const result = await runMergeFold(db, chunks, tablesRow("Old note", 4, 950), [], CONFIG, io);
    expect(result.processedChunks).toBe(2);

    expect(order).toEqual(["write", "mark", "write", "mark"]);
    // BOTH meta writes strictly BETWEEN write and mark — restored-items list first, counter second.
    expect(restoredItemsAtFirstMark).toBe('["Old note"]');
    expect(counterAtFirstMark).toBe("1");
    // Chunk 2 (no restored items) REPLACES the lastRestoredItems list.
    expect(sqliteGetMeta(db, LT_META_LAST_RESTORED_ITEMS_KEY)).toBe("[]");
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("2");
  });

  it("healed text carries forward as chunk 2's baseline (13 -> 18 -> 14)", async () => {
    sqliteSetMeta(db, LT_META_COUNTER_KEY, "0");
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);

    // Chunk 1 inflates 13 -> 18; mergeCount = counterAtRunStart + successfulMerges + 1 = 0 + 0 + 1 = 1 -> healed to 14 (13 + 1).
    mockCompleteQueue(okTables(tablesRow("Subagent chunks 500", 18, 961)));
    // Chunk 2 output 15 -> 15 <= 14 + 2 (mergeCount 2) -> stands.
    mockCompleteQueue(okTables(tablesRow("Subagent chunks 500", 15, 961)));
    await runMergeFold(db, chunks, tablesRow("Subagent chunks 500", 13, 961), [], CONFIG);

    const carry = mockCompleteCalls()[1].promptText;
    expect(carry).toContain("| Subagent chunks 500 | 14 | 961 |"); // the HEALED text, not the raw 18
    expect(carry).not.toContain("| Subagent chunks 500 | 18 | 961 |");
    const final = sqliteReadLongTerm(db)?.summary ?? "";
    expect(final).toContain("| Subagent chunks 500 | 15 | 961 |");
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("2");
  });

  it("multi-chunk fold composition: counter 0 at run start, per-chunk ceilings compose (13 -> 14 -> 15)", async () => {
    insertUnmerged(db, A, CONTENT_A);
    insertUnmerged(db, B, CONTENT_B);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(okTables(tablesRow("Subagent chunks 500", 14, 961))); // 14 <= 13 + 1 (mergeCount 1) -> stands
    mockCompleteQueue(okTables(tablesRow("Subagent chunks 500", 15, 961))); // 15 <= 14 + 2 (mergeCount 2) -> stands
    await runMergeFold(db, chunks, tablesRow("Subagent chunks 500", 13, 961), [], CONFIG);
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("2");
    const final = sqliteReadLongTerm(db)?.summary ?? "";
    expect(final).toContain("| Subagent chunks 500 | 15 | 961 |"); // no heals — both outputs stood at their ceilings
  });

  it("P1 retry site: invalid then valid — the RETRY output is audited too ({ text, restoredItemTexts } shape)", async () => {
    mockCompleteQueue(invalidText());
    mockCompleteQueue(okTables(tablesRow("Audit me", 15, 961)));
    const result = await mergeLongTerm(tablesRow("Audit me", 13, 961), ["entry"], CONFIG);
    expect(result).toBeTypeOf("object");
    // Standalone default mergeCount 1: ceiling 13 + 1 = 14 -> the retry text is healed to 14.
    expect(result.text).toContain("| Audit me | 14 | 961 |");
    expect(result.text).not.toContain("| Audit me | 15 | 961 |");
    expect(result.restoredItemTexts).toEqual([]);
  });

  it("(triangulation) write-throw path writes NEITHER meta key", async () => {
    insertUnmerged(db, A, CONTENT_A);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue(okTables(tablesRow("O", 1, 1)));
    const io: MergeFoldIo = {
      write: () => { throw new Error("WRITE_BOOM"); },
    };
    await expect(runMergeFold(db, chunks, "base", [], CONFIG, io)).rejects.toThrow("WRITE_BOOM");
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBeNull();
    expect(sqliteGetMeta(db, LT_META_LAST_RESTORED_ITEMS_KEY)).toBeNull();
  });

  it("(triangulation) null-text strike path leaves both meta keys byte-identical", async () => {
    sqliteSetMeta(db, LT_META_COUNTER_KEY, "9");
    sqliteSetMeta(db, LT_META_LAST_RESTORED_ITEMS_KEY, '["keep me"]');
    insertUnmerged(db, A, CONTENT_A);
    const chunks = packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
    mockCompleteQueue({ content: [], stopReason: "error", errorMessage: "boom" });
    const result = await runMergeFold(db, chunks, "base", [], CONFIG);
    expect(result.stoppedAtChunk).toBe(0);
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("9");
    expect(sqliteGetMeta(db, LT_META_LAST_RESTORED_ITEMS_KEY)).toBe('["keep me"]');
  });
});

// ─── Error diagnostics (design §2.2 item 3 — mergeLongTerm direct) ─────

describe("mergeLongTerm error diagnostics", () => {
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vol.fromJSON({
      ["/test/sr-merge-fold/.pi/agent/models.json"]: JSON.stringify(MODELS_JSON),
      ["/test/sr-merge-fold/.pi/agent/.keep"]: "",
    });
    mockCompleteReset();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
    G.__sessionRecallLlmBusy__ = false;
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("stopReason=error returns null and logs errorMessage (+ chunk context when provided)", async () => {
    mockCompleteQueue({ content: [], stopReason: "error", errorMessage: "context length exceeded" });
    const result = await mergeLongTerm("s", ["e"], CONFIG, { chunkIndex: 2, firstSession: "sess-x.jsonl" });
    expect(result.text).toBeNull();
    expect(messages.join("\n")).toContain("context length exceeded");
    expect(messages.join("\n")).toContain("(chunk 2, first session sess-x.jsonl)");
  });

  it("stopReason=aborted includes errorMessage when present", async () => {
    mockCompleteQueue({ stopReason: "aborted", errorMessage: "request timed out" });
    const result = await mergeLongTerm("s", ["e"], CONFIG);
    expect(result.text).toBeNull();
    expect(messages.join("\n")).toContain("request timed out");
  });

  it("stopReason=aborted without errorMessage does not throw", async () => {
    mockCompleteQueue({ stopReason: "aborted" });
    const result = await mergeLongTerm("s", ["e"], CONFIG);
    expect(result.text).toBeNull();
    expect(messages.join("\n")).toContain("Merge LLM aborted");
  });
});

function unmergedRow(db: any, path: string): string | null {
  return (db.prepare("SELECT unmerged_fresh_content AS c FROM session_summaries WHERE session_path = ?").get(path) as { c: string | null } | undefined)?.c ?? null;
}

function packMergeFoldChunks(db: any): MergeChunk[] {
  return packMergeChunks(unmergedRows(db), CONFIG.mergeChunkChars);
}
