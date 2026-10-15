import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import * as logger from "../logger.js";
import {
  ensureSchema,
  sqliteReadUnmergedSessionSummaries,
  sqliteMarkSessionSummariesMerged,
  sqliteWriteLongTerm,
  sqliteReadLongTerm,
  sessionPathHash,
  md5Content,
  upsertMergeQuarantine,
  openCacheDb,
  shouldSkipByTime,
  readLongTerm,
  writeLongTerm,
  getPrimaryModel,
  runMergeFold,
  packMergeChunks,
  runLtTableConversion,
  LT_TABLE_CONVERSION_FLAG_KEY,
  LT_TABLE_CONVERSION_BACKUP_KEY,
  sqliteSetMeta,
  sqliteGetMeta,
  buildMergeModelPair,
  waitForLlmEndpointReady,
} from "../summarizer.js";
import { discoverSessions } from "../discoverer.js";
import { G } from "../types.js";
import { mockCompleteReset, mockCompleteQueue, mockCompleteCalls } from "@earendil-works/pi-ai";
import defaultExport from "../index.js";
import { loadConfigOnce, DEFAULT_CONFIG } from "../config.js";
import { ensureEmbedServer } from "../embeddings.js";
import { mergeSignalsIntoRowStore, ROWSTORE_LAST_FOLD_MS_KEY, type RowStoreMergeResult } from "../rowstore.js";

// ── Hermetic model config (clean-machine fix, 2026-10-15) ──────────────────
// The real runMergeFold / runLtTableConversion resolve the merge model via
// loadModelConfig() → <homedir>/.pi/agent/models.json. Without this shim the
// suite passed only on machines that happen to carry a real models.json (the
// author's dev box); on a clean CI runner both LLM stages logged "no model
// config" and every real-fold test saw zero LLM calls. The stub config makes
// the pair resolvable on any machine — the actual LLM call is the aliased
// pi-ai mock, so no network is touched. HOME/USERPROFILE are restored in
// afterAll (never leaked into other suites).
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { beforeAll, afterAll } from "vitest";

const REAL_HOME_ENV = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let stubHome: string;
beforeAll(() => {
  stubHome = mkdtempSync(pathJoin(tmpdir(), "sr-modelcfg-"));
  mkdirSync(pathJoin(stubHome, ".pi", "agent"), { recursive: true });
  writeFileSync(
    pathJoin(stubHome, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        "stub-provider": {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "sk-test",
          models: [{ id: "stub-model", name: "Stub Model" }],
        },
      },
    }),
  );
  process.env.HOME = stubHome;
  process.env.USERPROFILE = stubHome;
});
afterAll(() => {
  process.env.HOME = REAL_HOME_ENV.HOME;
  process.env.USERPROFILE = REAL_HOME_ENV.USERPROFILE;
});

// Module mocks for the handler-level describe (design §3 + §4.1). The helper-level
// describe below uses the REAL helpers (passed through via ...actual spread).
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfigOnce: vi.fn(() => actual.DEFAULT_CONFIG) };
});

vi.mock("../discoverer.js", () => ({
  discoverSessions: vi.fn(),
  SQLITE_PATH: "/test/sr-handler/session-index.sqlite",
}));

vi.mock("../summarizer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../summarizer.js")>();
  return {
    ...actual,
    openCacheDb: vi.fn(),
    shouldSkipByTime: vi.fn(),
    readLongTerm: vi.fn(),
    writeLongTerm: vi.fn(), // hash-file API — mocked so the RED-phase handler path cannot touch fs
    getPrimaryModel: vi.fn(),
    runMergeFold: vi.fn(),
    packMergeChunks: vi.fn(),
    runLtTableConversion: vi.fn(),
    // 2026-10-07 fold-call-site seams (summarizer owns both): default null pair → the
    // pre-fold LLM readiness wait is never entered from the handler path in this suite.
    buildMergeModelPair: vi.fn(),
    waitForLlmEndpointReady: vi.fn(async () => true),
  };
});
vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    // Deterministic no-op: the STATIC ../index.js instance (used by the earlier
    // describes) must never probe or spawn a real embed server from the suite.
    // (DEFAULT_CONFIG carries real exe/model paths that exist on the dev machine —
    // an un-mocked ensureEmbedServer there spawned real detached llama-server
    // processes during the C1 apply runs; 6 orphans killed 2026-08-28.) The
    // fold-time describe below overrides with a spy via vi.doMock + vi.resetModules().
    ensureEmbedServer: vi.fn(async () => undefined),
  };
});
// rowstore-merge C3 — the engine is mocked for the fold-branch legs (T2): the
// LTROW bytes it emits are pinned in the unit suite (test/rowstore-merge.test.ts
// group 10), not here.
vi.mock("../rowstore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rowstore.js")>();
  return { ...actual, mergeSignalsIntoRowStore: vi.fn() };
});

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function createDb(): any {
  const db = new Database(":memory:");
  ensureSchema(db);
  return db;
}

