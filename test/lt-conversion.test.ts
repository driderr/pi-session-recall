import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { vol } from "memfs";
import * as logger from "../logger.js";
import {
  ensureSchema,
  sqliteReadLongTerm,
  sqliteWriteLongTerm,
  sqliteGetMeta,
  sqliteSetMeta,
  sqliteMarkSessionSummariesMerged,
  sqliteReadUnmergedSessionSummaries,
  LT_TABLE_CONVERSION_FLAG_KEY,
  LT_TABLE_CONVERSION_BACKUP_KEY,
  LT_META_COUNTER_KEY,
  LT_META_LAST_RESTORED_ITEMS_KEY,
  buildConversionPrompt,
  convertProseToTables,
  productionConversionLlmCall,
  runLtTableConversion,
  runMergeFold,
  packMergeChunks,
  validateTableSummary,
} from "../summarizer.js";
import type { ConvertProseResult, LtConversionOutcome, LlmTextCall } from "../summarizer.js";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";
import { G } from "../types.js";
import { mockCompleteReset, mockCompleteQueue, mockCompleteCalls } from "@earendil-works/pi-ai";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// Unique per-file memfs homedir (avoids cross-file memfs collisions).
vi.mock("node:os", () => ({ homedir: () => "/test/sr-lt-conversion" }));
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

const CONFIG: SessionRecallConfig = { ...DEFAULT_CONFIG };

/** Prose long-term summary (no `## ` pinned headers → parseScoreTables.parseable === false). */
const PROSE = [
  "Long-term prose summary.",
  "- VCC merge (score: 4)",
  "- Chunked fold (4:2)",
  "- Plain item with no score suffix",
].join("\n");

