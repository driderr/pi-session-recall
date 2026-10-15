// Poison-chunk quarantine helpers (design §2.5–2.6) — T5 helper-level
// scenarios (in-memory DB, no LLM). Fold-integration scenarios land in T6.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vol } from "memfs";
import { createRequire } from "node:module";
import * as logger from "../logger.js";
import {
  ensureSchema,
  sessionPathHash,
  md5Content,
  MERGE_QUARANTINE_KEY_PREFIX,
  MERGE_QUARANTINE_RECHECK_MS,
  mergeQuarantineKey,
  readMergeQuarantine,
  upsertMergeQuarantine,
  recordMergeFailure,
  pruneMergeQuarantine,
  sqliteCountUnmergedSessions,
  packMergeChunks,
  runMergeFold,
} from "../summarizer.js";
import type { MergeQuarantineRecord } from "../summarizer.js";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";
import {
  mockCompleteReset,
  mockCompleteQueue,
  mockCompleteCalls,
} from "@earendil-works/pi-ai";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const PATH_A = "/pi/agent/sessions/sess-a.jsonl";
const PATH_B = "/pi/agent/sessions/sess-b.jsonl";
const PATH_EMPTY = "/pi/agent/sessions/sess-empty.jsonl";
const NOW = 1_800_000_000_000; // fixed epoch ms for deterministic sentinel math

/** Valid 5-section table summary (passes the T2 validateTableSummary gate) with the label row. */
function validTables(label: string): string {
  const empty = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
  const first = `## Key Decisions\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| ${label} | 1 | 1 |`;
  return [first, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
}
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
  ).run(path, content, content.length, 1, new Date(NOW).toISOString());
  db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run(content, path);
}

function metaValue(db: any, headPath: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(mergeQuarantineKey(headPath)) as { value: string } | undefined;
  return row ? row.value : null;
}

function activeSentinel(headPath: string, content: string, quarantinedAt: number): MergeQuarantineRecord {
  return { headPath, contentHash: md5Content(content), failures: 3, quarantinedAt };
}