function insertSession(db: any, path: string, summary: string, mergeCount: number, freshHash: string | null = null): void {
  db.prepare(
    "INSERT OR REPLACE INTO session_summaries " +
    "(session_path, version, summary, char_count, merge_count, last_fresh_hash, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(path, 1, summary, summary.length, mergeCount, freshHash, new Date().toISOString());
}

describe("session_start merge flow (SQLite path)", () => {
  let db: any;

  beforeEach(() => { db = createDb(); });
  afterEach(() => { db.close(); });

  it("persists per chunk in write-then-mark order with baseline-seeded mergedSessions", () => {
    // Baseline long_term row — pre-existing merge state the fold must carry forward.
    const baselineHash = sessionPathHash("/session/Z.jsonl");
    sqliteWriteLongTerm(db, "Baseline summary", 1, [baselineHash]);

    // Setup: 3 sessions with unmerged content, merge_count sum = 15 (>= 10 threshold)
    insertSession(db, "/session/A.jsonl", "Summary A", 5, "hashA");
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run("Fresh A", "/session/A.jsonl");

    insertSession(db, "/session/B.jsonl", "Summary B", 6, "hashB");
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run("Fresh B", "/session/B.jsonl");

    insertSession(db, "/session/C.jsonl", "Summary C", 4, "hashC");
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run("Fresh C", "/session/C.jsonl");

    // Step 1: Read unmerged sessions + threshold (unchanged semantics)
    const unmergedSessions = sqliteReadUnmergedSessionSummaries(db);
    expect(unmergedSessions).toHaveLength(3);
    const mergeCountSum = unmergedSessions.reduce((sum, s) => sum + s.merge_count, 0);
    expect(mergeCountSum).toBe(15);
    expect(mergeCountSum >= 10).toBe(true);

    // Step 2: Simulate one chunk's fold success. mergedSessions is seeded from the
    // baseline row, chunk session hashes appended, and persisted inside the write.
    const baseline = sqliteReadLongTerm(db);
    const mergedSessions = new Set(baseline?.mergedSessions ?? []);
    for (const s of unmergedSessions) mergedSessions.add(sessionPathHash(s.session_path));
    const mergedResult = "[Merged Summary]\n- Fresh A, B, C merged";

    // WRITE first (bumps long_term.timestamp), THEN mark — the fold's per-chunk order.
    sqliteWriteLongTerm(db, mergedResult, mergedSessions.size, [...mergedSessions]);
    sqliteMarkSessionSummariesMerged(db, unmergedSessions.map(s => s.session_path));

    // long_term: baseline hash retained + 3 chunk hashes, new summary
    const longTerm = sqliteReadLongTerm(db);
    expect(longTerm?.summary).toBe(mergedResult);
    expect(longTerm?.mergedSessions).toHaveLength(4);
    expect(longTerm?.mergedSessions).toContain(baselineHash);
    for (const s of unmergedSessions) {
      expect(longTerm?.mergedSessions).toContain(sessionPathHash(s.session_path));
    }

    // Marked: unmerged cleared, last_merged_hash set; nothing left unmerged
    for (const s of unmergedSessions) {
      const row = db.prepare("SELECT unmerged_fresh_content, last_merged_hash FROM session_summaries WHERE session_path = ?").get(s.session_path);
      expect(row.unmerged_fresh_content).toBeNull();
      expect(row.last_merged_hash).not.toBeNull();
    }
    expect(sqliteReadUnmergedSessionSummaries(db)).toHaveLength(0);
  });

  it("skips merge when below threshold", () => {
    insertSession(db, "/session/A.jsonl", "Summary A", 2, "hashA");
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run("Fresh A", "/session/A.jsonl");

    insertSession(db, "/session/B.jsonl", "Summary B", 3, "hashB");
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run("Fresh B", "/session/B.jsonl");

    const unmergedSessions = sqliteReadUnmergedSessionSummaries(db);
    const mergeCountSum = unmergedSessions.reduce((sum, s) => sum + s.merge_count, 0);
    expect(mergeCountSum).toBe(5);
    expect(mergeCountSum >= 10).toBe(false); // Below threshold

    // Sessions remain unmerged
    const remaining = sqliteReadUnmergedSessionSummaries(db);
    expect(remaining).toHaveLength(2);
  });

  it("preserves unmerged content on fold stop-on-failure (null result → no mark)", () => {
    insertSession(db, "/session/A.jsonl", "Summary A", 10, "hashA");
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run("Fresh A", "/session/A.jsonl");

    const unmergedSessions = sqliteReadUnmergedSessionSummaries(db);
    const sessionPaths = unmergedSessions.map(s => s.session_path);

    // Fold stop-on-failure semantics: a null chunk result means the chunk was NOT
    // persisted — no mark, content preserved for the next session_start.
    const mergedResult: string | null = null; // LLM failure
    if (mergedResult !== null) {
      sqliteMarkSessionSummariesMerged(db, sessionPaths);
    }

    // Verify: content preserved for retry
    const remaining = sqliteReadUnmergedSessionSummaries(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].unmerged_fresh_content).toBe("Fresh A");
  });
});

// ─── Handler-level wiring (design §3 — session_start rewrite) ───────────────

const PATH_A = "/pi/agent/sessions/sess-a.jsonl";
const PATH_B = "/pi/agent/sessions/sess-b.jsonl";
const SESSION_FILE = "/pi/agent/sessions/sess-current.jsonl";
const CTX: any = { sessionManager: { getSessionFile: () => SESSION_FILE }, cwd: "/test/sr-handler" };
const FAKE_SESSIONS: any[] = [
  { path: SESSION_FILE, cwd: "/test/sr-handler", timestamp: "", sizeBytes: 0 },
];

/** Valid 5-section table summary (passes the T2 validateTableSummary gate) with the label row. */
function validTables(label: string): string {
  const empty = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
  const first = `## Key Decisions\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| ${label} | 1 | 1 |`;
  return [first, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
}

function seedUnmerged(db: any, path: string, content: string, mergeCount: number, tsIso: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO session_summaries " +
    "(session_path, version, summary, char_count, merge_count, updated_at) " +
    "VALUES (?, 1, ?, ?, ?, ?)",
  ).run(path, content, content.length, mergeCount, tsIso);
  db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run(content, path);
}