function validTables(label: string, score = 4, lastSeen = 42): string {
  const empty = (name: string) => `## ${name}\n\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
  const first = `## Key Decisions\n\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| ${label} | ${score} | ${lastSeen} |`;
  return [first, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
}

const INVALID_TEXT = "Not a table at all — plain garbage prose.";

function okResp(text: string): { content: Array<{ type: string; text: string }>; stopReason: string } {
  return { content: [{ type: "text", text }], stopReason: "stop" };
}

function createDb(): any {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function seedModels(): void {
  vol.fromJSON({ ["/test/sr-lt-conversion/.pi/agent/models.json"]: JSON.stringify(MODELS_JSON) });
}

function seedProseLongTerm(db: any, sessionCount = 42, mergedSessions = ["h1", "h2"]): void {
  sqliteWriteLongTerm(db, PROSE, sessionCount, mergedSessions);
}

function seedUnmerged(db: any, path: string, content: string, mergeCount: number, tsIso: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO session_summaries " +
      "(session_path, version, summary, char_count, merge_count, updated_at) " +
      "VALUES (?, 1, ?, ?, ?, ?)",
  ).run(path, content, content.length, mergeCount, tsIso);
  db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run(content, path);
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockCompleteReset();
  G.__sessionRecallLlmBusy__ = false;
  logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

// ─── convertProseToTables (pure-ish runner, injected llmCall — no DB) ───

describe("convertProseToTables (injected llmCall)", () => {
  it("valid first response → 1 LLM call, ok", async () => {
    const prompts: string[] = [];
    const llmCall: LlmTextCall = async (prompt) => { prompts.push(prompt); return validTables("converted"); };
    const res: ConvertProseResult = await convertProseToTables(PROSE, 42, llmCall, CONFIG);
    expect(res.ok).toBe(true);
    expect(res.text).toBe(validTables("converted"));
    expect(res.llmCalls).toBe(1);
    expect(prompts).toHaveLength(1);
  });

  it("invalid then valid → 2 calls with the SAME prompt, ok, second text wins", async () => {
    const prompts: string[] = [];
    let n = 0;
    const llmCall: LlmTextCall = async (prompt) => {
      prompts.push(prompt);
      n++;
      return n === 1 ? INVALID_TEXT : validTables("recovered");
    };
    const res = await convertProseToTables(PROSE, 42, llmCall, CONFIG);
    expect(res.ok).toBe(true);
    expect(res.text).toBe(validTables("recovered"));
    expect(res.llmCalls).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toBe(prompts[1]); // in-loop retry, same prompt
  });

  it("invalid twice → exactly 2 calls, fail with the 2nd rejection reason", async () => {
    const llmCall: LlmTextCall = async () => INVALID_TEXT;
    const res = await convertProseToTables(PROSE, 42, llmCall, CONFIG);
    expect(res.ok).toBe(false);
    expect(res.text).toBeNull();
    expect(res.llmCalls).toBe(2);
    expect(res.reason).toBeTruthy();
  });

  it("llm returns null → 'llm call returned no text', 1 call", async () => {
    const llmCall: LlmTextCall = async () => null;
    const res = await convertProseToTables(PROSE, 42, llmCall, CONFIG);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("llm call returned no text");
    expect(res.llmCalls).toBe(1);
  });

  it("(triangulation) invalid then null → 2 calls, fail with no-text reason", async () => {
    let n = 0;
    const llmCall: LlmTextCall = async () => { n++; return n === 1 ? INVALID_TEXT : null; };
    const res = await convertProseToTables(PROSE, 42, llmCall, CONFIG);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("llm call returned no text");
    expect(res.llmCalls).toBe(2);
  });
});

// ─── buildConversionPrompt (pin D — prompt half) ───

describe("buildConversionPrompt", () => {
  it("contains the full summary text and score-preservation instructions", () => {
    const prompt = buildConversionPrompt(PROSE, 42);
    expect(prompt).toContain(PROSE);                    // full stored prose, verbatim
    expect(prompt).toContain("(score: N)");             // modern suffix form
    expect(prompt).toContain("(N:x)");                  // legacy suffix form
    expect(prompt).toContain("Score 1");                // no-suffix default
    expect(prompt).toContain("Last-Seen to 42");        // live session count
  });
});

// ─── productionConversionLlmCall (real complete() via the recording mock) ───

describe("productionConversionLlmCall", () => {
  it("forwards the prompt to complete() and returns the text", async () => {
    seedModels();
    mockCompleteQueue(okResp("converted-tables-text"));
    const res = await productionConversionLlmCall("the-conversion-prompt", CONFIG);
    expect(res).toBe("converted-tables-text");
    expect(mockCompleteCalls()).toHaveLength(1);
    expect(mockCompleteCalls()[0].promptText).toBe("the-conversion-prompt");
  });

  it("stopReason=error → null", async () => {
    seedModels();
    mockCompleteQueue({ content: [], stopReason: "error", errorMessage: "boom" });
    const res = await productionConversionLlmCall("p", CONFIG);
    expect(res).toBeNull();
  });

  it("empty text → null", async () => {
    seedModels();
    mockCompleteQueue({ content: [], stopReason: "stop" });
    const res = await productionConversionLlmCall("p", CONFIG);
    expect(res).toBeNull();
  });

  it("no model config → null (no complete() call)", async () => {
    // memfs vol is reset in setup beforeEach — no models.json here
    const res = await productionConversionLlmCall("p", CONFIG);
    expect(res).toBeNull();
    expect(mockCompleteCalls()).toHaveLength(0);
  });
});

// ─── runLtTableConversion (gates + writes; in-memory DB) ───

describe("runLtTableConversion (gates + writes)", () => {
  let db: any;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it("Gate triggers conversion: prose + no flag → ran, 1 LLM call, flag set, backup + replacement", async () => {
    seedModels();
    seedProseLongTerm(db);
    const converted = validTables("CONVERTED");
    mockCompleteQueue(okResp(converted));

    const longTerm = sqliteReadLongTerm(db);
    const outcome: LtConversionOutcome = await runLtTableConversion(db, longTerm, CONFIG);

    expect(outcome.ran).toBe(true);
    expect(outcome.converted).toBe(converted);
    expect(outcome.skippedReason).toBeNull();
    expect(mockCompleteCalls()).toHaveLength(1);

    // Flag set (ISO value), backup byte-identical to the old prose
    const flag = sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY);
    expect(flag).toBeTruthy();
    expect(Number.isNaN(Date.parse(flag!))).toBe(false);
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_BACKUP_KEY)).toBe(PROSE);

    // Summary replaced; session_count + merged_sessions unchanged (conversion is not a merge)
    const after = sqliteReadLongTerm(db);
    expect(after?.summary).toBe(converted);
    expect(after?.sessionCount).toBe(42);
    expect(after?.mergedSessions).toEqual(["h1", "h2"]);
    expect(validateTableSummary(after!.summary, CONFIG).ok).toBe(true);
  });

  it("Flag set skips conversion (idempotent) — 0 LLM calls", async () => {
    seedModels();
    seedProseLongTerm(db);
    sqliteSetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY, "2026-01-01T00:00:00.000Z");

    const outcome = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);

    expect(outcome.ran).toBe(false);
    expect(outcome.converted).toBeNull();
    expect(outcome.skippedReason).toBe("flag-set");
    expect(mockCompleteCalls()).toHaveLength(0);
    expect(sqliteReadLongTerm(db)?.summary).toBe(PROSE); // untouched
  });

  it("Table summary skips conversion ('already-tables') — 0 LLM calls", async () => {
    seedModels();
    sqliteWriteLongTerm(db, validTables("STORED"), 10, ["h"]);

    const outcome = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);

    expect(outcome.skippedReason).toBe("already-tables");
    expect(outcome.ran).toBe(false);
    expect(mockCompleteCalls()).toHaveLength(0);
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeNull();
  });

  it("no stored summary → 'no-stored-summary', 0 LLM calls", async () => {
    seedModels();
    const outcome = await runLtTableConversion(db, null, CONFIG);
    expect(outcome.skippedReason).toBe("no-stored-summary");
    expect(outcome.ran).toBe(false);
    expect(mockCompleteCalls()).toHaveLength(0);
  });

  it("(triangulation) llm-busy flag held → 'llm-busy', 0 LLM calls, nothing written", async () => {
    seedModels();
    seedProseLongTerm(db);
    G.__sessionRecallLlmBusy__ = true;

    const outcome = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);

    expect(outcome.skippedReason).toBe("llm-busy");
    expect(outcome.ran).toBe(false);
    expect(mockCompleteCalls()).toHaveLength(0);
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeNull();
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_BACKUP_KEY)).toBeNull();
    expect(sqliteReadLongTerm(db)?.summary).toBe(PROSE);
  });

  it("Failure (both calls invalid) → no write, no flag, no backup; second run re-runs the LLM", async () => {
    seedModels();
    seedProseLongTerm(db);
    mockCompleteQueue(okResp(INVALID_TEXT));
    mockCompleteQueue(okResp(INVALID_TEXT));

    const first = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);
    expect(first.ran).toBe(true);
    expect(first.converted).toBeNull();
    expect(first.skippedReason).toBeTruthy();
    expect(mockCompleteCalls()).toHaveLength(2);
    expect(sqliteReadLongTerm(db)?.summary).toBe(PROSE);      // summary bytes unchanged
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeNull();
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_BACKUP_KEY)).toBeNull();

    // Retry next run: queue one valid response — the LLM is called again and it succeeds
    mockCompleteQueue(okResp(validTables("RETRIED")));
    const second = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);
    expect(second.ran).toBe(true);
    expect(second.converted).toBe(validTables("RETRIED"));
    expect(mockCompleteCalls()).toHaveLength(3);
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeTruthy();
  });

  it("LLM returns no text → 'llm call returned no text', no write, no flag", async () => {
    seedModels();
    seedProseLongTerm(db);
    mockCompleteQueue({ content: [], stopReason: "stop" });

    const outcome = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);

    expect(outcome.ran).toBe(true);
    expect(outcome.converted).toBeNull();
    expect(outcome.skippedReason).toBe("llm call returned no text");
    expect(mockCompleteCalls()).toHaveLength(1);
    expect(sqliteReadLongTerm(db)?.summary).toBe(PROSE);
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeNull();
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_BACKUP_KEY)).toBeNull();
  });

  it("Production retry path: invalid then valid through runLtTableConversion → 2 LLM calls, success", async () => {
    seedModels();
    seedProseLongTerm(db);
    mockCompleteQueue(okResp(INVALID_TEXT));
    mockCompleteQueue(okResp(validTables("PRODUCTION-RETRY")));

    const outcome = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);

    expect(outcome.ran).toBe(true);
    expect(outcome.converted).toBe(validTables("PRODUCTION-RETRY"));
    expect(mockCompleteCalls()).toHaveLength(2);
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeTruthy();
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_BACKUP_KEY)).toBe(PROSE);
  });

  it("Both score formats preserved (LLM-behavior half — documents the prompt contract)", async () => {
    seedModels();
    seedProseLongTerm(db);
    const preserved = [
      "## Key Decisions",
      "",
      "| Item | Score | Last-Seen |",
      "|------|-------|-----------|",
      "| VCC merge | 4 | 42 |",      // from "(score: 4)"
      "| Chunked fold | 4 | 42 |",   // from legacy "(4:2)"
      "| Plain item with no score suffix | 1 | 42 |", // no suffix → Score 1
    ].join("\n");
    const empty = (name: string) => `## ${name}\n\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
    const full = [preserved, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
    mockCompleteQueue(okResp(full));

    const outcome = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);

    expect(outcome.converted).toBe(full);
    expect(outcome.converted).toContain("| VCC merge | 4 | 42 |");
    expect(outcome.converted).toContain("| Chunked fold | 4 | 42 |");
    expect(outcome.converted).toContain("| Plain item with no score suffix | 1 | 42 |");
  });
  it("Successful conversion initializes the audit state (counter 0, restored items []); the fold's first merge audits at mergeCount 1", async () => {
    seedModels();
    seedProseLongTerm(db);
    const converted = validTables("Converted row", 13, 961);
    mockCompleteQueue(okResp(converted));
    const outcome = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);
    expect(outcome.ran).toBe(true);
    expect(outcome.converted).toBe(converted);

    // Audit state initialized alongside the flag (design §3.3 pinned order: inits BEFORE the flag).
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeTruthy();
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("0");
    expect(sqliteGetMeta(db, LT_META_LAST_RESTORED_ITEMS_KEY)).toBe("[]");

    // The fold's first merge: counter 0 at run start -> mergeCount = 0 + 0 + 1 = 1.
    seedUnmerged(db, "/session/F.jsonl", "Fresh fold content", 10, "2026-01-02T00:00:00.000Z");
    const chunks = packMergeChunks(
      sqliteReadUnmergedSessionSummaries(db).map((r) => ({ session_path: r.session_path, unmerged_fresh_content: r.unmerged_fresh_content })),
      CONFIG.mergeChunkChars,
    );
    expect(chunks).toHaveLength(1);
    // LLM inflates 13 -> 18; the mergeCount-1 ceiling (13 + 1) heals it to 14.
    mockCompleteQueue(okResp(validTables("Converted row", 18, 961)));
    const fold = await runMergeFold(db, chunks, converted, ["h1", "h2"], CONFIG);
    expect(fold.processedChunks).toBe(1);
    const final = sqliteReadLongTerm(db)?.summary ?? "";
    expect(final).toContain("| Converted row | 14 | 961 |");
    expect(final).not.toContain("| Converted row | 18 | 961 |");
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("1");
  });

  it("Pre-change table install without a counter hits the D4 skip edge (first chunk unchecked; counter starts at 1)", async () => {
    seedModels();
    // Table summary installed before this change: parseable, no flag, no counter.
    sqliteWriteLongTerm(db, validTables("STORED-ROW"), 10, ["h"]);
    const outcome = await runLtTableConversion(db, sqliteReadLongTerm(db), CONFIG);
    expect(outcome.skippedReason).toBe("already-tables");
    expect(outcome.ran).toBe(false);
    expect(mockCompleteCalls()).toHaveLength(0);
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBeNull();

    seedUnmerged(db, "/session/D.jsonl", "Fresh D4 content", 10, "2026-01-03T00:00:00.000Z");
    const chunks = packMergeChunks(
      sqliteReadUnmergedSessionSummaries(db).map((r) => ({ session_path: r.session_path, unmerged_fresh_content: r.unmerged_fresh_content })),
      CONFIG.mergeChunkChars,
    );
    expect(chunks).toHaveLength(1);
    // D4: counter absent for this chunk -> Check 1 disabled -> 4 -> 10 is NOT healed (ceiling would be 5).
    mockCompleteQueue(okResp(validTables("STORED-ROW", 10, 42)));
    const fold = await runMergeFold(db, chunks, sqliteReadLongTerm(db)!.summary, ["h"], CONFIG);
    expect(fold.processedChunks).toBe(1);
    const final = sqliteReadLongTerm(db)?.summary ?? "";
    expect(final).toContain("| STORED-ROW | 10 | 42 |"); // stood — no ceiling heal (D4 skip)
    expect(sqliteGetMeta(db, LT_META_COUNTER_KEY)).toBe("1"); // counter starts counting at this chunk's write
  });
});

// ─── Backup clear (merge half) — first successful table merge clears the backup ───

describe("backup clear on first successful table merge (pin P2 / §5.4)", () => {
  it("runMergeFold clears lt_table_conversion_backup between write and mark", async () => {
    seedModels();
    const db = createDb();
    try {
      seedUnmerged(db, "/session/M.jsonl", "Fresh merge content", 10, "2026-01-01T00:00:00.000Z");
      const chunks = packMergeChunks(
        sqliteReadUnmergedSessionSummaries(db).map((r) => ({ session_path: r.session_path, unmerged_fresh_content: r.unmerged_fresh_content })),
        CONFIG.mergeChunkChars,
      );
      expect(chunks).toHaveLength(1);

      // Seed the conversion backup — the fold's first successful write must clear it
      sqliteSetMeta(db, LT_TABLE_CONVERSION_BACKUP_KEY, "old-prose-backup");

      // Record the backup state AT the write and mark moments (clear runs in between)
      const order: string[] = [];
      const io = {
        write: (d: any, s: string, sc: number, ms: string[]) => {
          order.push("write:" + (sqliteGetMeta(d, LT_TABLE_CONVERSION_BACKUP_KEY) !== null ? "backup-present" : "backup-cleared"));
          sqliteWriteLongTerm(d, s, sc, ms);
        },
        mark: (d: any, paths: string[]) => {
          order.push("mark:" + (sqliteGetMeta(d, LT_TABLE_CONVERSION_BACKUP_KEY) !== null ? "backup-present" : "backup-cleared"));
          sqliteMarkSessionSummariesMerged(d, paths);
        },
      };
      mockCompleteQueue(okResp(validTables("MERGED-TABLES")));

      const result = await runMergeFold(db, chunks, PROSE, ["h-baseline"], CONFIG, io);

      expect(result.processedChunks).toBe(1);
      expect(order).toEqual(["write:backup-present", "mark:backup-cleared"]);
      expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_BACKUP_KEY)).toBeNull();
    } finally {
      db.close();
    }
  });

  it("no backup key present → fold write is an unaffected no-op clear", async () => {
    seedModels();
    const db = createDb();
    try {
      seedUnmerged(db, "/session/N.jsonl", "Fresh content", 10, "2026-01-01T00:00:00.000Z");
      const chunks = packMergeChunks(
        sqliteReadUnmergedSessionSummaries(db).map((r) => ({ session_path: r.session_path, unmerged_fresh_content: r.unmerged_fresh_content })),
        CONFIG.mergeChunkChars,
      );
      mockCompleteQueue(okResp(validTables("MERGED-2")));
      const result = await runMergeFold(db, chunks, PROSE, [], CONFIG);
      expect(result.processedChunks).toBe(1);
      expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_BACKUP_KEY)).toBeNull();
    } finally {
      db.close();
    }
  });
});