describe("quarantine helpers (design §2.5–2.6)", () => {
  let db: any;
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = createDb();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  it("mergeQuarantineKey = prefix + sessionPathHash; md5Content is MD5 hex; recheck window is 7 days", () => {
    expect(MERGE_QUARANTINE_KEY_PREFIX).toBe("merge_quarantine:");
    expect(mergeQuarantineKey(PATH_A)).toBe("merge_quarantine:" + sessionPathHash(PATH_A));
    expect(MERGE_QUARANTINE_RECHECK_MS).toBe(7 * 24 * 60 * 60 * 1000); // 604,800,000
    expect(md5Content("abc")).toBe("900150983cd24fb0d6963f7d28e17f72"); // known MD5 vector
  });

  it("recordMergeFailure: fresh -> 1, matching hash increments, strike 3 quarantines, mismatch restarts", () => {
    const hash = md5Content("content-A");
    // No sentinel -> failures 1, quarantinedAt null, meta row written under the key.
    const r1 = recordMergeFailure(db, PATH_A, hash, NOW);
    expect(r1).toEqual({ headPath: PATH_A, contentHash: hash, failures: 1, quarantinedAt: null });
    const stored1 = JSON.parse(metaValue(db, PATH_A) as string) as MergeQuarantineRecord;
    expect(stored1).toEqual(r1);

    // Second failure, same content -> failures 2 (still accumulating).
    const r2 = recordMergeFailure(db, PATH_A, hash, NOW + 60_000);
    expect(r2.failures).toBe(2);
    expect(r2.quarantinedAt).toBeNull();

    // Third failure -> failures 3 AND quarantinedAt = injected nowMs.
    const r3 = recordMergeFailure(db, PATH_A, hash, NOW + 120_000);
    expect(r3.failures).toBe(3);
    expect(r3.quarantinedAt).toBe(NOW + 120_000);

    // Hash mismatch -> fresh count restarts at 1.
    const changedHash = md5Content("changed-A");
    const r4 = recordMergeFailure(db, PATH_A, changedHash, NOW + 180_000);
    expect(r4.failures).toBe(1);
    expect(r4.quarantinedAt).toBeNull();
    expect(r4.contentHash).toBe(changedHash);

    // Defensive: already-quarantined sentinel + matching hash -> fresh count.
    recordMergeFailure(db, PATH_A, changedHash, NOW + 240_000); // 2
    const r5 = recordMergeFailure(db, PATH_A, changedHash, NOW + 300_000); // 3 -> quarantined
    expect(r5.quarantinedAt).toBe(NOW + 300_000);
    const r6 = recordMergeFailure(db, PATH_A, changedHash, NOW + 360_000);
    expect(r6.failures).toBe(1);
    expect(r6.quarantinedAt).toBeNull();
  });

  it("readMergeQuarantine: missing -> null; corrupt JSON -> null + warn, row kept", () => {
    expect(readMergeQuarantine(db, PATH_A)).toBeNull();

    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(mergeQuarantineKey(PATH_A), "{not-json");
    expect(readMergeQuarantine(db, PATH_A)).toBeNull();
    expect(messages.join("\n")).toContain("corrupt");
    expect(metaValue(db, PATH_A)).toBe("{not-json"); // row kept
  });

  it("pruneMergeQuarantine: fully merged head deletes the sentinel row (reason merged)", () => {
    insertUnmerged(db, PATH_A, "content-A");
    upsertMergeQuarantine(db, PATH_A, activeSentinel(PATH_A, "content-A", NOW - 86_400_000));
    // A then gets fully merged (no unmerged content row for it).
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = NULL WHERE session_path = ?").run(PATH_A);

    const result = pruneMergeQuarantine(db, [], NOW);
    expect(result.cleared).toEqual([{ headPath: PATH_A, reason: "merged" }]);
    expect(result.excludedPaths).toEqual([]);
    expect(metaValue(db, PATH_A)).toBeNull();
  });

  it("pruneMergeQuarantine: content change clears the sentinel (reason content-changed)", () => {
    insertUnmerged(db, PATH_A, "content-A-v1");
    upsertMergeQuarantine(db, PATH_A, { ...activeSentinel(PATH_A, "content-A-v1"), contentHash: md5Content("stale-content") });
    // Append to A's content — the MD5 now differs from the recorded one.
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = unmerged_fresh_content || '-appended' WHERE session_path = ?").run(PATH_A);

    const rows = [{ session_path: PATH_A, unmerged_fresh_content: "content-A-v1-appended" }];
    const result = pruneMergeQuarantine(db, rows, NOW);
    expect(result.cleared).toEqual([{ headPath: PATH_A, reason: "content-changed" }]);
    expect(result.excludedPaths).toEqual([]);
    expect(metaValue(db, PATH_A)).toBeNull();
  });

  it("pruneMergeQuarantine: accumulating sentinel (quarantinedAt null) is kept and NOT excluded", () => {
    insertUnmerged(db, PATH_B, "content-B");
    upsertMergeQuarantine(db, PATH_B, { headPath: PATH_B, contentHash: md5Content("content-B"), failures: 2, quarantinedAt: null });

    const rows = [{ session_path: PATH_B, unmerged_fresh_content: "content-B" }];
    const result = pruneMergeQuarantine(db, rows, NOW);
    expect(result.excludedPaths).toEqual([]);
    expect(result.cleared).toEqual([]);
    expect(metaValue(db, PATH_B)).not.toBeNull(); // still accumulating — how a head reaches strikes 2 and 3
  });

  it("pruneMergeQuarantine: 7-day re-check expiry clears the sentinel (reason recheck-elapsed)", () => {
    insertUnmerged(db, PATH_A, "content-A");
    const hash = md5Content("content-A");
    // Exactly 7 days -> cleared (boundary: >= RECHECK_MS).
    upsertMergeQuarantine(db, PATH_A, activeSentinel(PATH_A, "content-A", NOW - MERGE_QUARANTINE_RECHECK_MS));
    const rows = [{ session_path: PATH_A, unmerged_fresh_content: "content-A" }];
    const result = pruneMergeQuarantine(db, rows, NOW);
    expect(result.cleared).toEqual([{ headPath: PATH_A, reason: "recheck-elapsed" }]);
    expect(result.excludedPaths).toEqual([]);
    expect(metaValue(db, PATH_A)).toBeNull();

    // One ms under 7 days: still active -> excluded, row kept.
    upsertMergeQuarantine(db, PATH_A, activeSentinel(PATH_A, "content-A", NOW - MERGE_QUARANTINE_RECHECK_MS + 1));
    const result2 = pruneMergeQuarantine(db, rows, NOW);
    expect(result2.cleared).toEqual([]);
    expect(result2.excludedPaths).toEqual([PATH_A]);
    expect(metaValue(db, PATH_A)).not.toBeNull();
  });

  it("pruneMergeQuarantine: active sentinel excludes the head and logs its basename", () => {
    insertUnmerged(db, PATH_A, "content-A");
    upsertMergeQuarantine(db, PATH_A, activeSentinel(PATH_A, "content-A", NOW - 86_400_000));

    const rows = [{ session_path: PATH_A, unmerged_fresh_content: "content-A" }];
    const result = pruneMergeQuarantine(db, rows, NOW);
    expect(result.excludedPaths).toEqual([PATH_A]);
    expect(result.cleared).toEqual([]);
    expect(messages.join("\n")).toContain("sess-a.jsonl"); // exclusion log carries the basename
    expect(metaValue(db, PATH_A)).not.toBeNull();
  });

  it("pruneMergeQuarantine: corrupt sentinel JSON is kept with a warn, not excluded", () => {
    insertUnmerged(db, PATH_A, "content-A");
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(mergeQuarantineKey(PATH_A), "{corrupt");

    const rows = [{ session_path: PATH_A, unmerged_fresh_content: "content-A" }];
    const result = pruneMergeQuarantine(db, rows, NOW);
    expect(result.excludedPaths).toEqual([]);
    expect(result.cleared).toEqual([]);
    expect(messages.join("\n")).toContain("corrupt");
    expect(metaValue(db, PATH_A)).toBe("{corrupt");
  });

  it("sqliteCountUnmergedSessions counts only non-NULL, non-empty unmerged rows", () => {
    insertUnmerged(db, PATH_A, "content-A");
    insertUnmerged(db, PATH_B, "content-B");
    // B fully merged (NULL) and an empty-string row must not count.
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = NULL WHERE session_path = ?").run(PATH_B);
    db.prepare(
      "INSERT INTO session_summaries (session_path, version, summary, char_count, merge_count, updated_at) VALUES (?, 1, '', 0, 0, ?)",
    ).run(PATH_EMPTY, new Date(NOW).toISOString());
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = '' WHERE session_path = ?").run(PATH_EMPTY);

    expect(sqliteCountUnmergedSessions(db)).toBe(1);
  });
});

