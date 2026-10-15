// rowstore-merge.test.ts — rowstore-merge C3 (re-keyed by C3.5, rowstore-lessons):
// the C3.5 engine's re-keyed C3 fixtures (g5 sessionCount / g9 cap — now
// EXTRACT-call slots / g10 decision bytes + the enrich= token / the config
// surface) + the shared-extraction regression units (T3, design §12.3) + the
// extractKeySignals parity units (T1 group 11, design §6). The C3 per-signal
// engine scenarios (old g1–g4, g6–g8) are SUPERSEDED by the EXTRACT-first
// engine — they live in test/rowstore-lessons.test.ts (the boundary rule,
// C3.5 design §6).
// (2026-08-29: one-line re-stage to mint a fresh bounded-review lineage for the C3 close-out.)
//
// Strict TDD: this file starts RED against the not-yet-existing exports
// (llmCallOnce / buildMergeModelPair / extractKeySignals from summarizer.js; later
// mergeSignalsIntoRowStore + types + ROWSTORE_MERGE_LLM_TIMEOUT_MS from rowstore.js)
// and goes GREEN as design §5/§6/§1 land. The standing legacy guard (the
// merge-fold / merge-timeout byte-pins) stays green throughout.
//
// House mechanics (design §12): in-memory better-sqlite3 via createRequire (no temp
// files); vi.spyOn(logger, "log") for ALL log byte-asserts (the logger no-ops in a
// vitest context); memfs homedir for the T3 model-discovery units (unique per file —
// no cross-file collisions). No HTTP in the unit suite — every seam is injected
// (embed / llmCall / nowMs / sessionCountOverride).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { vol } from "memfs";
import * as logger from "../logger.js";
import { DEFAULT_CONFIG, loadConfig, type SessionRecallConfig } from "../config.js";
import {
  ensureSchema,
  extractKeySignals,
  buildMergeModelPair,
  llmCallOnce,
  getLlmStats,
  readMergeQuarantine,
} from "../summarizer.js";
import {
  ensureRowStoreSchema,
  getRows,
  mergeSignalsIntoRowStore,
  ROWSTORE_MERGE_LLM_TIMEOUT_MS,
  type RowStoreMergeOptions,
  type RowStoreMergeResult,
} from "../rowstore.js";
import {
  mockCompleteReset,
  mockCompleteQueue,
  mockCompleteCalls,
} from "@earendil-works/pi-ai";

// Unique per-file memfs homedir (avoids cross-file memfs collisions).
const HOMEDIR = "/test/sr-rowstore-merge";

vi.mock("node:os", () => ({ homedir: () => "/test/sr-rowstore-merge" })); // inlined: the factory is hoisted above HOMEDIR
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

// ─── Shared mechanics (design §12.1 seams; the engine units reuse these) ────────

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function createDb(): any {
  const db = new Database(":memory:");
  ensureSchema(db);         // session_summaries + long_term + meta (legacy schema)
  ensureRowStoreSchema(db); // long_term_rows (C2 DDL, self-ensure)
  return db;
}

/** Deterministic fake VCC signal content: a [Key Signals] block, one bullet per entry. */
function fakeSignalContent(entries: Array<{ prefix: "Constraint" | "Decision" | "Status"; text: string }>): string {
  return ["[Key Signals]", ...entries.map(e => `- ${e.prefix}: ${e.text}`)].join("\n");
}

function seedSession(db: any, path: string, content: string, mergeCount: number, updatedAt: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO session_summaries " +
    "(session_path, version, summary, char_count, merge_count, updated_at) VALUES (?, 1, ?, ?, ?, ?)",
  ).run(path, content, content.length, mergeCount, updatedAt);
  db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run(content, path);
}

/** 768-dim unit vector with 1.0 at dimension `idx`. */
function unitVec(dim: number, idx: number): number[] {
  const v = new Array<number>(dim).fill(0);
  v[idx] = 1;
  return v;
}

/** Query vector whose cosine against unitVec(dim, i) is EXACTLY sims[i]: the sims sit
 *  on dimensions 0..n-1 and the remainder on dimension dim-1 (unit-norm query). */
function makeQueryVector(sims: number[], dim = 768): number[] {
  const sq = sims.reduce((s, x) => s + x * x, 0);
  if (sq > 1) throw new Error(`sim set cannot be embedded in a unit vector (sq=${sq})`);
  const v = new Array<number>(dim).fill(0);
  sims.forEach((s, i) => { v[i] = s; });
  v[dim - 1] = Math.sqrt(Math.max(0, 1 - sq));
  return v;
}

function configFor(overrides: Partial<SessionRecallConfig> = {}): SessionRecallConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/** Full ordered long_term_rows snapshot — the byte-equality guard for the
 *  adversarial-rowId tests (nothing may write the store from a rejected decision). */
function tableSnapshot(db: any): any[] {
  return db.prepare("SELECT id, item, score, last_seen, embedding FROM long_term_rows ORDER BY id ASC").all();
}

// ─── T3 — the shared callOnce extraction (design §12.3; P5 value-preservation) ──