describe("session_start handler wiring (design §3)", () => {
  let db: any;
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let handlers: Record<string, (...args: any[]) => any>;
  let realSummarizer: Awaited<ReturnType<typeof vi.importActual<typeof import("../summarizer.js")>>>;

  beforeEach(async () => {
    db = createDb();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
    mockCompleteReset();
    G.__sessionRecallLoaded__ = false;
    G.__sessionRecallMergeInProgress__ = false;
    G.__sessionRecallLlmBusy__ = false;

    realSummarizer = await vi.importActual<typeof import("../summarizer.js")>("../summarizer.js");

    vi.mocked(openCacheDb).mockReset();
    vi.mocked(shouldSkipByTime).mockReset();
    vi.mocked(readLongTerm).mockReset().mockResolvedValue(null);
    vi.mocked(writeLongTerm).mockReset();
    vi.mocked(getPrimaryModel).mockReset();
    vi.mocked(runMergeFold).mockReset();
    vi.mocked(packMergeChunks).mockReset().mockImplementation((...args: any[]) => realSummarizer.packMergeChunks(...args));
    vi.mocked(runLtTableConversion).mockReset().mockImplementation((...args: any[]) => realSummarizer.runLtTableConversion(...args));
    vi.mocked(discoverSessions).mockReset().mockResolvedValue([]);

    const captured: Record<string, (...args: any[]) => any> = {};
    defaultExport({
      on: (name: string, cb: (...args: any[]) => any) => { captured[name] = cb; },
      registerTool: () => {},
      registerCommand: () => {},
    });
    handlers = captured;
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  async function fireSessionStart(): Promise<void> {
    await handlers["session_start"]({}, CTX);
  }

  async function flush(): Promise<void> {
    await new Promise(r => setTimeout(r, 10));
  }

  it("opens the DB before the throttle — skip path does not run discovery", async () => {
    const order: string[] = [];
    vi.mocked(openCacheDb).mockImplementation(async () => { order.push("open"); return db; });
    vi.mocked(shouldSkipByTime).mockImplementation(async () => { order.push("throttle"); return true; });

    await fireSessionStart();
    await flush();

    expect(order).toEqual(["open", "throttle"]); // DB open moved BEFORE the throttle
    expect(vi.mocked(discoverSessions)).not.toHaveBeenCalled(); // skip short-circuits discovery
    expect(messages.join("\n")).toContain("skipping merge");
  });

  it("drain-aware skip log reports the effective interval (30min, not 4.0h) while unmerged rows remain", async () => {
    seedUnmerged(db, PATH_A, "content-A " + "a".repeat(50), 5, "2026-01-01T00:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(true);

    await fireSessionStart();
    await flush();

    const logText = messages.join("\n");
    expect(logText).toContain("skipping merge (last merge was < 30min ago)");
    expect(logText).not.toContain("4.0h");
  });

  it("quarantine run-start pass excludes active sentinels before packing (real fold + real helpers)", async () => {
    const contentA = "content-A " + "a".repeat(100);
    const contentB = "content-B " + "b".repeat(100);
    seedUnmerged(db, PATH_A, contentA, 5, "2026-01-01T00:00:00.000Z");
    seedUnmerged(db, PATH_B, contentB, 5, "2026-01-01T01:00:00.000Z");
    upsertMergeQuarantine(db, PATH_A, {
      headPath: PATH_A, contentHash: md5Content(contentA), failures: 3, quarantinedAt: Date.now() - 86_400_000,
    });

    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
    vi.mocked(discoverSessions).mockResolvedValue(FAKE_SESSIONS);
    vi.mocked(readLongTerm).mockResolvedValue({
      timestamp: new Date().toISOString(), summary: validTables("BASE"), charCount: 200, sessionCount: 1, mergedSessions: ["basehash"], // table summary → pre-step takes the 'already-tables' path (no conversion LLM call)
    });
    vi.mocked(runMergeFold).mockImplementation((...args: any[]) => realSummarizer.runMergeFold(...args));

    mockCompleteQueue({ content: [{ type: "text", text: validTables("MERGED-B") }], stopReason: "stop" });
    await fireSessionStart();
    await flush();

    // A excluded at run start (active sentinel) — still unmerged; B processed.
    const remaining = sqliteReadUnmergedSessionSummaries(db);
    expect(remaining.map(r => r.session_path)).toEqual([PATH_A]);
    expect(remaining[0].unmerged_fresh_content).toBe(contentA);

    // One LLM call, prompt contains B and not A.
    expect(mockCompleteCalls()).toHaveLength(1);
    expect(mockCompleteCalls()[0].promptText).toContain("content-B");
    expect(mockCompleteCalls()[0].promptText).not.toContain("content-A");

    // Write-then-mark with baseline-seeded mergedSessions, persisted inside the write.
    const longTerm = sqliteReadLongTerm(db);
    expect(longTerm?.summary).toContain("MERGED-B");
    expect(longTerm?.mergedSessions).toContain("basehash");
    expect(longTerm?.mergedSessions).toContain(sessionPathHash(PATH_B));
    expect(longTerm?.mergedSessions).not.toContain(sessionPathHash(PATH_A));

    expect(messages.join("\n")).toContain("fold complete");
  });

  it("all-quarantined: log + return before packing or folding", async () => {
    const contentA = "content-A " + "a".repeat(50);
    const contentB = "content-B " + "b".repeat(50);
    seedUnmerged(db, PATH_A, contentA, 5, "2026-01-01T00:00:00.000Z");
    seedUnmerged(db, PATH_B, contentB, 5, "2026-01-01T01:00:00.000Z");
    upsertMergeQuarantine(db, PATH_A, { headPath: PATH_A, contentHash: md5Content(contentA), failures: 3, quarantinedAt: Date.now() - 86_400_000 });
    upsertMergeQuarantine(db, PATH_B, { headPath: PATH_B, contentHash: md5Content(contentB), failures: 3, quarantinedAt: Date.now() - 86_400_000 });

    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
    vi.mocked(discoverSessions).mockResolvedValue(FAKE_SESSIONS);

    await fireSessionStart();
    await flush();

    expect(messages.join("\n")).toContain("all unmerged sessions quarantined");
    expect(vi.mocked(packMergeChunks)).not.toHaveBeenCalled();
    expect(vi.mocked(runMergeFold)).not.toHaveBeenCalled();
  });

  it("zero chunks packed: log + return before the fold", async () => {
    seedUnmerged(db, PATH_A, "content-A " + "a".repeat(50), 10, "2026-01-01T00:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
    vi.mocked(discoverSessions).mockResolvedValue(FAKE_SESSIONS);
    vi.mocked(packMergeChunks).mockReturnValue([]);

    await fireSessionStart();
    await flush();

    expect(messages.join("\n")).toContain("zero chunks packed");
    expect(vi.mocked(runMergeFold)).not.toHaveBeenCalled();
  });

  it("__sessionRecallMergeInProgress__: set synchronously, held for the entire run, cleared in finally", async () => {
    seedUnmerged(db, PATH_A, "content-A " + "a".repeat(50), 10, "2026-01-01T00:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
    vi.mocked(discoverSessions).mockResolvedValue(FAKE_SESSIONS);
    const mid = { held: false };
    vi.mocked(runMergeFold).mockImplementation(async () => {
      mid.held = G.__sessionRecallMergeInProgress__ === true;
      return { processedChunks: 1, lastSummary: "X", stoppedAtChunk: null, quarantinedPaths: [], busySkipped: false };
    });

    await fireSessionStart();
    // Synchronous set — visible immediately after the handler returns, before the
    // fire-and-forget microtask has run.
    expect(G.__sessionRecallMergeInProgress__).toBe(true);
    await flush();
    expect(mid.held).toBe(true); // held across the whole run (handler side of the hold)
    expect(G.__sessionRecallMergeInProgress__).toBe(false); // cleared in finally
  });
});

// ─── Conversion pre-step (pin P6 order — design §7 handler delta) ───────────

describe("session_start conversion pre-step (pin P6 order)", () => {
  let db: any;
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let handlers: Record<string, (...args: any[]) => any>;
  let realSummarizer: Awaited<ReturnType<typeof vi.importActual<typeof import("../summarizer.js")>>>;

  beforeEach(async () => {
    db = createDb();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
    mockCompleteReset();
    G.__sessionRecallLoaded__ = false;
    G.__sessionRecallMergeInProgress__ = false;
    G.__sessionRecallLlmBusy__ = false;

    realSummarizer = await vi.importActual<typeof import("../summarizer.js")>("../summarizer.js");

    vi.mocked(openCacheDb).mockReset();
    vi.mocked(shouldSkipByTime).mockReset();
    vi.mocked(readLongTerm).mockReset().mockResolvedValue(null);
    vi.mocked(writeLongTerm).mockReset();
    vi.mocked(getPrimaryModel).mockReset();
    vi.mocked(runMergeFold).mockReset();
    vi.mocked(packMergeChunks).mockReset().mockImplementation((...args: any[]) => realSummarizer.packMergeChunks(...args));
    vi.mocked(runLtTableConversion).mockReset().mockImplementation((...args: any[]) => realSummarizer.runLtTableConversion(...args));
    vi.mocked(discoverSessions).mockReset().mockResolvedValue([]);

    const captured: Record<string, (...args: any[]) => any> = {};
    defaultExport({
      on: (name: string, cb: (...args: any[]) => any) => { captured[name] = cb; },
      registerTool: () => {},
      registerCommand: () => {},
    });
    handlers = captured;
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  async function fireSessionStart(): Promise<void> {
    await handlers["session_start"]({}, CTX);
  }

  async function flush(): Promise<void> {
    await new Promise(r => setTimeout(r, 10));
  }

  it("prose + no flag → conversion LLM call BEFORE packing; fold baseline = converted tables", async () => {
    const proseSummary = "Legacy prose marker ALPHA — pre-conversion summary.";
    seedUnmerged(db, PATH_A, "content " + "a".repeat(80), 10, "2026-01-01T00:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
    vi.mocked(discoverSessions).mockResolvedValue(FAKE_SESSIONS);
    vi.mocked(readLongTerm).mockResolvedValue({
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: proseSummary,
      charCount: proseSummary.length,
      sessionCount: 50,
      mergedSessions: ["h-baseline"],
    } as any);

    const order: string[] = [];
    vi.mocked(runLtTableConversion).mockImplementation((...args: any[]) => {
      order.push("conversion");
      return realSummarizer.runLtTableConversion(...args);
    });
    vi.mocked(packMergeChunks).mockImplementation((...args: any[]) => {
      order.push("pack");
      return realSummarizer.packMergeChunks(...args);
    });
    vi.mocked(runMergeFold).mockImplementation((...args: any[]) => realSummarizer.runMergeFold(...args));

    mockCompleteQueue({ content: [{ type: "text", text: validTables("CONVERTED-TABLES") }], stopReason: "stop" });
    mockCompleteQueue({ content: [{ type: "text", text: validTables("MERGE-OUT") }], stopReason: "stop" });

    await fireSessionStart();
    await flush();

    expect(order).toEqual(["conversion", "pack"]); // conversion strictly before packing
    expect(mockCompleteCalls()).toHaveLength(2);
    const conversionPrompt = mockCompleteCalls()[0].promptText;
    const mergePrompt = mockCompleteCalls()[1].promptText;
    expect(conversionPrompt).toContain("marker ALPHA");      // conversion prompt carries the full prose
    expect(mergePrompt).toContain("CONVERTED-TABLES");        // fold baseline = converted tables
    expect(mergePrompt).not.toContain("marker ALPHA");
    expect(messages.join("\n")).toContain("post-conversion baseline");
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeTruthy(); // flag set by the pre-step
  });

  it("flag set → no conversion LLM call; fold baseline = stored summary", async () => {
    const proseSummary = "Legacy prose marker BETA — stored summary.";
    seedUnmerged(db, PATH_A, "content " + "a".repeat(80), 10, "2026-01-01T00:00:00.000Z");
    sqliteSetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY, "2026-01-01T00:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
    vi.mocked(discoverSessions).mockResolvedValue(FAKE_SESSIONS);
    vi.mocked(readLongTerm).mockResolvedValue({
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: proseSummary,
      charCount: proseSummary.length,
      sessionCount: 50,
      mergedSessions: ["h-baseline"],
    } as any);
    vi.mocked(runMergeFold).mockImplementation((...args: any[]) => realSummarizer.runMergeFold(...args));

    mockCompleteQueue({ content: [{ type: "text", text: validTables("MERGE-OUT-B") }], stopReason: "stop" });

    await fireSessionStart();
    await flush();

    expect(mockCompleteCalls()).toHaveLength(1); // merge call only — conversion skipped (flag-set)
    expect(mockCompleteCalls()[0].promptText).toContain("marker BETA"); // baseline = stored summary
  });

  it("table summary, no flag → no conversion LLM call (already-tables); fold baseline = stored tables", async () => {
    const stored = validTables("STORED-TABLES");
    seedUnmerged(db, PATH_A, "content " + "a".repeat(80), 10, "2026-01-01T00:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
    vi.mocked(discoverSessions).mockResolvedValue(FAKE_SESSIONS);
    vi.mocked(readLongTerm).mockResolvedValue({
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: stored,
      charCount: stored.length,
      sessionCount: 50,
      mergedSessions: ["h-baseline"],
    } as any);
    vi.mocked(runMergeFold).mockImplementation((...args: any[]) => realSummarizer.runMergeFold(...args));

    mockCompleteQueue({ content: [{ type: "text", text: validTables("MERGE-OUT-C") }], stopReason: "stop" });

    await fireSessionStart();
    await flush();

    expect(mockCompleteCalls()).toHaveLength(1); // no conversion call
    expect(mockCompleteCalls()[0].promptText).toContain("STORED-TABLES"); // baseline = stored tables
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeNull();
  });

  it("conversion failure (both calls invalid) → fold proceeds with the old prose baseline; no flag written", async () => {
    const proseSummary = "Legacy prose marker GAMMA.";
    seedUnmerged(db, PATH_A, "content " + "a".repeat(80), 10, "2026-01-01T00:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
    vi.mocked(discoverSessions).mockResolvedValue(FAKE_SESSIONS);
    vi.mocked(readLongTerm).mockResolvedValue({
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: proseSummary,
      charCount: proseSummary.length,
      sessionCount: 50,
      mergedSessions: ["h-baseline"],
    } as any);
    vi.mocked(runMergeFold).mockImplementation((...args: any[]) => realSummarizer.runMergeFold(...args));

    mockCompleteQueue({ content: [{ type: "text", text: "garbage conversion 1" }], stopReason: "stop" });
    mockCompleteQueue({ content: [{ type: "text", text: "garbage conversion 2" }], stopReason: "stop" });
    mockCompleteQueue({ content: [{ type: "text", text: validTables("MERGE-OUT-D") }], stopReason: "stop" });

    await fireSessionStart();
    await flush();

    expect(mockCompleteCalls()).toHaveLength(3); // 2 conversion attempts + 1 merge
    expect(mockCompleteCalls()[2].promptText).toContain("marker GAMMA"); // old-prose tolerance (rule 1)
    expect(messages.join("\n")).toContain("fold complete");
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_FLAG_KEY)).toBeNull(); // no flag on failure
    expect(sqliteGetMeta(db, LT_TABLE_CONVERSION_BACKUP_KEY)).toBeNull(); // no backup on failure
  });

  it("throttle and min-turns gates short-circuit BEFORE any conversion call", async () => {
    // (e1) time throttle
    seedUnmerged(db, PATH_A, "content " + "a".repeat(80), 10, "2026-01-01T00:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(shouldSkipByTime).mockResolvedValue(true);
    vi.mocked(discoverSessions).mockResolvedValue(FAKE_SESSIONS);

    await fireSessionStart();
    await flush();

    expect(vi.mocked(runLtTableConversion)).not.toHaveBeenCalled();
    expect(mockCompleteCalls()).toHaveLength(0);

    // (e2) min-turns gate (merge_count sum 5 < 10)
    const db2 = createDb();
    seedUnmerged(db2, PATH_A, "content " + "b".repeat(80), 5, "2026-01-01T00:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(db2);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
    vi.mocked(runLtTableConversion).mockClear();

    await fireSessionStart();
    await flush();

    expect(vi.mocked(runLtTableConversion)).not.toHaveBeenCalled();
    expect(mockCompleteCalls()).toHaveLength(0);
    expect(messages.join("\n")).toContain("< 10 minimum");
    db2.close();
  });
});

// ─── Embedding server probe at fold time (design §7 — C1 wiring) ───────────
// Seam per design §8.3: vi.doMock("../embeddings.js") + vi.resetModules() +
// dynamic import("../index.js") on the existing harness. The top-level
// vi.mock("../embeddings.js") above keeps the STATIC ../index.js instance (used by
// the earlier describes) on a deterministic no-op ensureEmbedServer — the
// earlier fold-reaching tests must never probe or spawn a real server from the suite.

describe("session_start embedding server probe (design §7)", () => {
  let db: any;
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let loggerFresh: typeof import("../logger.js");
  let handlers: Record<string, (...args: any[]) => any>;
  let realSummarizer: Awaited<ReturnType<typeof vi.importActual<typeof import("../summarizer.js")>>>;
  const embedServerSpy = vi.fn();
  const callOrder: string[] = [];

  vi.doMock("../embeddings.js", async (importOriginal) => ({
    ...(await importOriginal()),
    ensureEmbedServer: embedServerSpy,
  }));

  // Subagent shape: <parent>/<hash>/run-N/session.jsonl (index.ts R14 pattern).
  const CTX_SUBAGENT: any = {
    sessionManager: { getSessionFile: () => "/pi/agent/sessions/sess-current/ab12cd34/run-3/session.jsonl" },
    cwd: "/test/sr-handler",
  };

  beforeEach(async () => {
    db = createDb();
    messages = [];
    callOrder.length = 0;
    mockCompleteReset();
    G.__sessionRecallLoaded__ = false;
    G.__sessionRecallMergeInProgress__ = false;
    G.__sessionRecallLlmBusy__ = false;

    realSummarizer = await vi.importActual<typeof import("../summarizer.js")>("../summarizer.js");
    embedServerSpy.mockReset();
    embedServerSpy.mockImplementation(async () => {
      callOrder.push("ensureEmbedServer");
      return { status: "ready", source: "probe", port: 5002 };
    });

    // Fresh module instances (resetModules re-runs the vi.mock factories) — the
    // spies must target the same instances the freshly imported ../index.js binds to.
    vi.resetModules();
    loggerFresh = await import("../logger.js");
    logSpy = vi.spyOn(loggerFresh, "log").mockImplementation(m => messages.push(m));
    const freshSummarizer = await import("../summarizer.js");
    const freshDiscoverer = await import("../discoverer.js");
    freshSummarizer.runMergeFold.mockReset();
    freshSummarizer.packMergeChunks.mockReset().mockImplementation((...args: any[]) => realSummarizer.packMergeChunks(...args));
    freshSummarizer.runLtTableConversion.mockReset().mockImplementation((...args: any[]) => realSummarizer.runLtTableConversion(...args));
    freshDiscoverer.discoverSessions.mockReset().mockResolvedValue([]);

    const mod = await import("../index.js");
    const captured: Record<string, (...args: any[]) => any> = {};
    mod.default({
      on: (name: string, cb: (...args: any[]) => any) => { captured[name] = cb; },
      registerTool: () => {},
      registerCommand: () => {},
    });
    handlers = captured;
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  it("subagent session file (/run-N/session.jsonl) → ensureEmbedServer never called (no probe, no spawn)", async () => {
    await handlers["session_start"]({}, CTX_SUBAGENT);
    await new Promise(r => setTimeout(r, 10));

    expect(messages.join("\n")).toContain("subagent session, skipping merge"); // handler ran to the R14 return
    expect(embedServerSpy).not.toHaveBeenCalled();
    expect(callOrder).toEqual([]);
  });

  it("parent session passing every gate → ensureEmbedServer called exactly once, immediately before runMergeFold", async () => {
    seedUnmerged(db, PATH_A, "content-A " + "a".repeat(100), 5, "2026-01-01T00:00:00.000Z");
    seedUnmerged(db, PATH_B, "content-B " + "b".repeat(100), 5, "2026-01-01T01:00:00.000Z");

    const freshSummarizer = await import("../summarizer.js");
    const freshDiscoverer = await import("../discoverer.js");
    freshSummarizer.openCacheDb.mockResolvedValue(db);
    freshSummarizer.shouldSkipByTime.mockResolvedValue(false);
    freshDiscoverer.discoverSessions.mockResolvedValue(FAKE_SESSIONS);
    freshSummarizer.readLongTerm.mockResolvedValue({
      timestamp: new Date().toISOString(), summary: validTables("BASE"), charCount: 200, sessionCount: 1, mergedSessions: ["basehash"], // table summary → pre-step 'already-tables' (no conversion LLM call)
    });
    freshSummarizer.runMergeFold.mockImplementation(async () => {
      callOrder.push("runMergeFold");
      return { processedChunks: 1, lastSummary: "X", stoppedAtChunk: null, quarantinedPaths: [], busySkipped: false };
    });

    await handlers["session_start"]({}, CTX);
    await new Promise(r => setTimeout(r, 10));

    expect(embedServerSpy).toHaveBeenCalledTimes(1);
    expect(embedServerSpy).toHaveBeenCalledWith(expect.anything()); // config passed (C3 will bind the status)
    expect(callOrder).toEqual(["ensureEmbedServer", "runMergeFold"]); // probe exactly once, immediately before the fold
  });
});

// ─── Row-store fold branch (rowstore-merge C3 — design §8.1; T2 legs) ────────
// The three spec T2 legs on the real index.ts default export (existing
// handler-level pattern; mocked config/db/rowstore/ensureEmbedServer):
// (a) flag-on + ready → the engine, with the excludedPaths passthrough;
// (b) flag-on + unavailable → skip line, nothing marked;
// (c) flag-off → the legacy leg byte-identical in call order — incl. the
// zero-chunks early return staying BEFORE the status call, as today.

describe("session_start row-store fold branch (rowstore-merge C3 — T2)", () => {
  let db: any;
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let handlers: Record<string, (...args: any[]) => any>;

  const CANNED_ENGINE: RowStoreMergeResult = {
    signalsProcessed: 3, sessionsMarkedMerged: 2, sessionsFailed: [PATH_A],
    deferredSessions: 4, decisions: [], skipped: [], pruned: 6, sessionCount: 50, llmBusySkipped: false,
  };

  beforeEach(async () => {
    db = createDb();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
    mockCompleteReset();
    G.__sessionRecallLoaded__ = false;
    G.__sessionRecallMergeInProgress__ = false;
    G.__sessionRecallLlmBusy__ = false;

    vi.mocked(openCacheDb).mockReset();
    vi.mocked(shouldSkipByTime).mockReset();
    vi.mocked(readLongTerm).mockReset().mockResolvedValue(null);
    vi.mocked(writeLongTerm).mockReset();
    vi.mocked(getPrimaryModel).mockReset();
    vi.mocked(runMergeFold).mockReset();
    vi.mocked(packMergeChunks).mockReset();
    vi.mocked(runLtTableConversion).mockReset();
    vi.mocked(discoverSessions).mockReset().mockResolvedValue(FAKE_SESSIONS);
    vi.mocked(ensureEmbedServer).mockReset();
    vi.mocked(mergeSignalsIntoRowStore).mockReset().mockResolvedValue(CANNED_ENGINE);
    vi.mocked(loadConfigOnce).mockReset().mockReturnValue(DEFAULT_CONFIG);
    // 2026-10-07 fold-call-site seams — default null pair: the LLM readiness wait is
    // skipped entirely, so tests (a)–(g) keep today's exact call order and log bytes.
    vi.mocked(buildMergeModelPair).mockReset().mockReturnValue(null);
    vi.mocked(waitForLlmEndpointReady).mockReset().mockResolvedValue(true);

    const captured: Record<string, (...args: any[]) => any> = {};
    defaultExport({
      on: (name: string, cb: (...args: any[]) => any) => { captured[name] = cb; },
      registerTool: () => {},
      registerCommand: () => {},
    });
    handlers = captured;
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  async function fireSessionStart(): Promise<void> {
    await handlers["session_start"]({}, CTX);
  }

  async function flush(): Promise<void> {
    await new Promise(r => setTimeout(r, 10));
  }

  /** Gates 1–7 green on `target`: two unmerged sessions (merge_count sum 10), no quarantines. */
  function seedTwoUnmerged(target: any): void {
    seedUnmerged(target, PATH_A, "content-A " + "a".repeat(100), 5, "2026-01-01T00:00:00.000Z");
    seedUnmerged(target, PATH_B, "content-B " + "b".repeat(100), 5, "2026-01-01T01:00:00.000Z");
    vi.mocked(openCacheDb).mockResolvedValue(target);
    vi.mocked(shouldSkipByTime).mockResolvedValue(false);
  }

  it("(a) useRowStore: true + status ready → engine with the excludedPaths passthrough; fold-complete line; legacy calls NOT made", async () => {
    seedTwoUnmerged(db);
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: true });
    vi.mocked(ensureEmbedServer).mockResolvedValue({ status: "ready", source: "probe", port: 5002 });

    await fireSessionStart();
    await flush();

    expect(vi.mocked(mergeSignalsIntoRowStore)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mergeSignalsIntoRowStore)).toHaveBeenCalledWith(db, expect.objectContaining({ useRowStore: true }), { excludedPaths: [] });
    expect(vi.mocked(runMergeFold)).not.toHaveBeenCalled();
    expect(vi.mocked(runLtTableConversion)).not.toHaveBeenCalled();
    expect(vi.mocked(packMergeChunks)).not.toHaveBeenCalled();
    expect(messages).toContain("session_start: session=sess-current.jsonl row-store fold complete: 3 lesson(s), 2 session(s) marked, 1 failed, 4 deferred, 6 pruned");
    // recall-flush wiring (plan §6.1 test 1): the session-start options object carries NO
    // extractCapOverride — the engine falls through to config.lessonExtractMaxPerRun
    // (default 4). The uncapped value (null) is the /recall-flush loop's, never the
    // session-start's; the g9 suite (test/rowstore-merge.test.ts:517+) pins the engine-side
    // default-4 behavior — both layers together cover "session-start keeps today's default".
    const engineOpts = vi.mocked(mergeSignalsIntoRowStore).mock.calls[0][2];
    expect("extractCapOverride" in engineOpts).toBe(false);
  });

  it("(b) useRowStore: true + status unavailable → engine NOT called, nothing marked, skip line logged", async () => {
    seedTwoUnmerged(db);
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: true });
    vi.mocked(ensureEmbedServer).mockResolvedValue({ status: "unavailable", reason: "econnrefused", port: 5002 });

    await fireSessionStart();
    await flush();

    expect(vi.mocked(ensureEmbedServer)).toHaveBeenCalledTimes(1); // the status probe, then the leg returns
    expect(vi.mocked(mergeSignalsIntoRowStore)).not.toHaveBeenCalled();
    expect(vi.mocked(runMergeFold)).not.toHaveBeenCalled();
    expect(messages).toContain("session_start: session=sess-current.jsonl row-store merge skipped (embed server unavailable)");
    // sessions stay unmerged — monotonic, no loss (no mark-merged happened)
    expect(sqliteReadUnmergedSessionSummaries(db)).toHaveLength(2);
  });

  it("(c) useRowStore: false → legacy leg byte-identical in call order; zero-chunks early return stays BEFORE the status call; engine NOT called", async () => {
    seedTwoUnmerged(db);
    const order: string[] = [];
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: false });
    vi.mocked(runLtTableConversion).mockImplementation(async (...args: any[]) => { order.push("conversion"); return { ran: false, converted: null, skippedReason: "no-stored-summary" }; });
    vi.mocked(packMergeChunks).mockImplementation((...args: any[]) => { order.push("pack"); return [{ paths: [PATH_A], entries: ["entry-A"] }]; });
    vi.mocked(ensureEmbedServer).mockImplementation(async () => { order.push("ensureEmbedServer"); return { status: "ready", source: "probe", port: 5002 }; });
    vi.mocked(runMergeFold).mockImplementation(async () => { order.push("runMergeFold"); return { processedChunks: 1, lastSummary: "X", stoppedAtChunk: null, quarantinedPaths: [], busySkipped: false }; });

    await fireSessionStart();
    await flush();

    expect(order).toEqual(["conversion", "pack", "ensureEmbedServer", "runMergeFold"]); // today's exact order
    expect(vi.mocked(mergeSignalsIntoRowStore)).not.toHaveBeenCalled();
    expect(messages).toContain("session_start: session=sess-current.jsonl fold complete: 1/1 chunks, 0 quarantined, last summary 1 chars");

    // Zero-chunks early return (as today): conversion → pack → return BEFORE ensureEmbedServer.
    const db2 = createDb();
    seedTwoUnmerged(db2);
    vi.mocked(runLtTableConversion).mockClear().mockImplementation(async () => { order.push("conversion"); return { ran: false, converted: null, skippedReason: "no-stored-summary" }; });
    vi.mocked(packMergeChunks).mockClear().mockImplementation(() => { order.push("pack"); return []; });
    vi.mocked(ensureEmbedServer).mockClear();
    vi.mocked(runMergeFold).mockClear();
    order.length = 0;

    await fireSessionStart();
    await flush();

    expect(order).toEqual(["conversion", "pack"]); // the status call is AFTER the zero-chunks return — never reached
    expect(messages).toContain("session_start: session=sess-current.jsonl zero chunks packed (nothing to merge)");
    expect(vi.mocked(ensureEmbedServer)).not.toHaveBeenCalled();
    expect(vi.mocked(runMergeFold)).not.toHaveBeenCalled();
    expect(vi.mocked(mergeSignalsIntoRowStore)).not.toHaveBeenCalled();
    db2.close();
  });

  // ── Row-store last-fold sentinel (post-C4-flip time-gate pacing) ─────────────
  // Gate reads ROWSTORE_LAST_FOLD_MS_KEY via real sqliteGetMeta on the in-memory db; the
  // leg stamps via real sqliteSetMeta. mergeSignalsIntoRowStore = CANNED_ENGINE
  // (llmBusySkipped: false) so the stamp path is exercised.

  it("(d) row-store + fresh sentinel (< longTermMinIntervalMs) → fold skipped, sentinel NOT rewritten", async () => {
    seedTwoUnmerged(db);
    const sentinelValue = String(Date.now() - 60_000); // 1 min ago, well under 4h
    sqliteSetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY, sentinelValue);
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: true });
    vi.mocked(ensureEmbedServer).mockResolvedValue({ status: "ready", source: "probe", port: 5002 });

    await fireSessionStart();
    await flush();

    expect(vi.mocked(mergeSignalsIntoRowStore)).not.toHaveBeenCalled();
    expect(vi.mocked(runMergeFold)).not.toHaveBeenCalled();
    expect(messages).toContain("session_start: session=sess-current.jsonl skipping row-store fold (last fold was < 4.0h ago)");
    expect(sqliteGetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY)).toBe(sentinelValue); // untouched, NOT rewritten to ~now
  });

  it("(e) row-store + stale sentinel (>= longTermMinIntervalMs) → fold runs, sentinel updated to ~now", async () => {
    seedTwoUnmerged(db);
    sqliteSetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY, String(Date.now() - 5 * 3_600_000)); // 5h ago > 4h
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: true });
    vi.mocked(ensureEmbedServer).mockResolvedValue({ status: "ready", source: "probe", port: 5002 });

    const before = Date.now();
    await fireSessionStart();
    await flush();
    const after = Date.now();

    expect(vi.mocked(mergeSignalsIntoRowStore)).toHaveBeenCalledTimes(1);
    const stamped = Number(sqliteGetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY));
    expect(Number.isFinite(stamped)).toBe(true);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("(f) row-store + no sentinel → fold runs, sentinel created", async () => {
    seedTwoUnmerged(db);
    expect(sqliteGetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY)).toBeNull(); // precondition: absent
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: true });
    vi.mocked(ensureEmbedServer).mockResolvedValue({ status: "ready", source: "probe", port: 5002 });

    const before = Date.now();
    await fireSessionStart();
    await flush();
    const after = Date.now();

    expect(vi.mocked(mergeSignalsIntoRowStore)).toHaveBeenCalledTimes(1);
    const stamped = Number(sqliteGetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY));
    expect(Number.isFinite(stamped)).toBe(true);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("(g) row-store + embed server not ready → skip, NO sentinel written", async () => {
    seedTwoUnmerged(db);
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: true });
    vi.mocked(ensureEmbedServer).mockResolvedValue({ status: "unavailable", reason: "econnrefused", port: 5002 });

    await fireSessionStart();
    await flush();

    expect(vi.mocked(mergeSignalsIntoRowStore)).not.toHaveBeenCalled();
    expect(messages).toContain("session_start: session=sess-current.jsonl row-store merge skipped (embed server unavailable)");
    expect(sqliteGetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY)).toBeNull(); // never stamped
  });

  it("(h) row-store + fold failed EVERY session (0 marked, >0 failed) → sentinel NOT stamped (no interval lockout after a no-progress failure)", async () => {
    seedTwoUnmerged(db);
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: true });
    vi.mocked(ensureEmbedServer).mockResolvedValue({ status: "ready", source: "probe", port: 5002 });
    vi.mocked(mergeSignalsIntoRowStore).mockResolvedValue({
      signalsProcessed: 0, sessionsMarkedMerged: 0, sessionsFailed: [PATH_A, PATH_B],
      deferredSessions: 0, decisions: [], skipped: [], pruned: 0, sessionCount: 2, llmBusySkipped: false,
    });
    expect(sqliteGetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY)).toBeNull(); // precondition: absent

    await fireSessionStart();
    await flush();

    expect(vi.mocked(mergeSignalsIntoRowStore)).toHaveBeenCalledTimes(1);
    expect(sqliteGetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY)).toBeNull(); // a no-progress failure must NOT pace a future fold (the 2026-10-07 lockout bug)
    expect(messages).toContain("session_start: session=sess-current.jsonl row-store fold no progress (2 failed, 0 marked) — last-fold sentinel NOT stamped (next session start retries)");
  });

  it("(i) row-store + fold drained everything with zero lessons (0 marked, 0 failed) → sentinel IS stamped (only FAILED no-progress skips)", async () => {
    seedTwoUnmerged(db);
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: true });
    vi.mocked(ensureEmbedServer).mockResolvedValue({ status: "ready", source: "probe", port: 5002 });
    vi.mocked(mergeSignalsIntoRowStore).mockResolvedValue({
      signalsProcessed: 0, sessionsMarkedMerged: 0, sessionsFailed: [],
      deferredSessions: 0, decisions: [], skipped: [], pruned: 0, sessionCount: 2, llmBusySkipped: false,
    });

    const before = Date.now();
    await fireSessionStart();
    await flush();
    const after = Date.now();

    const stamped = Number(sqliteGetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY));
    expect(Number.isFinite(stamped)).toBe(true);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("(j) row-store + LLM endpoint wait wired BEFORE the engine (pair baseUrl passed through, wait precedes the fold)", async () => {
    seedTwoUnmerged(db);
    vi.mocked(loadConfigOnce).mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: true });
    vi.mocked(ensureEmbedServer).mockResolvedValue({ status: "ready", source: "probe", port: 5002 });
    const order: string[] = [];
    vi.mocked(buildMergeModelPair).mockReturnValue({
      modelObj: { baseUrl: "http://127.0.0.1:5001/v1" } as any, apiKey: "sk-none",
    });
    vi.mocked(waitForLlmEndpointReady).mockImplementation(async () => { order.push("llm-wait"); return true; });
    vi.mocked(mergeSignalsIntoRowStore).mockImplementation(async (...args: any[]) => { order.push("engine"); return CANNED_ENGINE; });

    await fireSessionStart();
    await flush();

    expect(vi.mocked(waitForLlmEndpointReady)).toHaveBeenCalledWith("http://127.0.0.1:5001/v1");
    expect(order).toEqual(["llm-wait", "engine"]); // the blip window is absorbed before any LLM work starts
  });
});