// ─── Fold integration (design §2.7 + §2.5) — simulated session_start runs ──
// The handler (T7) composes: pruneMergeQuarantine -> packMergeChunks ->
// runMergeFold. These tests run that composition against one db across runs.

// Unique per-file memfs homedir for the LLM-level fold tests below.
vi.mock("node:os", () => ({ homedir: () => "/test/sr-merge-quarantine" }));
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

const QUAR_MODELS_JSON = {
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
const QUAR_CONFIG: SessionRecallConfig = { ...DEFAULT_CONFIG, mergeChunkChars: 100, mergeMaxChunksPerRun: 8 };
const QA_CONTENT = "Alpha fresh " + "a".repeat(100); // rendered entry > 100 -> one chunk per session
const QB_CONTENT = "Beta fresh " + "b".repeat(100);

function qUnmergedRows(db: any): Array<{ session_path: string; unmerged_fresh_content: string }> {
  return db.prepare(
    "SELECT session_path, unmerged_fresh_content FROM session_summaries " +
    "WHERE unmerged_fresh_content IS NOT NULL AND length(unmerged_fresh_content) > 0 " +
    "ORDER BY updated_at ASC",
  ).all();
}

function qUnmergedContent(db: any, path: string): string | null {
  return (db.prepare("SELECT unmerged_fresh_content AS c FROM session_summaries WHERE session_path = ?").get(path) as { c: string | null } | undefined)?.c ?? null;
}

function errorResponse(): unknown {
  return { content: [], stopReason: "error", errorMessage: "boom" };
}

describe("quarantine fold integration (design §2.7 + §2.5)", () => {
  let db: any;
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = createDb();
    vol.fromJSON({
      ["/test/sr-merge-quarantine/.pi/agent/models.json"]: JSON.stringify(QUAR_MODELS_JSON),
      ["/test/sr-merge-quarantine/.pi/agent/.keep"]: "",
    });
    mockCompleteReset();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  it("3-run sequence: strikes 1-2 stop the run; strike 3 quarantines, skips, and continues", async () => {
    insertUnmerged(db, PATH_A, QA_CONTENT);
    insertUnmerged(db, PATH_B, QB_CONTENT);

    // Run 1: head A fails (no sentinel) -> sentinel failures 1, run stops before B.
    mockCompleteQueue(errorResponse());
    let result = await runMergeFold(db, packMergeChunks(qUnmergedRows(db), QUAR_CONFIG.mergeChunkChars), "", [], QUAR_CONFIG, { now: () => NOW });
    expect(result.stoppedAtChunk).toBe(0);
    expect(mockCompleteCalls()).toHaveLength(1);
    let sentinel = JSON.parse(metaValue(db, PATH_A) as string) as MergeQuarantineRecord;
    expect(sentinel.failures).toBe(1);
    expect(sentinel.quarantinedAt).toBeNull();
    expect(qUnmergedContent(db, PATH_B)).toBe(QB_CONTENT); // B never touched

    // Run 2: A fails again -> failures 2, run stops again.
    mockCompleteReset(); // per-run call counting (design §4.2: run 3 makes 2 calls)
    mockCompleteQueue(errorResponse());
    result = await runMergeFold(db, packMergeChunks(qUnmergedRows(db), QUAR_CONFIG.mergeChunkChars), "", [], QUAR_CONFIG, { now: () => NOW });
    expect(result.stoppedAtChunk).toBe(0);
    expect(mockCompleteCalls()).toHaveLength(1);
    sentinel = JSON.parse(metaValue(db, PATH_A) as string) as MergeQuarantineRecord;
    expect(sentinel.failures).toBe(2);
    expect(sentinel.quarantinedAt).toBeNull();

    // Run 3: A fails (strike 3 -> quarantined, chunk skipped, run continues); B succeeds.
    mockCompleteReset();
    mockCompleteQueue(errorResponse());
    mockCompleteQueue({ content: [{ type: "text", text: validTables("MERGED-B") }], stopReason: "stop" });
    result = await runMergeFold(db, packMergeChunks(qUnmergedRows(db), QUAR_CONFIG.mergeChunkChars), "", [], QUAR_CONFIG, { now: () => NOW });
    expect(result.quarantinedPaths).toEqual([PATH_A]);
    expect(result.processedChunks).toBe(1);
    expect(result.stoppedAtChunk).toBeNull();
    expect(mockCompleteCalls()).toHaveLength(2); // LLM called for the chunk containing B
    sentinel = JSON.parse(metaValue(db, PATH_A) as string) as MergeQuarantineRecord;
    expect(sentinel.failures).toBe(3);
    expect(sentinel.quarantinedAt).toBe(NOW); // injected now
    expect(messages.join("\n")).toContain("quarantined sess-a.jsonl");
    expect(qUnmergedContent(db, PATH_A)).toBe(QA_CONTENT); // A still unmerged
    expect(qUnmergedContent(db, PATH_B)).toBeNull(); // B marked merged
  });

  it("active sentinel is skipped at run start; the remaining sessions are processed", async () => {
    insertUnmerged(db, PATH_A, QA_CONTENT);
    insertUnmerged(db, PATH_B, QB_CONTENT);
    upsertMergeQuarantine(db, PATH_A, {
      headPath: PATH_A,
      contentHash: md5Content(QA_CONTENT),
      failures: 3,
      quarantinedAt: NOW - 86_400_000, // 1 day ago — active
    });

    const rows = qUnmergedRows(db);
    const { excludedPaths, cleared } = pruneMergeQuarantine(db, rows, NOW);
    expect(cleared).toEqual([]);
    expect(excludedPaths).toEqual([PATH_A]);
    expect(messages.join("\n")).toContain("sess-a.jsonl"); // exclusion log carries the basename

    const packable = rows.filter(r => !excludedPaths.includes(r.session_path));
    expect(packable.map(r => r.session_path)).toEqual([PATH_B]);
    mockCompleteQueue({ content: [{ type: "text", text: validTables("MERGED-B") }], stopReason: "stop" });
    const result = await runMergeFold(db, packMergeChunks(packable, QUAR_CONFIG.mergeChunkChars), "", [], QUAR_CONFIG);
    expect(result.processedChunks).toBe(1);
    expect(mockCompleteCalls()).toHaveLength(1); // LLM called without A
    expect(qUnmergedContent(db, PATH_B)).toBeNull();
    expect(qUnmergedContent(db, PATH_A)).toBe(QA_CONTENT);
  });

  it("content change clears the sentinel; a failing retry restarts the count at 1", async () => {
    insertUnmerged(db, PATH_A, QA_CONTENT);
    insertUnmerged(db, PATH_B, QB_CONTENT);
    upsertMergeQuarantine(db, PATH_A, {
      headPath: PATH_A,
      contentHash: md5Content("stale-content"), // hash no longer matches
      failures: 3,
      quarantinedAt: NOW - 86_400_000,
    });
    // Append to A's content — the recorded hash is now stale.
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = unmerged_fresh_content || '-appended' WHERE session_path = ?").run(PATH_A);

    const rows = qUnmergedRows(db);
    const { excludedPaths, cleared } = pruneMergeQuarantine(db, rows, NOW);
    expect(cleared).toEqual([{ headPath: PATH_A, reason: "content-changed" }]);
    expect(excludedPaths).toEqual([]); // A re-included

    // A's chunk fails in this run -> fresh sentinel starts at failures 1.
    mockCompleteQueue(errorResponse());
    const result = await runMergeFold(db, packMergeChunks(rows, QUAR_CONFIG.mergeChunkChars), "", [], QUAR_CONFIG, { now: () => NOW });
    expect(result.stoppedAtChunk).toBe(0);
    const sentinel = JSON.parse(metaValue(db, PATH_A) as string) as MergeQuarantineRecord;
    expect(sentinel.failures).toBe(1);
    expect(sentinel.quarantinedAt).toBeNull();
  });

  it("7-day expiry: sentinel cleared (recheck-elapsed); a failing retry restarts the count at 1", async () => {
    insertUnmerged(db, PATH_A, QA_CONTENT);
    insertUnmerged(db, PATH_B, QB_CONTENT);
    upsertMergeQuarantine(db, PATH_A, {
      headPath: PATH_A,
      contentHash: md5Content(QA_CONTENT),
      failures: 3,
      quarantinedAt: NOW - MERGE_QUARANTINE_RECHECK_MS, // exactly 7 days
    });

    const rows = qUnmergedRows(db);
    const { excludedPaths, cleared } = pruneMergeQuarantine(db, rows, NOW);
    expect(cleared).toEqual([{ headPath: PATH_A, reason: "recheck-elapsed" }]);
    expect(excludedPaths).toEqual([]);

    mockCompleteQueue(errorResponse());
    const result = await runMergeFold(db, packMergeChunks(rows, QUAR_CONFIG.mergeChunkChars), "", [], QUAR_CONFIG, { now: () => NOW });
    expect(result.stoppedAtChunk).toBe(0);
    const sentinel = JSON.parse(metaValue(db, PATH_A) as string) as MergeQuarantineRecord;
    expect(sentinel.failures).toBe(1);
    expect(sentinel.quarantinedAt).toBeNull();
  });

  it("fully merged head deletes the row (merged); accumulating sentinel neither excluded nor deleted", async () => {
    insertUnmerged(db, PATH_A, QA_CONTENT);
    insertUnmerged(db, PATH_B, QB_CONTENT);
    upsertMergeQuarantine(db, PATH_A, { headPath: PATH_A, contentHash: md5Content(QA_CONTENT), failures: 3, quarantinedAt: NOW - 86_400_000 });
    upsertMergeQuarantine(db, PATH_B, { headPath: PATH_B, contentHash: md5Content(QB_CONTENT), failures: 2, quarantinedAt: null });
    // A then gets fully merged.
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = NULL WHERE session_path = ?").run(PATH_A);

    const rows = qUnmergedRows(db);
    const { excludedPaths, cleared } = pruneMergeQuarantine(db, rows, NOW);
    expect(cleared).toEqual([{ headPath: PATH_A, reason: "merged" }]);
    expect(excludedPaths).toEqual([]); // B's accumulating sentinel does NOT exclude
    expect(metaValue(db, PATH_B)).not.toBeNull(); // still accumulating

    mockCompleteQueue({ content: [{ type: "text", text: validTables("MERGED-B") }], stopReason: "stop" }); // success for B's chunk

    const result = await runMergeFold(db, packMergeChunks(rows, QUAR_CONFIG.mergeChunkChars), "", [], QUAR_CONFIG);
    expect(result.processedChunks).toBe(1);
    expect(mockCompleteCalls()).toHaveLength(1); // only B's chunk
    expect(qUnmergedContent(db, PATH_B)).toBeNull();
  });
});