const MODELS_JSON_NONE = {
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

// Legacy-equivalent options: the exact values the mergeLongTerm closure captured
// today (small timeoutMs for the unit; the exact chunkCtx string; summariesCount;
// maxRetries = MAX_RETRIES = 2) — the substitution must be value-preserving (P5).
const CHUNK_CTX = " (chunk 2, first session 2026-01-02T03-04-05-session.jsonl)";
const LEGACY_OPTS = { timeoutMs: 50, logContext: CHUNK_CTX, summariesCount: 5, maxRetries: 2 };

function seedModels(apiKey: string): void {
  vol.fromJSON({ [`${HOMEDIR}/.pi/agent/models.json`]: JSON.stringify({ ...MODELS_JSON_NONE, providers: { local: { ...MODELS_JSON_NONE.providers.local, apiKey } } }) });
}

describe("llmCallOnce — legacy byte equivalence per stopReason branch (T3, P5)", () => {
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let pair: { modelObj: any; apiKey: string };

  beforeEach(() => {
    seedModels("none");
    mockCompleteReset();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
    pair = buildMergeModelPair()!;
  });
  afterEach(() => { logSpy.mockRestore(); });

  it("stopReason=error → null + the exact legacy error byte", async () => {
    mockCompleteQueue({ content: [], stopReason: "error", errorMessage: "boom" });
    const res = await llmCallOnce(pair.modelObj, pair.apiKey, "P-ERR", 0, LEGACY_OPTS);
    expect(res).toEqual({ text: null, retryableTransient: false });
    expect(mockCompleteCalls()).toHaveLength(1);
    expect(messages[0]).toMatch(/^Merge raw: stopReason=error, textParts=0, thinkingParts=0, latency=\d+ms$/);
    expect(messages[1]).toMatch(/^Merge LLM stopReason=error: boom \(chunk 2, first session 2026-01-02T03-04-05-session\.jsonl\) summaries=5 latency=\d+ms$/);
    expect(messages).toHaveLength(2);
  });

  it("stopReason=aborted (no errorMessage) → null + the exact legacy aborted byte", async () => {
    mockCompleteQueue({ content: [], stopReason: "aborted" });
    const res = await llmCallOnce(pair.modelObj, pair.apiKey, "P-ABORT", 0, LEGACY_OPTS);
    expect(res).toEqual({ text: null, retryableTransient: false });
    expect(messages[0]).toMatch(/^Merge raw: stopReason=aborted, textParts=0, thinkingParts=0, latency=\d+ms$/);
    expect(messages[1].startsWith(`Merge LLM aborted: summaries=5 latency=`)).toBe(true);
    expect(messages[1].endsWith("ms (llama.cpp rejected or timed out)")).toBe(true);
    expect(messages).toHaveLength(2);
  });

  it("stopReason=aborted (with errorMessage) → the message is joined with one space", async () => {
    mockCompleteQueue({ content: [], stopReason: "aborted", errorMessage: "llama.cpp rejected" });
    await llmCallOnce(pair.modelObj, pair.apiKey, "P-ABORT2", 0, LEGACY_OPTS);
    expect(messages[1].startsWith(`Merge LLM aborted: llama.cpp rejected summaries=5 latency=`)).toBe(true);
  });

  it("stopReason=length → null + the exact legacy token-limit byte", async () => {
    mockCompleteQueue({ content: [], stopReason: "length" });
    const res = await llmCallOnce(pair.modelObj, pair.apiKey, "P-LEN", 0, LEGACY_OPTS);
    expect(res).toEqual({ text: null, retryableTransient: false });
    expect(messages[1].startsWith(`Merge LLM hit token limit (truncated): summaries=5 latency=`)).toBe(true);
    expect(messages[1].endsWith("ms")).toBe(true);
    expect(messages).toHaveLength(2);
  });

  it("non-array content → null + the exact legacy non-array byte", async () => {
    // A non-array that SURVIVES the legacy textParts `.filter` probe (a bare string/number
    // would throw TypeError first — caught, not the defensive branch) and then hits the
    // `!Array.isArray` guard: the true legacy bytes for this branch (P5 verbatim).
    mockCompleteQueue({ content: { filter: () => [] }, stopReason: "stop" });
    const res = await llmCallOnce(pair.modelObj, pair.apiKey, "P-NONARR", 0, LEGACY_OPTS);
    expect(res).toEqual({ text: null, retryableTransient: false });
    expect(messages[0]).toMatch(/^Merge raw: stopReason=stop, textParts=0, thinkingParts=0, latency=\d+ms$/);
    expect(messages[1]).toBe("Merge LLM: non-array content (type=object)");
    expect(messages).toHaveLength(2);
  });

  it("empty text (whitespace only) → null + the exact legacy no-text byte", async () => {
    mockCompleteQueue({ content: [{ type: "text", text: "   " }], stopReason: "stop" });
    const res = await llmCallOnce(pair.modelObj, pair.apiKey, "P-EMPTY", 0, LEGACY_OPTS);
    expect(res).toEqual({ text: null, retryableTransient: false });
    expect(messages[0]).toMatch(/^Merge raw: stopReason=stop, textParts=1, thinkingParts=0, latency=\d+ms$/);
    expect(messages[1].startsWith(`Merge LLM returned no text: summaries=5 stopReason=stop latency=`)).toBe(true);
    expect(messages[1].endsWith("ms")).toBe(true);
    expect(messages).toHaveLength(2);
  });

  it("success → the text + the exact legacy response byte + the R1 call shape", async () => {
    mockCompleteQueue({ content: [{ type: "text", text: "HELLO" }, { type: "thinking", thinking: "t" }], stopReason: "stop" });
    const res = await llmCallOnce(pair.modelObj, pair.apiKey, "P-OK", 0, LEGACY_OPTS);
    expect(res).toEqual({ text: "HELLO", retryableTransient: false });
    const calls = mockCompleteCalls();
    expect(calls).toHaveLength(1);
    // The R1 model object goes to complete() by IDENTITY — the same shape mergeLongTerm used;
    // the pre-resolved apiKey lands in options (real key vs "sk-none" — here "sk-none").
    expect(calls[0].model).toBe(pair.modelObj);
    expect(calls[0].options.apiKey).toBe("sk-none");
    expect(calls[0].options.reasoningEffort).toBe("low");
    expect(calls[0].options).not.toHaveProperty("maxTokens");
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].promptText).toBe("P-OK");
    expect(messages[0]).toMatch(/^Merge raw: stopReason=stop, textParts=1, thinkingParts=1, latency=\d+ms$/);
    expect(messages[1].startsWith("Merge LLM response (5 chars, 5 summaries merged, ")).toBe(true);
    expect(messages[1].endsWith("ms)")).toBe(true);
    expect(messages).toHaveLength(2);
  });

  it("transient throw with retries remaining (attempt 0 < maxRetries 2) → retryableTransient", async () => {
    mockCompleteQueue(async () => { throw new Error("ECONNREFUSED"); });
    const res = await llmCallOnce(pair.modelObj, pair.apiKey, "P-TRANS", 0, LEGACY_OPTS);
    expect(res).toEqual({ text: null, retryableTransient: true });
    expect(messages).toEqual([`Merge LLM transient error (attempt 1/2): Error: ECONNREFUSED`]);
  });

  it("transient throw at the final attempt (attempt 2 = maxRetries) → definitive", async () => {
    mockCompleteQueue(async () => { throw new Error("ECONNREFUSED"); });
    const res = await llmCallOnce(pair.modelObj, pair.apiKey, "P-TRANS-FINAL", 2, LEGACY_OPTS);
    expect(res).toEqual({ text: null, retryableTransient: false });
    expect(messages).toEqual([`Merge LLM error: summaries=5 Error: ECONNREFUSED`]);
  });

  it("non-transient throw → definitive on the first attempt", async () => {
    mockCompleteQueue(async () => { throw new Error("boom"); });
    const res = await llmCallOnce(pair.modelObj, pair.apiKey, "P-DEF", 0, LEGACY_OPTS);
    expect(res).toEqual({ text: null, retryableTransient: false });
    expect(messages).toEqual([`Merge LLM error: summaries=5 Error: boom`]);
  });
});

describe("llmCallOnce — LLM stats: every model attempt is counted (the /recall-health counter; the row-store leg and the legacy leg share this choke point — the counter lived in mergeLongTerm only and read 0 permanently in ROWSTORE mode; moved to llmCallOnce 2026-09-05)", () => {
  let pair: { modelObj: any; apiKey: string };

  beforeEach(() => {
    seedModels("none");
    mockCompleteReset();
    pair = buildMergeModelPair()!;
  });

  it("success attempt → calls=1 ok=1 last=success + latency recorded", async () => {
    mockCompleteQueue({ content: [{ type: "text", text: "hello" }], stopReason: "stop" });
    await llmCallOnce(pair.modelObj, pair.apiKey, "P-STAT-OK", 0, LEGACY_OPTS);
    const s = getLlmStats();
    expect(s.calls).toBe(1);
    expect(s.successes).toBe(1);
    expect(s.failures).toBe(0);
    expect(s.lastResult).toBe("success");
    expect(s.lastLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("no-text attempt (thinking only — the 2026-09-02 failure signature) → a counted failure, last=empty/skipped", async () => {
    mockCompleteQueue({ content: [{ type: "thinking", text: "..." }], stopReason: "stop" });
    await llmCallOnce(pair.modelObj, pair.apiKey, "P-STAT-EMPTY", 0, LEGACY_OPTS);
    const s = getLlmStats();
    expect(s.calls).toBe(1);
    expect(s.successes).toBe(0);
    expect(s.failures).toBe(1);
    expect(s.lastResult).toBe("empty/skipped");
  });

  it("attempts accumulate across calls (per-attempt semantics, both legs): error then success → calls=2 ok=1 fail=1 last=success", async () => {
    mockCompleteQueue({ content: [], stopReason: "error", errorMessage: "boom" });
    mockCompleteQueue({ content: [{ type: "text", text: "ok" }], stopReason: "stop" });
    await llmCallOnce(pair.modelObj, pair.apiKey, "P-STAT-E1", 0, LEGACY_OPTS);
    await llmCallOnce(pair.modelObj, pair.apiKey, "P-STAT-E2", 0, LEGACY_OPTS);
    const s = getLlmStats();
    expect(s.calls).toBe(2);
    expect(s.successes).toBe(1);
    expect(s.failures).toBe(1);
    expect(s.lastResult).toBe("success");
  });
});

describe("buildMergeModelPair — the R1 construction + apiKey resolution (T3 shape unit)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); });

  it("R1 shape verbatim: reasoning true + qwen-chat-template compat; apiKey \"none\" → \"sk-none\"", () => {
    seedModels("none");
    const pair = buildMergeModelPair()!;
    expect(pair.modelObj).toEqual({
      provider: "local",
      id: "test-model",
      name: "Test",
      api: "openai-completions",
      baseUrl: "http://localhost:5001/v1",
      reasoning: true,
      compat: { thinkingFormat: "qwen-chat-template" },
      input: ["text"],
      maxTokens: 8000,
      contextWindow: 256000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(pair.apiKey).toBe("sk-none");
  });

  it("a real apiKey passes through unchanged", () => {
    seedModels("sk-real-123");
    expect(buildMergeModelPair()!.apiKey).toBe("sk-real-123");
  });
});

// ─── T1 group 11 — extractKeySignals parity (the design §6 function, direct units) ──

describe("extractKeySignals — block-aware Key Signals extraction (T1 group 11)", () => {
  it("only the [Key Signals] block counts — other blocks and separators are ignored", () => {
    const content = [
      "[Brief Transcript]",
      "- Decision: leaked-from-transcript",
      "---",
      "[Key Signals]",
      "- Decision: keep-me",
      "plain line that is not a bullet",
      "- no-prefix-line",
    ].join("\n");
    expect(extractKeySignals(content)).toEqual(["keep-me"]);
  });

  it("prefix strip — Constraint/Decision/Status all yield the bare text", () => {
    const content = ["[Key Signals]", "- Constraint: A", "- Decision: B", "- Status: C"].join("\n");
    expect(extractKeySignals(content)).toEqual(["A", "B", "C"]);
  });

  it("first-occurrence-wins within a session (later duplicates dropped)", () => {
    const content = ["[Key Signals]", "- Decision: same", "- Decision: first", "- Decision: same"].join("\n");
    expect(extractKeySignals(content)).toEqual(["same", "first"]);
  });

  it("CRLF line endings are handled (per-line \\r strip)", () => {
    expect(extractKeySignals("[Key Signals]\r\n- Status: crlf ok\r\n")).toEqual(["crlf ok"]);
  });

  it("empty content → []", () => {
    expect(extractKeySignals("")).toEqual([]);
  });

  it("no Session Goal fallback — goal bullets are never signals (plan-strict, D6)", () => {
    const content = ["[Session Goal]", "- ship the feature", "[Key Signals]"].join("\n");
    expect(extractKeySignals(content)).toEqual([]);
  });
});

// ─── T1 groups — the merge engine (design §12.1) — C3.5 re-key ───────────────
// The C3 per-signal fixtures (old g1–g4, g6–g8) are superseded by the C3.5
// EXTRACT-first engine — their scenarios live in test/rowstore-lessons.test.ts
// (the boundary rule). What stays here: the constant pin, the config surface,
// the re-keyed g5 (sessionCount), the re-keyed g9 (the cap — now EXTRACT-call
// slots, whole-session atomic), the re-keyed g10 (the MERGE-DECISION bytes +
// the enrich= token), and the run-level llm-busy pin. All seams injected (no
// HTTP): embed records kind args, llmCall is scripted (per session, the
// EXTRACT calls first — one per chunk, in chunk order — then the per-lesson
// COMPARE/MERGE calls), nowMs is fixed, sessionCountOverride pins the
// engine-behavior tests (g5 proves the default SQL count path).

const DIM = 768;
const SC = 100; // sessionCountOverride for the engine-behavior pins (g5 uses the default SQL)
const RUN_NOW = 1_750_000_000_000;

const P1 = "/sessions/2026-01-01T00-00-00-session.jsonl";
const P2 = "/sessions/2026-01-02T00-00-00-session.jsonl";
const T1 = "2026-01-01T00:00:00Z";
const T2 = "2026-01-02T00:00:00Z";

/** One-signal session content (the deterministic fake signal builder, group-11 file helper). */
const sig = (text: string) => fakeSignalContent([{ prefix: "Decision", text }]);

/** Session content of EXACTLY `chars` chars, tiled with a unique marker so EVERY chunk
 *  carries it (the g9 char meter + the per-chunk ordering asserts). */
const contentFor = (tag: string, chars: number): string => {
  const unit = `SESSION-${tag}\n`;
  let s = "";
  while (s.length < chars) s += unit;
  return s.slice(0, chars);
};

/** Explicit-id row seed (the exact-bytes fixtures need non-sequential ids). */
function seedRowId(db: any, id: number, item: string, score: number, lastSeen: number, embedding: number[]): void {
  db.prepare("INSERT INTO long_term_rows (id, item, score, last_seen, embedding) VALUES (?, ?, ?, ?, ?)")
    .run(id, item, score, lastSeen, JSON.stringify(embedding));
}

/** A merged (drained) session_summaries row — unmerged_fresh_content stays NULL. */
function seedMergedSession(db: any, path: string, summary: string, updatedAt: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO session_summaries (session_path, version, summary, char_count, merge_count, updated_at) VALUES (?, 1, ?, ?, 3, ?)",
  ).run(path, summary, summary.length, updatedAt);
}

function unmergedOf(db: any, path: string): string | null {
  return (db.prepare("SELECT unmerged_fresh_content FROM session_summaries WHERE session_path = ?").get(path) as { unmerged_fresh_content: string | null } | undefined)?.unmerged_fresh_content ?? null;
}

/** Fake embed seam: `${kind}:${text}` → vector; keys in nullKeys return null; every call recorded. */
function makeEmbed(map: Record<string, number[]>, nullKeys: string[] = []) {
  const calls: { text: string; kind: "query" | "document" }[] = [];
  const fn = async (text: string, kind: "query" | "document"): Promise<number[] | null> => {
    calls.push({ text, kind });
    const key = `${kind}:${text}`;
    if (nullKeys.includes(key)) return null;
    const v = map[key];
    if (!v) throw new Error(`fake embed: no vector for ${key}`);
    return v;
  };
  return { fn, calls };
}

/** Scripted llmCall seam: queued responses in order; prompts recorded; over-consumption throws. */
function scriptLlmCall(responses: Array<string | null>) {
  const prompts: string[] = [];
  let n = 0;
  const fn = async (prompt: string): Promise<string | null> => {
    prompts.push(prompt);
    n++;
    if (responses.length === 0) throw new Error(`scripted llmCall over-consumed (call ${n})`);
    return responses.shift()!;
  };
  return { fn, prompts, count: () => n };
}

describe("mergeSignalsIntoRowStore — C3.5 engine (the re-keyed C3 fixtures + the run-level pin)", () => {
  let db: any;
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  async function runMerge(
    cfg: SessionRecallConfig,
    embed: ReturnType<typeof makeEmbed>["fn"],
    llm: ReturnType<typeof scriptLlmCall>["fn"],
    extra: Partial<RowStoreMergeOptions> = {},
  ): Promise<RowStoreMergeResult> {
    return mergeSignalsIntoRowStore(db, cfg, { embed, llmCall: llm, nowMs: () => RUN_NOW, ...extra });
  }

  beforeEach(() => {
    db = createDb();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
  });
  afterEach(() => { logSpy.mockRestore(); db.close(); });

  it("ROWSTORE_MERGE_LLM_TIMEOUT_MS is exported as 300_000 (P4 — a constant, not a config key)", () => {
    expect(ROWSTORE_MERGE_LLM_TIMEOUT_MS).toBe(300_000);
  });

  it("config surface (C3.5): lessonExtractMaxPerRun defaults 4, clamps [1,50]; rowStoreMaxSignalsPerRun stays (default 20, clamp unchanged)", () => {
    const cfgPath = `${HOMEDIR}/.pi/agent/session-recall.yaml`;
    expect(DEFAULT_CONFIG.lessonExtractMaxPerRun).toBe(4);
    expect(DEFAULT_CONFIG.rowStoreMaxSignalsPerRun).toBe(20);
    vol.fromJSON({ [cfgPath]: "" }); // no yaml values — defaults through the real loadConfig path
    const cfg = loadConfig(HOMEDIR);
    expect(cfg.lessonExtractMaxPerRun).toBe(4);
    expect(cfg.rowStoreMaxSignalsPerRun).toBe(20);
    vol.fromJSON({ [cfgPath]: "lessonExtractMaxPerRun: 0\n" });
    expect(loadConfig(HOMEDIR).lessonExtractMaxPerRun).toBe(1);
    vol.fromJSON({ [cfgPath]: "lessonExtractMaxPerRun: 51\n" });
    expect(loadConfig(HOMEDIR).lessonExtractMaxPerRun).toBe(50);
    vol.fromJSON({ [cfgPath]: "lessonExtractMaxPerRun: 7.9\n" });
    expect(loadConfig(HOMEDIR).lessonExtractMaxPerRun).toBe(7); // P5: Math.floor before clamp
    vol.fromJSON({ [cfgPath]: "lessonExtractMaxPerRun: high\n" });
    expect(loadConfig(HOMEDIR).lessonExtractMaxPerRun).toBe(4); // non-number ignored → default
    vol.fromJSON({ [cfgPath]: "rowStoreMaxSignalsPerRun: 0\n" });
    expect(loadConfig(HOMEDIR).rowStoreMaxSignalsPerRun).toBe(1); // C3 key stays (zero spec break)
    vol.fromJSON({ [cfgPath]: "rowStoreMaxSignalsPerRun: 99\n" });
    expect(loadConfig(HOMEDIR).rowStoreMaxSignalsPerRun).toBe(50);
    expect(loadConfig(HOMEDIR).lessonExtractMaxPerRun).toBe(4); // untouched by the C3 key
  });

  // ── g5 — engine scoring + DB writes (the DEFAULT SQL session count) ─────────

  it("g5: last_seen written by match AND new = COUNT(DISTINCT session_path) over the whole table (default SQL path)", async () => {
    // Five distinct paths; only the first two are unmerged. session_path is the PRIMARY KEY,
    // so the DISTINCT guard is: the count must include the three merged rows too (a
    // unmerged-only count would be 2, not 5).
    for (let i = 0; i < 5; i++) {
      const p = `/sessions/2026-0${i + 1}-01T00-00-00-session.jsonl`;
      if (i < 2) seedSession(db, p, sig(`fact-${i}`), 0, `2026-0${i + 1}T00:00:00Z`);
      else seedMergedSession(db, p, "merged summary", `2026-0${i + 1}T00:00:00Z`);
    }
    seedRowId(db, 1, "pre-existing-fact", 4, 50, unitVec(DIM, 0));
    const docVec = unitVec(DIM, 6);
    const embed = makeEmbed({
      "query:pre-existing-fact": makeQueryVector([0.2]), // session 0's lesson: candidate row 1 (sim 0.2) → LLM match
      "query:fact-1": unitVec(DIM, 5),                  // session 1's lesson: zero candidates → engine new (no LLM call)
      "document:fact-1": docVec,
    });
    // Per session, the EXTRACT call comes first — one per chunk (each session ≤ 24K → one
    // chunk) — then the per-lesson COMPARE. Session 0's lesson restates row 1 verbatim →
    // the enrichment ladder's normalized-identical branch (score-only, no MERGE call).
    const llm = scriptLlmCall(["- pre-existing-fact", '{"action":"match","rowId":1}', "- fact-1"]);
    const res = await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm.fn); // NO sessionCountOverride — default SQL
    expect(res.sessionCount).toBe(5);
    expect(res.signalsProcessed).toBe(2);
    expect(res.sessionsMarkedMerged).toBe(2);
    const rows = getRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: 1, item: "pre-existing-fact", score: 5, lastSeen: 5, embedding: unitVec(DIM, 0) }); // match: 4→5, last_seen = 5 (getRows decodes to lastSeen)
    expect(rows[1]).toEqual({ id: 2, item: "fact-1", score: 1, lastSeen: 5, embedding: docVec });                    // new: score 1, embedding decodes exactly
    expect(llm.count()).toBe(3); // EXTRACT ×2 + COMPARE ×1
    expect(embed.calls.filter(c => c.kind === "query")).toHaveLength(2);
    expect(embed.calls.filter(c => c.kind === "document")).toHaveLength(1); // exactly one "document" for the new lesson (the rewrite re-embed never fires — score-only)
    expect(messages).toEqual([
      "LTROW MODE ROWSTORE",
      `LTROW LESSONS n=1 session=${P1}`,
      "LTROW CANDIDATES n=1 pairs=1:0.2000",
      "LTROW MERGE-DECISION action=match rowId=1 top=0.2000 by=llm enrich=none",
      "LTROW LESSONS n=1 session=/sessions/2026-02-01T00-00-00-session.jsonl", // the loop-built path (i=1) — full path in the line now
      "LTROW CANDIDATES n=0 pairs=-",
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
      "LTROW PRUNED 0",
    ]);
  });

  // ── g9 — cap + whole-session atomicity (EXTRACT-call slots, the <= operator) ──

  const PA = "/sessions/2026-02-01T00-00-00-session.jsonl";
  const PB = "/sessions/2026-02-02T00-00-00-session.jsonl";
  const PC = "/sessions/2026-02-03T00-00-00-session.jsonl";
  const PD = "/sessions/2026-02-04T00-00-00-session.jsonl";
  const PE = "/sessions/2026-02-05T00-00-00-session.jsonl";
  const T3 = "2026-02-03T00:00:00Z";
  const T4 = "2026-02-04T00:00:00Z";
  const T5 = "2026-02-05T00:00:00Z";

  it("g9: cap defers whole sessions (default 4 calls/run) — five 1-call sessions A–E: A–D start, E deferred", async () => {
    seedSession(db, PA, contentFor("A", 1000), 0, T1);
    seedSession(db, PB, contentFor("B", 1000), 0, T2);
    seedSession(db, PC, contentFor("C", 1000), 0, T3);
    seedSession(db, PD, contentFor("D", 1000), 0, T4);
    seedSession(db, PE, contentFor("E", 1000), 0, T5);
    const embed = makeEmbed({}); // zero-lesson sessions never embed
    const llm1 = scriptLlmCall(["(none)", "(none)", "(none)", "(none)"]); // A–D each consume exactly one cap slot (one chunk)
    const res1 = await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm1.fn, { sessionCountOverride: SC }); // DEFAULT cap 4
    expect(llm1.count()).toBe(4); // exactly 4 EXTRACT calls — E's content is never touched
    expect(res1.deferredSessions).toBe(1);
    expect(res1.sessionsMarkedMerged).toBe(4); // zero-lesson sessions count as processed
    expect(res1.signalsProcessed).toBe(0);
    expect(messages).toEqual(["LTROW MODE ROWSTORE", "LTROW MERGE-DEFERRED sessions=1", "LTROW PRUNED 0"]); // DEFERRED before any lesson line; n=0 is quiet

    messages.length = 0;
    const llm2 = scriptLlmCall(["(none)"]);
    const res2 = await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm2.fn, { sessionCountOverride: SC });
    expect(llm2.count()).toBe(1); // run 2 starts only E
    expect(res2.deferredSessions).toBe(0);
    expect(res2.sessionsMarkedMerged).toBe(1);
    expect(messages.filter(m => m.includes("LTROW MERGE-DEFERRED"))).toHaveLength(0); // none when 0
    expect(messages).toEqual(["LTROW MODE ROWSTORE", "LTROW PRUNED 0"]);
  });

  it("g9: a chunked session consumes multiple slots — A(1)+B(3) FITS cap 4; C(3) deferred; B processed whole", async () => {
    seedSession(db, PA, contentFor("A", 10000), 0, T1);  // 1 chunk
    seedSession(db, PB, contentFor("B", 50000), 0, T2);  // ceil(50000/24000) = 3 chunks
    seedSession(db, PC, contentFor("C", 50000), 0, T3);  // 3 chunks
    const embed = makeEmbed({});
    const llm = scriptLlmCall(["(none)", "(none)", "(none)", "(none)"]); // A:1 + B:3 = 4 = cap (NON-STRICT fit)
    const res = await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm.fn, { sessionCountOverride: SC });
    expect(llm.count()).toBe(4);
    expect(llm.prompts.filter(p => p.includes("SESSION-B"))).toHaveLength(3); // B processed whole — all 3 calls
    expect(res.deferredSessions).toBe(1); // 4 + 3 = 7 > 4 → C deferred whole
    expect(res.sessionsMarkedMerged).toBe(2);
    expect(unmergedOf(db, PC)).toBe(contentFor("C", 50000)); // C unmerged
    expect(messages).toEqual(["LTROW MODE ROWSTORE", "LTROW MERGE-DEFERRED sessions=1", "LTROW PRUNED 0"]);
  });

  it("g9: stop before a cap-exceeding session — A(1)+B(1) start, C(3) does NOT (2+3 > 4), deferred whole", async () => {
    seedSession(db, PA, contentFor("A", 10000), 0, T1);
    seedSession(db, PB, contentFor("B", 10000), 0, T2);
    seedSession(db, PC, contentFor("C", 50000), 0, T3);
    const embed = makeEmbed({});
    const llm = scriptLlmCall(["(none)", "(none)"]);
    const res = await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm.fn, { sessionCountOverride: SC });
    expect(llm.count()).toBe(2); // C never started — its content is never touched
    expect(res.deferredSessions).toBe(1);
    expect(res.sessionsMarkedMerged).toBe(2);
    expect(unmergedOf(db, PC)).toBe(contentFor("C", 50000));
    expect(messages).toEqual(["LTROW MODE ROWSTORE", "LTROW MERGE-DEFERRED sessions=1", "LTROW PRUNED 0"]);
  });

  it("g9: always at least one session (oversized) — a lone 120K (5 calls > cap 4) starts and runs all 5 calls, never split", async () => {
    const cBig = contentFor("L", 120000); // 120000 / 24000 = exactly 5 chunks
    seedSession(db, P1, cBig, 0, T1);
    const embed = makeEmbed({});
    const llm = scriptLlmCall(["(none)", "(none)", "(none)", "(none)", "(none)"]);
    const res = await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm.fn, { sessionCountOverride: SC }); // cap 4 — 5 > 4, but the first session ALWAYS starts
    expect(llm.count()).toBe(5); // all 5 chunk calls in THIS run — never split across runs
    expect(res.deferredSessions).toBe(0);
    expect(res.sessionsMarkedMerged).toBe(1);
    expect(messages.filter(m => m.includes("LTROW MERGE-DEFERRED"))).toHaveLength(0);
  });

  it("g9: oversized mid-run failure — chunk-3 parse-fail stops the session; it is left UNMARKED (monotonic, no silent loss)", async () => {
    const cBig = contentFor("L", 120000);
    seedSession(db, P1, cBig, 0, T1);
    const embed = makeEmbed({});
    const llm = scriptLlmCall(["(none)", "(none)", "garbage-no-bullets", "garbage-2"]); // chunk 3: garbage → one retry → parse-fail
    const res = await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm.fn, { sessionCountOverride: SC });
    expect(llm.count()).toBe(4); // the 4th/5th chunks are unattempted — the EXTRACT stage precedes all lesson writes
    expect(res.sessionsFailed).toEqual([P1]);
    expect(res.sessionsMarkedMerged).toBe(0);
    expect(res.signalsProcessed).toBe(1); // the EXTRACT failure counts via its skip entry
    expect(res.skipped).toEqual([{ sessionPath: P1, signalIndex: -1, reason: "parse-fail" }]);
    expect(unmergedOf(db, P1)).toBe(cBig); // UNMARKED — re-extracted next run
    expect(messages).toEqual([
      "LTROW MODE ROWSTORE",
      `LTROW MERGE-SKIP reason=parse-fail session=${P1} signal="extract-failed"`,
      "LTROW PRUNED 0",
    ]);
  });

  it("g9: deferred sessions stay atomic — A(4)+B(2) start at cap 6 (oldest-first, unsplit), C(3) deferred whole; run 2: C whole", async () => {
    seedSession(db, PA, contentFor("A", 96000), 0, T1);  // 4 chunks (96000 / 24000)
    seedSession(db, PB, contentFor("B", 48000), 0, T2);  // 2 chunks
    seedSession(db, PC, contentFor("C", 72000), 0, T3);  // 3 chunks
    const embed = makeEmbed({});
    const cfg = configFor({ embedRetrievalThreshold: 0.1, lessonExtractMaxPerRun: 6 });
    const llm1 = scriptLlmCall(["(none)", "(none)", "(none)", "(none)", "(none)", "(none)"]);
    const res1 = await runMerge(cfg, embed.fn, llm1.fn, { sessionCountOverride: SC });
    expect(llm1.count()).toBe(6); // A(4) + B(2) = 6 = cap
    const order = llm1.prompts.map(p => (p.includes("SESSION-A") ? "A" : "B"));
    expect(order).toEqual(["A", "A", "A", "A", "B", "B"]); // original order, each session unsplit
    expect(res1.deferredSessions).toBe(1); // 6 + 3 = 9 > 6 → C deferred
    expect(res1.sessionsMarkedMerged).toBe(2);
    expect(unmergedOf(db, PC)).toBe(contentFor("C", 72000)); // unmerged, unsplit
    expect(messages).toEqual(["LTROW MODE ROWSTORE", "LTROW MERGE-DEFERRED sessions=1", "LTROW PRUNED 0"]);

    messages.length = 0;
    const llm2 = scriptLlmCall(["(none)", "(none)", "(none)"]);
    const res2 = await runMerge(cfg, embed.fn, llm2.fn, { sessionCountOverride: SC });
    expect(llm2.count()).toBe(3); // C starts whole in run 2
    expect(res2.deferredSessions).toBe(0);
    expect(res2.sessionsMarkedMerged).toBe(1);
    expect(unmergedOf(db, PC)).toBeNull();
    expect(messages).toEqual(["LTROW MODE ROWSTORE", "LTROW PRUNED 0"]);
  });

  // ── g10 — log bytes (design §4 filled examples, exact) + the enrich= token ──

  it("g10: the MERGE-DECISION byte shapes — all four + the enrich= token (none / rewrite / rejected / engine-new)", async () => {
    seedRowId(db, 1, "fact-a", 1, SC, unitVec(DIM, 0));
    seedRowId(db, 2, "fact-b", 1, SC, unitVec(DIM, 1));
    seedRowId(db, 3, "fact-c", 1, SC, unitVec(DIM, 2));
    seedSession(db, P1, sig("g10-multi"), 0, T1);
    const embed = makeEmbed({
      "query:fact-a": makeQueryVector([0.9]),
      "query:fact-b with more detail": makeQueryVector([0, 0.8]), // sim on dim 1 → row 2 only
      "query:something about fact c": makeQueryVector([0, 0, 0.7]), // sim on dim 2 → row 3 only
      "query:fact-d-solo": unitVec(DIM, 9), // zero candidates → the by=engine shape
      "document:fact-b with more detail": unitVec(DIM, 10), // the rewrite re-embed (exactly one)
      "document:fact-d-solo": unitVec(DIM, 11),
    });
    const llm = scriptLlmCall([
      "- fact-a\n- fact-b with more detail\n- something about fact c\n- fact-d-solo", // EXTRACT: 4 lessons
      '{"action":"match","rowId":1}', // lesson 1 — normalized-identical → enrich=none (score-only)
      '{"action":"match","rowId":2}', // lesson 2 — raw superset → enrich=rewrite (one write: item + embedding + score)
      '{"action":"match","rowId":3}', // lesson 3 — partial overlap → the MERGE call (the 5th call)
      "totally\nwrong",               // MERGE garbage (multi-line) → fail-safe enrich=rejected — NO strike
    ]);
    const res = await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm.fn, { sessionCountOverride: SC });
    expect(llm.count()).toBe(5);
    expect(res.sessionsMarkedMerged).toBe(1);
    expect(res.skipped).toEqual([]); // the fail-safe reject is NOT a failure
    expect(messages).toEqual([
      "LTROW MODE ROWSTORE",
      `LTROW LESSONS n=4 session=${P1}`,
      "LTROW CANDIDATES n=1 pairs=1:0.9000",
      "LTROW MERGE-DECISION action=match rowId=1 top=0.9000 by=llm enrich=none",
      "LTROW CANDIDATES n=1 pairs=2:0.8000",
      "LTROW MERGE-DECISION action=match rowId=2 top=0.8000 by=llm enrich=rewrite",
      "LTROW CANDIDATES n=1 pairs=3:0.7000",
      "LTROW MERGE-ENRICH rowId=3 enrich=rejected why=multiline s=fact-c i=something about fact c m=-",
      "LTROW MERGE-DECISION action=match rowId=3 top=0.7000 by=llm enrich=rejected",
      "LTROW CANDIDATES n=0 pairs=-",
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
      "LTROW PRUNED 0",
    ]);
    expect(messages.filter(m => m === "LTROW MODE ROWSTORE")).toHaveLength(1); // exactly once
    const rows = getRows(db);
    expect(rows[0]).toEqual({ id: 1, item: "fact-a", score: 2, lastSeen: SC, embedding: unitVec(DIM, 0) });          // none: score-only, item byte-identical
    expect(rows[1]).toEqual({ id: 2, item: "fact-b with more detail", score: 2, lastSeen: SC, embedding: unitVec(DIM, 10) }); // rewrite: ONE write — item + embedding + score together
    expect(rows[2]).toEqual({ id: 3, item: "fact-c", score: 2, lastSeen: SC, embedding: unitVec(DIM, 2) });          // rejected: score-only, item byte-identical
    expect(rows[3]).toEqual({ id: 4, item: "fact-d-solo", score: 1, lastSeen: SC, embedding: unitVec(DIM, 11) });    // new: inserted
  });

  it("g10: sim4 renders 0.7310999… as 0.7311 and 0.5 as 0.5000", async () => {
    seedRowId(db, 1, "round-a", 1, SC, unitVec(DIM, 0));
    seedRowId(db, 2, "round-b", 1, SC, unitVec(DIM, 1));
    seedSession(db, P1, sig("round-sig"), 0, T1);
    const embed = makeEmbed({ "query:round-a": makeQueryVector([0.7310999, 0.5]) });
    const llm = scriptLlmCall(["- round-a", '{"action":"match","rowId":1}']);
    await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm.fn, { sessionCountOverride: SC });
    expect(messages).toEqual([
      "LTROW MODE ROWSTORE",
      `LTROW LESSONS n=1 session=${P1}`,
      "LTROW CANDIDATES n=2 pairs=1:0.7311:2:0.5000",
      "LTROW MERGE-DECISION action=match rowId=1 top=0.7311 by=llm enrich=none",
      "LTROW PRUNED 0",
    ]);
  });

  it("g10: a zero-lesson session emits no LESSONS line and no per-lesson lines (drain, marked merged)", async () => {
    seedRowId(db, 1, "drain-fact", 1, SC, unitVec(DIM, 0)); // the lesson restates it verbatim → normalized-identical (enrich=none, no MERGE call)
    seedSession(db, P1, sig("drain-sig"), 0, T1);
    seedSession(db, P2, "just noise, no lessons", 0, T2); // EXTRACT → (none): the n=0 quiet pin
    const embed = makeEmbed({ "query:drain-fact": makeQueryVector([0.2]) });
    const llm = scriptLlmCall(["- drain-fact", '{"action":"match","rowId":1}', "(none)"]);
    const res = await runMerge(configFor({ embedRetrievalThreshold: 0.1 }), embed.fn, llm.fn, { sessionCountOverride: SC });
    expect(res.sessionsMarkedMerged).toBe(2); // includes the zero-lesson drain
    expect(unmergedOf(db, P2)).toBeNull();
    expect(messages).toEqual([
      "LTROW MODE ROWSTORE",
      `LTROW LESSONS n=1 session=${P1}`,
      "LTROW CANDIDATES n=1 pairs=1:0.2000",
      "LTROW MERGE-DECISION action=match rowId=1 top=0.2000 by=llm enrich=none",
      "LTROW PRUNED 0",
    ]); // NO LESSONS line for P2 — n=0 quiet; no skip line
  });

  // ── Run-level pin (design §1.3 step 3) — withLlmBusy skip-not-queue ─────────

  it("run-level: withLlmBusy busy → house line + zeroed result (llmBusySkipped) — no writes, nothing marked, no prune", async () => {
    seedRowId(db, 1, "pre-existing", 1, SC, unitVec(DIM, 0));
    seedSession(db, P1, sig("busy-signal"), 0, T1);
    const embed = makeEmbed({ "query:busy-signal": makeQueryVector([0.2]), "document:busy-signal": unitVec(DIM, 2) });
    const llm = scriptLlmCall([]);
    const before = tableSnapshot(db);
    const res = await mergeSignalsIntoRowStore(db, configFor({ embedRetrievalThreshold: 0.1 }), {
      embed: embed.fn, llmCall: llm.fn, nowMs: () => RUN_NOW, sessionCountOverride: SC,
      llmBusy: async () => null, // the seam fires — the run did not execute
    });
    expect(res).toEqual({ signalsProcessed: 0, sessionsMarkedMerged: 0, sessionsFailed: [], deferredSessions: 0, decisions: [], skipped: [], signalDetail: [], pruned: 0, sessionCount: SC, llmBusySkipped: true });
    expect(llm.count()).toBe(0);
    expect(embed.calls).toHaveLength(0);
    expect(tableSnapshot(db)).toEqual(before); // no writes
    expect(unmergedOf(db, P1)).toBe(sig("busy-signal")); // nothing marked
    expect(readMergeQuarantine(db, P1)).toBeNull(); // no sentinel strike
    expect(messages).toEqual([
      "LTROW MODE ROWSTORE",
      "rowstore merge: skipped (llm busy)",
    ]); // no signal lines, no PRUNED — the skip is before the per-run body
  });
});
