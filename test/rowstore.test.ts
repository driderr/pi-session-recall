// rowstore.test.ts — rowstore-storage C2 unit suite (design §9.1, 14 RED-first groups).
//
// In-memory better-sqlite3 fixtures (`:memory:` via createRequire — house live
// pattern), the house log spy (vi.spyOn(logger, "log")) for byte-exact LTROW
// assertions, a deterministic fake table-text builder (all five PINNED_SECTIONS
// headers + `| Item | Score | Last-Seen |` table headers → parseable === true),
// and a unit-vector helper with known cosines. No HTTP in this suite: the
// embed is injected via the BackfillIo.embed seam (deterministic fake vectors).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import * as logger from "../logger.js";
import * as rowstore from "../rowstore.js";
import { cosineSimilarity, type EmbedKind } from "../embeddings.js";
import { DEFAULT_CONFIG } from "../config.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const EMBED_DIM = 768;

// ─── Shared mechanics (design §9.0 — pinned) ─────────────────────────────────

/** A zero vector except basis index i (cosine 0 between distinct basis vectors). */
const basisVec = (i: number, dim: number = EMBED_DIM): number[] => {
  const v = new Array(dim).fill(0);
  v[i] = 1;
  return v;
};

/** A 768-dim vector whose cosine with the e0 axis is ≈ `c` (first two components). */
const axisVec = (c: number, dim: number = EMBED_DIM): number[] => {
  const v = new Array(dim).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(Math.max(0, 1 - c * c));
  return v;
};

/** Deterministic embed seam: maps item text → a pre-chosen vector; records calls. */
const fakeEmbedFor = (vecMap: Record<string, number[]>) => {
  const calls: { texts: string[]; kind: EmbedKind }[] = [];
  const fn = async (texts: string[], kind: EmbedKind): Promise<number[][] | null> => {
    calls.push({ texts, kind });
    return texts.map((t) => {
      const v = vecMap[t];
      if (!v) throw new Error(`fake embed: no vector for "${t}"`);
      return v;
    });
  };
  return { fn, calls };
};

/** A fake embed seam that returns null on its Nth call (1-based) — chunk-null tests. */
const nullEmbedOnCall = (vecMap: Record<string, number[]>, failOnCall: number) => {
  let callCount = 0;
  const calls: { texts: string[]; kind: EmbedKind }[] = [];
  const fn = async (texts: string[], kind: EmbedKind): Promise<number[][] | null> => {
    callCount++;
    calls.push({ texts, kind });
    if (callCount === failOnCall) return null;
    return texts.map((t) => {
      const v = vecMap[t];
      if (!v) throw new Error(`fake embed: no vector for "${t}"`);
      return v;
    });
  };
  return { fn, calls };
};

const SECTION_NAMES = [
  "Key Decisions",
  "Patterns & Conventions",
  "Configuration",
  "Lessons Learned",
  "Open Issues",
] as const;

type RowSpec = { item: string; score?: number; lastSeen?: number | string };

/** Deterministic fake table-text builder: all five pinned sections with table
 *  headers (→ parseable === true) unless `omitHeaderFor` drops one section's
 *  table header (→ parseable === false). Empty sections get the (none)
 *  placeholder row (which is NOT a table header). */
const buildBlob = (sections: Record<string, RowSpec[]>, omitHeaderFor?: string): string => {
  const parts: string[] = [];
  for (const name of SECTION_NAMES) {
    const rows = sections[name] ?? [];
    let part = `## ${name}`;
    if (name !== omitHeaderFor) {
      part += `\n| Item | Score | Last-Seen |\n|------|-------|-----------|`;
    }
    if (rows.length === 0) {
      part += `\n| (none) | | |`;
    } else {
      for (const r of rows) {
        part += `\n| ${r.item} | ${r.score ?? 1} | ${r.lastSeen ?? 1084} |`;
      }
    }
    parts.push(part);
  }
  return parts.join("\n\n");
};

/** vecMap for N distinct items → distinct basis vectors (mutual cosine 0). */
const basisVecMap = (items: string[]): Record<string, number[]> =>
  Object.fromEntries(items.map((t, i) => [t, basisVec(i)]));

describe("rowstore.ts (rowstore-storage C2) — unit suite (design §9.1)", () => {
  let db: any;
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new Database(":memory:");
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation((m: string) => {
      messages.push(m);
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    db.close();
  });

  // ─── Unit 1 — schema idempotence (R1) ───────────────────────────────────────

  describe("unit 1 — schema idempotence (R1, P1)", () => {
    it("creates exactly the pinned long_term_rows DDL on a fresh db", () => {
      rowstore.ensureRowStoreSchema(db);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).toEqual(["long_term_rows"]);
      const ddl = (
        db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'long_term_rows'").get() as { sql: string }
      ).sql;
      // P1 — the plan §5 DDL as-is (column definitions + inline comments).
      expect(ddl).toContain("CREATE TABLE long_term_rows"); // sqlite_master strips `IF NOT EXISTS` from the stored SQL; the idempotency pin is the double-apply test below
      expect(ddl).toContain("id INTEGER PRIMARY KEY AUTOINCREMENT");
      expect(ddl).toContain("item TEXT NOT NULL");
      expect(ddl).toContain("score INTEGER NOT NULL DEFAULT 1");
      expect(ddl).toContain("last_seen INTEGER NOT NULL");
      expect(ddl).toContain("-- session_count at merge time (monotonic)");
      expect(ddl).toContain("embedding TEXT NOT NULL");
      expect(ddl).toContain("-- JSON-encoded float[768]");
      // No section column, no index.
      expect(ddl.toLowerCase()).not.toContain("section");
      const cols = db.prepare("PRAGMA table_info(long_term_rows)").all() as Array<{ name: string; dflt_value: string | null }>;
      expect(cols.map((c) => c.name)).toEqual(["id", "item", "score", "last_seen", "embedding", "corrected_at"]);
      const scoreCol = cols.find((c) => c.name === "score")!;
      expect(scoreCol.dflt_value).toBe("1");
      const userIndexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'long_term_rows' AND name NOT LIKE 'sqlite_%'")
        .all();
      expect(userIndexes).toEqual([]);
    });

    it("double-apply is a no-op (schema + rows unchanged)", () => {
      rowstore.ensureRowStoreSchema(db);
      rowstore.insertRow(db, { item: "a", score: 2, lastSeen: 10, embedding: basisVec(0) });
      const before = db.prepare("SELECT * FROM long_term_rows ORDER BY id").all();
      expect(() => rowstore.ensureRowStoreSchema(db)).not.toThrow();
      const after = db.prepare("SELECT * FROM long_term_rows ORDER BY id").all();
      expect(after).toEqual(before);
    });

    it("public entries self-ensure (insertRow on a fresh db, no explicit ensure)", () => {
      const id = rowstore.insertRow(db, { item: "self-ensure", score: 1, lastSeen: 5, embedding: basisVec(1) });
      expect(id).toBe(1);
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'long_term_rows'").get();
      expect(table).toBeTruthy();
    });
  });

  // ─── Unit 2 — CRUD round-trip (R3) ──────────────────────────────────────────

  describe("unit 2 — CRUD round-trip (R3)", () => {
    it("insertRow returns sequential ids; embedding is JSON text on disk, number[] on read", () => {
      const emb = axisVec(0.7);
      const id1 = rowstore.insertRow(db, { item: "first", score: 3, lastSeen: 100, embedding: emb });
      const id2 = rowstore.insertRow(db, { item: "second", score: 1, lastSeen: 200, embedding: basisVec(9) });
      expect(id1).toBe(1);
      expect(id2).toBe(2);
      const raw = db.prepare("SELECT embedding FROM long_term_rows WHERE id = ?").get(1) as { embedding: unknown };
      expect(typeof raw.embedding).toBe("string");
      expect((raw.embedding as string).startsWith("[")).toBe(true);
      const rows = rowstore.getRows(db);
      expect(rows).toHaveLength(2);
      expect(rows[0].embedding).toEqual(emb);
    });

    it("getRows on a fresh db returns []; order is id ASC", () => {
      rowstore.ensureRowStoreSchema(db);
      expect(rowstore.getRows(db)).toEqual([]);
      rowstore.insertRow(db, { item: "c", score: 1, lastSeen: 1, embedding: basisVec(2) });
      rowstore.insertRow(db, { item: "a", score: 1, lastSeen: 2, embedding: basisVec(3) });
      rowstore.insertRow(db, { item: "b", score: 1, lastSeen: 3, embedding: basisVec(4) });
      const rows = rowstore.getRows(db);
      expect(rows.map((r) => r.item)).toEqual(["c", "a", "b"]);
      expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    });

    it("updateRowScoreAndLastSeen changes only score/last_seen; 1 on hit, 0 on missing id (no throw)", () => {
      const id = rowstore.insertRow(db, { item: "upd", score: 2, lastSeen: 10, embedding: basisVec(5) });
      const rawBefore = db.prepare("SELECT item, embedding FROM long_term_rows WHERE id = ?").get(id) as {
        item: string;
        embedding: string;
      };
      expect(rowstore.updateRowScoreAndLastSeen(db, id, 7, 999)).toBe(1);
      const row = rowstore.getRows(db)[0];
      expect(row.score).toBe(7);
      expect(row.lastSeen).toBe(999);
      const rawAfter = db.prepare("SELECT item, embedding FROM long_term_rows WHERE id = ?").get(id) as {
        item: string;
        embedding: string;
      };
      expect(rawAfter.item).toBe(rawBefore.item);
      expect(rawAfter.embedding).toBe(rawBefore.embedding); // byte-identical
      expect(rowstore.updateRowScoreAndLastSeen(db, 9999, 1, 1)).toBe(0);
    });

    it("deleteRow returns 1 and removes the row; missing id → 0, no throw", () => {
      const id = rowstore.insertRow(db, { item: "del", score: 1, lastSeen: 1, embedding: basisVec(6) });
      expect(rowstore.deleteRow(db, id)).toBe(1);
      expect(rowstore.getRows(db)).toEqual([]);
      expect(rowstore.deleteRow(db, 4242)).toBe(0);
    });

    it("corrupt embedding column fails loudly (JSON.parse throw propagates — no fallback)", () => {
      const id = rowstore.insertRow(db, { item: "corrupt", score: 1, lastSeen: 1, embedding: basisVec(7) });
      db.prepare("UPDATE long_term_rows SET embedding = ? WHERE id = ?").run("not-json{", id);
      expect(() => rowstore.getRows(db)).toThrow();
    });
  });

  // ─── Frozen export surface (R2, P2) ─────────────────────────────────────────

  // rowstore-merge C3 (design §1.2) EXTENDS the frozen surface with exactly two
  // value exports (mergeSignalsIntoRowStore + ROWSTORE_MERGE_LLM_TIMEOUT_MS) and
  // the §1.2 types (erased at runtime); rowstore-lessons C3.5 (design §1.2)
  // EXTENDS the C3 surface with exactly four more value exports
  // (EXTRACT_LLM_TIMEOUT_MS + normalizeLesson +
  // updateRowItemEmbeddingScoreAndLastSeen + LESSON_LINE_MAX_CHARS — task 7.6,
  // the pre-LIVE fix batch) — onLlmCall / enrich are additive
  // option + detail fields (type-level, erased at runtime). The C2/C3 entries
  // stay untouched — the list below is the C2 pin plus the C3 + C3.5 additions
  // (additions only; nothing renamed). §15 (task 15.2) adds exactly ONE more
  // export — enrichMatchedRow — the repair vehicle's replay seam (the
  // per-lesson pipeline is not re-runnable; the export-surface pin re-keyed
  // ADDITIVELY per the C2 P2 precedent). rowstore-injection C4 (design §1) adds
  // exactly ONE more — getRowsForInjection — the flip's injection read (the pin
  // re-keyed ADDITIVELY per the same precedent; the freeze re-bases at C5).
  // correction-recency-injection unit B (design §5 / P5) adds exactly ONE more
  // — getRecentCorrections — the RECENT CORRECTIONS section's recency read (the
  // pin re-keyed ADDITIVELY per the same precedent — the C5 re-base; 13.2(a)
  // export-surface diff: rowstore.ts +1, exactly this one).
  it("frozen export surface (P2): exactly the pinned exports; BACKFILL_EMBED_CHUNK_SIZE === 50", () => {
    const names = Object.keys(rowstore).sort();
    expect(names).toEqual([
      "BACKFILL_EMBED_CHUNK_SIZE",
      "EXTRACT_LLM_TIMEOUT_MS",
      "LESSON_LINE_MAX_CHARS",
      "ROWSTORE_LAST_FOLD_MS_KEY",
      "ROWSTORE_MERGE_LLM_TIMEOUT_MS",
      "backfillRowStoreFromTableText",
      "deleteRow",
      "enrichMatchedRow",
      "ensureRowStoreSchema",
      "findCandidates",
      "getRecentCorrections",
      "getRows",
      "getRowsForInjection",
      "insertRow",
      "mergeSignalsIntoRowStore",
      "normalizeLesson",
      "pruneStaleRowsInStore",
      "updateRowItemEmbeddingScoreAndLastSeen",
      "updateRowScoreAndLastSeen",
    ]);
    expect(rowstore.BACKFILL_EMBED_CHUNK_SIZE).toBe(50);
    expect(rowstore.ROWSTORE_MERGE_LLM_TIMEOUT_MS).toBe(300_000); // C3 P4 — the 5-min constant
    expect(rowstore.LESSON_LINE_MAX_CHARS).toBe(5_000); // task 7.6 — the lesson-line char budget (≈1,490 tokens ≈ 27% headroom under the 2,048-token server cap)
  });

  // ─── Unit 3 — findCandidates (R4, P8) ──────────────────────────────────────

  describe("unit 3 — findCandidates (R4, P8)", () => {
    const q = basisVec(0); // query vector e0 — cosine with axisVec(c) is ≈ c

    it("inclusive >= boundary: row at sim === threshold is included, one below is excluded (P8)", () => {
      const vAt = axisVec(0.5);
      const vBelow = axisVec(0.4);
      rowstore.insertRow(db, { item: "at", score: 1, lastSeen: 1, embedding: vAt });
      rowstore.insertRow(db, { item: "below", score: 1, lastSeen: 1, embedding: vBelow });
      const threshold = cosineSimilarity(q, vAt); // exactly row "at"'s own similarity
      const hits = rowstore.findCandidates(db, q, threshold, 10);
      expect(hits.map((h) => h.row.item)).toEqual(["at"]);
      expect(hits[0].similarity).toBeCloseTo(0.5, 10);
    });

    it("top-K cap: 6 rows above threshold, topK = 3 → exactly the 3 highest by similarity", () => {
      const sims = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
      for (const [i, s] of sims.entries()) {
        rowstore.insertRow(db, { item: `r${i}`, score: 1, lastSeen: 1, embedding: axisVec(s) });
      }
      const hits = rowstore.findCandidates(db, q, 0.1, 3);
      expect(hits).toHaveLength(3);
      expect(hits.map((h) => h.row.item)).toEqual(["r0", "r1", "r2"]);
      expect(hits[0].similarity).toBeGreaterThanOrEqual(hits[1].similarity);
      expect(hits[1].similarity).toBeGreaterThanOrEqual(hits[2].similarity);
    });

    it("equal similarities → id ASC tiebreak (smaller id first)", () => {
      const v = axisVec(0.6);
      for (const item of ["first", "second", "third"]) {
        rowstore.insertRow(db, { item, score: 1, lastSeen: 1, embedding: v });
      }
      const hits = rowstore.findCandidates(db, q, 0.5, 10);
      expect(hits.map((h) => h.row.item)).toEqual(["first", "second", "third"]);
      expect(hits.map((h) => h.row.id)).toEqual([1, 2, 3]);
    });

    it("empty store → []", () => {
      expect(rowstore.findCandidates(db, q, 0.5, 5)).toEqual([]);
    });

    it("non-empty store, no row at/above threshold → []", () => {
      rowstore.insertRow(db, { item: "low", score: 1, lastSeen: 1, embedding: axisVec(0.2) });
      rowstore.insertRow(db, { item: "lower", score: 1, lastSeen: 1, embedding: axisVec(0.3) });
      expect(rowstore.findCandidates(db, q, 0.5, 5)).toEqual([]);
    });

    it("dimension-mismatched query (4-dim vs 768-dim rows) at threshold 0.5 → [], no throw", () => {
      rowstore.insertRow(db, { item: "row768", score: 1, lastSeen: 1, embedding: basisVec(1) });
      const mismatch = basisVec(0, 4);
      expect(() => rowstore.findCandidates(db, mismatch, 0.5, 5)).not.toThrow();
      expect(rowstore.findCandidates(db, mismatch, 0.5, 5)).toEqual([]);
    });
  });

  // ─── Unit 9 — pruneStaleRowsInStore (R5, P3) ───────────────────────────────

  describe("unit 9 — pruneStaleRowsInStore (R5, P3)", () => {
    it("strict > / strict < boundary (P8): age 101 + score 2 pruned; age 100 / score 3 / age 0 / future-dated survive", () => {
      // currentSessionCount = 1000, config defaults stalePruneAfterSessions = 100 / stalePruneMinScore = 3
      const rows: Array<{ item: string; score: number; lastSeen: number; kept: boolean }> = [
        { item: "age0-score1", score: 1, lastSeen: 1000, kept: true },    // matched row — never pruned
        { item: "age101-score2", score: 2, lastSeen: 899, kept: false },  // 101 > 100 AND 2 < 3 → pruned
        { item: "age100-score2", score: 2, lastSeen: 900, kept: true },   // 100 > 100 is false — at-limit survives
        { item: "age101-score3", score: 3, lastSeen: 899, kept: true },   // 3 < 3 is false
        { item: "future-score1", score: 1, lastSeen: 1100, kept: true },  // clamps to age 0
      ];
      for (const r of rows) rowstore.insertRow(db, { item: r.item, score: r.score, lastSeen: r.lastSeen, embedding: basisVec(rows.indexOf(r)) });
      const deleted = rowstore.pruneStaleRowsInStore(db, DEFAULT_CONFIG, 1000);
      expect(deleted).toBe(1);
      expect(rowstore.getRows(db).map((r) => r.item)).toEqual(rows.filter((r) => r.kept).map((r) => r.item));
      expect(messages).toContain("LTROW PRUNED 1"); // P3 — byte-exact
    });

    it("returns the deleted count and emits LTROW PRUNED 0 when nothing is prunable", () => {
      rowstore.insertRow(db, { item: "fresh", score: 1, lastSeen: 1000, embedding: basisVec(20) });
      const deleted = rowstore.pruneStaleRowsInStore(db, DEFAULT_CONFIG, 1000);
      expect(deleted).toBe(0);
      expect(rowstore.getRows(db)).toHaveLength(1);
      expect(messages).toContain("LTROW PRUNED 0"); // n = 0 line — greppable record the prune ran
    });
  });

  // ─── Unit 4 — hybrid last_seen, Decision 1 (R7, P8) ───────────────────────

  describe("unit 4 — hybrid last_seen (R7, Decision 1, P8)", () => {
    it("valid lastSeen kept verbatim; 0-fallback and explicit-0 cell → sessionCount; sessionCount kept", async () => {
      const items = ["valid-963", "missing-cell", "explicit-zero", "equal-sesscount"];
      const summary = buildBlob({
        "Key Decisions": [
          { item: "valid-963", score: 2, lastSeen: 963 },
          { item: "missing-cell", score: 1, lastSeen: "" }, // parser's missing-cell fallback → 0
          { item: "explicit-zero", score: 1, lastSeen: "0" }, // P8 — exactly-0 boundary (TRIANGULATE)
          { item: "equal-sesscount", score: 1, lastSeen: 1084 }, // valid, indistinguishable from fallback
        ],
      });
      const { fn } = fakeEmbedFor(basisVecMap(items));
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBeNull();
      const byItem = Object.fromEntries(rowstore.getRows(db).map((r) => [r.item, r]));
      expect(byItem["valid-963"].lastSeen).toBe(963); // parsed Last-Seen when valid (> 0)
      expect(byItem["missing-cell"].lastSeen).toBe(1084); // 0 → blob-level session_count
      expect(byItem["explicit-zero"].lastSeen).toBe(1084); // strict > 0 predicate
      expect(byItem["equal-sesscount"].lastSeen).toBe(1084);
    });
  });

  // ─── Unit 11 — parseable === false abort (R6) ──────────────────────────────

  describe("unit 11 — unparseable source aborts with zero writes (R6)", () => {
    it("missing one section's table header → aborted=unparseable, empty store, exact ABORT line, no other lines", async () => {
      const { fn } = fakeEmbedFor(basisVecMap(["x"]));
      const summary = buildBlob({ "Key Decisions": [{ item: "x", score: 1, lastSeen: 100 }] }, "Open Issues");
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBe("unparseable");
      expect(rowstore.getRows(db)).toEqual([]); // zero writes
      expect(messages).toContain("LTROW BACKFILL ABORT reason=unparseable inserted=0"); // P3 byte
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL")).length).toBe(1);
      expect(messages.some((m) => m.includes("NEAR"))).toBe(false);
    });
  });

  // ─── Unit 14 — empty-but-parseable source completes (R6) ──────────────────

  describe("unit 14 — empty-but-parseable source completes (R6)", () => {
    it("all-(none) blob → completed run, n=0, zero embed calls, zero rows, summary not abort", async () => {
      const { fn, calls } = fakeEmbedFor({});
      const summary = buildBlob({});
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBeNull();
      expect(report.parsed).toBe(0);
      expect(report.inserted).toBe(0);
      expect(report.storeRows).toBe(0);
      expect(calls).toHaveLength(0); // zero embed calls
      expect(messages).toContain("LTROW BACKFILL n=0 dups_dropped=0 near_dup_clusters=0");
      expect(messages.some((m) => m.includes("ABORT"))).toBe(false);
    });
  });

  // ─── Unit 7 part 1 — fresh insert run (R10) ────────────────────────────────

  describe("unit 7 — backfill modes (R10/R11)", () => {
    it("part 1: fresh insert run on a fresh db inserts every unique row, summary line logged", async () => {
      const items = ["a-1", "a-2", "a-3"];
      const summary = buildBlob({ "Key Decisions": items.map((item) => ({ item, score: 1, lastSeen: 500 })) });
      const { fn } = fakeEmbedFor(basisVecMap(items));
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBeNull();
      expect(report.parsed).toBe(3);
      expect(report.inserted).toBe(3);
      expect(report.storeRows).toBe(3);
      expect(report.inserted).toBe(report.storeRows);
      expect(messages).toContain("LTROW BACKFILL n=3 dups_dropped=0 near_dup_clusters=0");
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL")).length).toBe(1);
    });
  });

  // ─── Unit 5 — exact-text dedup (R8, P3) ────────────────────────────────────

  describe("unit 5 — exact-text dedup (R8, P3)", () => {
    const T = "reuse database connections across requests";

    it("two-way dup keeps the highest score, dupsDropped = 1, exactly one byte-exact DUP line (P3)", async () => {
      const summary = buildBlob({
        "Key Decisions": [
          { item: T, score: 2, lastSeen: 100 },
          { item: T, score: 5, lastSeen: 200 },
        ],
      });
      const { fn, calls } = fakeEmbedFor({ [T]: basisVec(0) });
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBeNull();
      expect(report.parsed).toBe(2);
      expect(report.dupsDropped).toBe(1);
      const rows = rowstore.getRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].score).toBe(5);
      // Dedup runs BEFORE embedding — no wasted embed calls on collapsed rows.
      expect(calls).toHaveLength(1);
      expect(calls[0].texts).toEqual([T]);
      expect(messages).toContain(`LTROW BACKFILL DUP item="${T}" kept_score=5 dropped=1`);
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL DUP")).length).toBe(1);
    });

    it("3-way dup → dupsDropped = 2, exactly ONE DUP line with dropped=2", async () => {
      const summary = buildBlob({
        "Key Decisions": [
          { item: T, score: 1, lastSeen: 100 },
          { item: T, score: 3, lastSeen: 200 },
          { item: T, score: 2, lastSeen: 300 },
        ],
      });
      const { fn } = fakeEmbedFor({ [T]: basisVec(0) });
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.dupsDropped).toBe(2);
      expect(rowstore.getRows(db)).toHaveLength(1);
      expect(rowstore.getRows(db)[0].score).toBe(3);
      expect(messages).toContain(`LTROW BACKFILL DUP item="${T}" kept_score=3 dropped=2`);
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL DUP")).length).toBe(1);
    });

    it("equal scores → the first in flatten order is kept (deterministic)", async () => {
      const summary = buildBlob({
        "Key Decisions": [
          { item: T, score: 2, lastSeen: 111 },
          { item: T, score: 2, lastSeen: 222 },
        ],
      });
      const { fn } = fakeEmbedFor({ [T]: basisVec(0) });
      await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      const rows = rowstore.getRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].lastSeen).toBe(111); // the first flattened occurrence
    });

    it("the same item text in two different pinned sections collapses to one (cross-section — no section column)", async () => {
      const summary = buildBlob({
        "Key Decisions": [{ item: T, score: 1, lastSeen: 100 }],
        "Patterns & Conventions": [{ item: T, score: 1, lastSeen: 200 }],
      });
      const { fn } = fakeEmbedFor({ [T]: basisVec(0) });
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.parsed).toBe(2);
      expect(report.dupsDropped).toBe(1);
      expect(rowstore.getRows(db)).toHaveLength(1);
      expect(messages).toContain(`LTROW BACKFILL DUP item="${T}" kept_score=1 dropped=1`);
    });
  });

  // ─── Unit 8 — chunk size (R9) ──────────────────────────────────────────────

  describe("unit 8 — chunked embedding (R9)", () => {
    it("120 unique rows → exactly 3 embed calls of sizes 50/50/20 (P8 TRIANGULATE); chunkMs has 3 entries; kind 'document'", async () => {
      const items = Array.from({ length: 120 }, (_, i) => `item-${i}`);
      const summary = buildBlob({ "Key Decisions": items.map((item) => ({ item, score: 1, lastSeen: 42 })) });
      const { fn, calls } = fakeEmbedFor(basisVecMap(items));
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBeNull();
      expect(rowstore.BACKFILL_EMBED_CHUNK_SIZE).toBe(50);
      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.texts.length)).toEqual([50, 50, 20]);
      expect(calls.every((c) => c.kind === "document")).toBe(true);
      expect(report.embedCalls).toBe(3);
      expect(report.chunkMs).toHaveLength(3);
      expect(report.storeRows).toBe(120);
    });
  });

  // ─── Unit 7 part 2 — mode contracts (R10 insert idempotency/resume, R11 destructive) ───

  describe("unit 7 — backfill modes, part 2 (R10/R11)", () => {
    const modeSource = (items: string[]) =>
      buildBlob({ "Key Decisions": items.map((item) => ({ item, score: 1, lastSeen: 300 })) });

    it("insert: re-run with the SAME source → inserted === 0 (every row skipped by exact text), store count unchanged", async () => {
      const items = ["m-1", "m-2", "m-3"];
      const summary = modeSource(items);
      const { fn } = fakeEmbedFor(basisVecMap(items));
      const first = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(first.inserted).toBe(3);
      const second = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(second.inserted).toBe(0);
      expect(second.storeRows).toBe(3);
      expect(second.dupsDropped).toBe(0); // a re-run skip counts in NEITHER dupsDropped NOR inserted
      expect(messages).toContain("LTROW BACKFILL n=0 dups_dropped=0 near_dup_clusters=0");
    });

    it("insert: re-run with one new row → inserted === 1 (resume), pre-existing rows untouched", async () => {
      const items = ["m-1", "m-2", "m-3"];
      const { fn } = fakeEmbedFor(basisVecMap([...items, "m-4"]));
      await rowstore.backfillRowStoreFromTableText(db, { summary: modeSource(items), sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      const before = rowstore.getRows(db);
      expect(before).toHaveLength(3);
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary: modeSource([...items, "m-4"]), sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.inserted).toBe(1);
      expect(report.storeRows).toBe(4);
      const after = rowstore.getRows(db);
      expect(after.slice(0, 3).map((r) => ({ item: r.item, score: r.score, lastSeen: r.lastSeen, embedding: r.embedding }))).toEqual(
        before.map((r) => ({ item: r.item, score: r.score, lastSeen: r.lastSeen, embedding: r.embedding })),
      );
      expect(after[3].item).toBe("m-4");
    });

    it("destructive: pre-seeded foreign row removed on a successful rebuild; inserted === storeRows === uniqueCount", async () => {
      const items = ["d-1", "d-2", "d-3"];
      rowstore.insertRow(db, { item: "foreign-row", score: 9, lastSeen: 777, embedding: basisVec(500) });
      const { fn } = fakeEmbedFor(basisVecMap(items));
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary: modeSource(items), sessionCount: 1084 }, "destructive", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBeNull();
      expect(report.inserted).toBe(3);
      expect(report.storeRows).toBe(3);
      expect(report.inserted).toBe(report.storeRows);
      expect(rowstore.getRows(db).map((r) => r.item).sort()).toEqual(items);
      expect(rowstore.getRows(db).some((r) => r.item === "foreign-row")).toBe(false);
    });

    it("destructive re-run with the same source → (item, score, last_seen, embedding) identical for every row (ids not pinned)", async () => {
      const items = ["d-1", "d-2", "d-3"];
      const summary = modeSource(items);
      const { fn } = fakeEmbedFor(basisVecMap(items));
      const first = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "destructive", DEFAULT_CONFIG, { embed: fn });
      expect(first.aborted).toBeNull();
      const snapshot = (rows: ReturnType<typeof rowstore.getRows>) =>
        rows
          .map((r) => JSON.stringify([r.item, r.score, r.lastSeen, r.embedding]))
          .sort();
      const firstRows = rowstore.getRows(db);
      const second = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "destructive", DEFAULT_CONFIG, { embed: fn });
      expect(second.aborted).toBeNull();
      expect(second.inserted).toBe(3);
      expect(snapshot(rowstore.getRows(db))).toEqual(snapshot(firstRows));
    });
  });

  // ─── Unit 6 — chunk-null semantics, both modes (R10/R11, P3) ─────────────

  describe("unit 6 — chunk-null semantics, both modes (R10/R11, P3)", () => {
    const items120 = Array.from({ length: 120 }, (_, i) => `n-${i}`);
    const summary120 = buildBlob({ "Key Decisions": items120.map((item) => ({ item, score: 1, lastSeen: 7 })) });

    it("insert: null on chunk 3 → 100 rows committed (chunks 1–2), ABORT chunk=3 inserted=100, NO summary line", async () => {
      const { fn } = nullEmbedOnCall(basisVecMap(items120), 3);
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary: summary120, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBe("embed-null");
      expect(report.inserted).toBe(100);
      expect(report.storeRows).toBe(100);
      expect(messages).toContain("LTROW BACKFILL ABORT reason=embed-null chunk=3 inserted=100"); // P3 byte
      expect(messages.some((m) => m.startsWith("LTROW BACKFILL n="))).toBe(false);
    });

    it("destructive: null on chunk 3 → ZERO rows written, pre-seeded foreign row untouched, ABORT chunk=3 inserted=0", async () => {
      rowstore.insertRow(db, { item: "foreign-row", score: 9, lastSeen: 777, embedding: basisVec(600) });
      const { fn } = nullEmbedOnCall(basisVecMap(items120), 3);
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary: summary120, sessionCount: 1084 }, "destructive", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBe("embed-null");
      expect(report.inserted).toBe(0);
      expect(rowstore.getRows(db).map((r) => r.item)).toEqual(["foreign-row"]); // the transaction never opened
      expect(messages).toContain("LTROW BACKFILL ABORT reason=embed-null chunk=3 inserted=0"); // P3 byte
      expect(messages.some((m) => m.startsWith("LTROW BACKFILL n="))).toBe(false);
    });

    it("null on chunk 1 (both modes) → inserted === 0, ABORT chunk=1 inserted=0", async () => {
      const { fn: fnInsert } = nullEmbedOnCall(basisVecMap(items120), 1);
      const r1 = await rowstore.backfillRowStoreFromTableText(db, { summary: summary120, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fnInsert });
      expect(r1.aborted).toBe("embed-null");
      expect(r1.inserted).toBe(0);
      expect(messages).toContain("LTROW BACKFILL ABORT reason=embed-null chunk=1 inserted=0");
      const { fn: fnDest } = nullEmbedOnCall(basisVecMap(items120), 1);
      const r2 = await rowstore.backfillRowStoreFromTableText(db, { summary: summary120, sessionCount: 1084 }, "destructive", DEFAULT_CONFIG, { embed: fnDest });
      expect(r2.aborted).toBe("embed-null");
      expect(r2.inserted).toBe(0);
    });
  });

  // ─── Unit 10 — log bytes byte-exact (R13, P3) ─────────────────────────────

  describe("unit 10 — log bytes byte-exact (R13, P3)", () => {
    it("completed summary line is byte-exact at known counts", async () => {
      // 6 parsed rows, "sum-a" duplicated (scores 2 and 4 → kept 4) → 5 unique.
      const summary = buildBlob({
        "Key Decisions": [
          { item: "sum-a", score: 2, lastSeen: 100 },
          { item: "sum-b", score: 1, lastSeen: 100 },
          { item: "sum-c", score: 1, lastSeen: 100 },
          { item: "sum-d", score: 1, lastSeen: 100 },
          { item: "sum-e", score: 1, lastSeen: 100 },
        ],
        "Lessons Learned": [{ item: "sum-a", score: 4, lastSeen: 200 }],
      });
      const { fn } = fakeEmbedFor({
        "sum-a": basisVec(0),
        "sum-b": basisVec(1),
        "sum-c": basisVec(2),
        "sum-d": basisVec(3),
        "sum-e": basisVec(4),
      });
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBeNull();
      expect(messages).toContain("LTROW BACKFILL n=5 dups_dropped=1 near_dup_clusters=0");
    });

    it("NEAR line: known 0.87 pair → sim=0.8700 (4 decimals), a < b in JS string order; below-threshold pairs absent", async () => {
      // A = e0, B = [0.87, sqrt(1-0.87^2)] → cos(A,B) = 0.87 (>= 0.85 → logged).
      // C = [0.4, sqrt(1-0.4^2)] → cos(A,C) = 0.4 and cos(B,C) ≈ 0.794 (both < 0.85 → absent).
      const A = "connection pooling implemented for the DB layer"; // < B in JS string order
      const B = "reuse database connections across requests";
      const C = "unrelated third item";
      const summary = buildBlob({
        "Key Decisions": [
          { item: A, score: 1, lastSeen: 100 },
          { item: B, score: 1, lastSeen: 100 },
          { item: C, score: 1, lastSeen: 100 },
        ],
      });
      const { fn } = fakeEmbedFor({
        [A]: basisVec(0),
        [B]: axisVec(0.87),
        [C]: axisVec(0.4),
      });
      await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      const nearLines = messages.filter((m) => m.startsWith("LTROW BACKFILL NEAR"));
      expect(nearLines).toHaveLength(1);
      expect(nearLines[0]).toBe(
        `LTROW BACKFILL NEAR a="${A}" b="${B}" sim=0.8700`,
      );
      expect(messages.some((m) => m.includes(`b="${C}"`) || m.includes(`a="${C}"`))).toBe(false);
    });

    it("ABORT lines (both reasons) byte-exact + exactly-one-of-{summary, ABORT} across completed and aborted runs", async () => {
      // Completed run → exactly one summary line, zero ABORT lines.
      const okSummary = buildBlob({ "Key Decisions": [{ item: "ok-1", score: 1, lastSeen: 100 }] });
      const { fn: fnOk } = fakeEmbedFor({ "ok-1": basisVec(0) });
      const ok = await rowstore.backfillRowStoreFromTableText(db, { summary: okSummary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fnOk });
      expect(ok.aborted).toBeNull();
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL n=")).length).toBe(1);
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL ABORT")).length).toBe(0);
      // Unparseable abort → exactly one ABORT line (byte-exact), no summary line.
      messages.length = 0;
      const bad = await rowstore.backfillRowStoreFromTableText(db, { summary: buildBlob({}, "Open Issues"), sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fnOk });
      expect(bad.aborted).toBe("unparseable");
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL n=")).length).toBe(0);
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL ABORT")).length).toBe(1);
      expect(messages).toContain("LTROW BACKFILL ABORT reason=unparseable inserted=0");
      // Chunk-null abort → exactly one ABORT line (byte-exact), no summary line.
      messages.length = 0;
      const { fn: fnNull } = nullEmbedOnCall({ "n-0": basisVec(0) }, 1);
      const nul = await rowstore.backfillRowStoreFromTableText(db, { summary: buildBlob({ "Key Decisions": [{ item: "n-0", score: 1, lastSeen: 100 }] }), sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fnNull });
      expect(nul.aborted).toBe("embed-null");
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL n=")).length).toBe(0);
      expect(messages.filter((m) => m.startsWith("LTROW BACKFILL ABORT")).length).toBe(1);
      expect(messages).toContain("LTROW BACKFILL ABORT reason=embed-null chunk=1 inserted=0");
    });
  });

  // ─── Unit 12 — near-dup cluster count = union-find components (R12) ──────

  describe("unit 12 — near-dup cluster count (R12)", () => {
    it("3 rows, cosines A–B 0.90 / B–C 0.86 / A–C 0.84 (threshold 0.85) → 2 NEAR lines, nearDupClusters === 1 (chain of 3)", async () => {
      // Gram matrix [[1,.9,.84],[.9,1,.86],[.84,.86,1]] is PSD; construct in 3D:
      // B = e0; A = [0.9, sqrt(0.19), 0]; C = [0.86, u, v] with u = 0.066/sqrt(0.19),
      // v = sqrt(1 - 0.86^2 - u^2) — gives the pinned pairwise cosines.
      const sA = Math.sqrt(0.19);
      const uC = 0.066 / sA;
      const vC = Math.sqrt(1 - 0.86 * 0.86 - uC * uC);
      const mk = (xs: number[]): number[] => { const v = new Array(768).fill(0); xs.forEach((x, i) => (v[i] = x)); return v; };
      const A = "chain-a";
      const B = "chain-b";
      const C = "chain-c";
      const summary = buildBlob({
        "Key Decisions": [
          { item: A, score: 1, lastSeen: 100 },
          { item: B, score: 1, lastSeen: 100 },
          { item: C, score: 1, lastSeen: 100 },
        ],
      });
      const { fn } = fakeEmbedFor({
        [A]: mk([0.9, sA, 0]),
        [B]: mk([1, 0, 0]),
        [C]: mk([0.86, uC, vC]),
      });
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBeNull();
      // Sanity: the constructed cosines are what the spec pins.
      expect(cosineSimilarity(mk([0.9, sA, 0]), mk([1, 0, 0]))).toBeGreaterThan(0.89);
      expect(cosineSimilarity(mk([1, 0, 0]), mk([0.86, uC, vC]))).toBeGreaterThan(0.85);
      expect(cosineSimilarity(mk([0.9, sA, 0]), mk([0.86, uC, vC]))).toBeLessThan(0.85);
      const nearLines = messages.filter((m) => m.startsWith("LTROW BACKFILL NEAR"));
      expect(nearLines).toHaveLength(2); // A–B and B–C only — A–C (0.84) absent
      expect(nearLines[0]).toContain(`a="${A}" b="${B}"`); // sim DESC — 0.90 first
      expect(nearLines[1]).toContain(`a="${B}" b="${C}"`);
      expect(report.nearDupClusters).toBe(1); // one connected component of 3 — cluster count ≠ pair count
      // Summary line carries the cluster count.
      expect(messages).toContain("LTROW BACKFILL n=3 dups_dropped=0 near_dup_clusters=1");
    });
  });

  // ─── Unit 13 — additive guarantee (R19) ───────────────────────────────────

  describe("unit 13 — additive guarantee: only long_term_rows changes (R19)", () => {
    it("seeded long_term / session_summaries / meta survive a completed backfill byte-identical", async () => {
      const blob = buildBlob({ "Key Decisions": [{ item: "add-1", score: 2, lastSeen: 500 }] });
      db.exec(
        "CREATE TABLE long_term (id INTEGER PRIMARY KEY CHECK (id = 1), timestamp TEXT NOT NULL, summary TEXT NOT NULL, char_count INTEGER NOT NULL, session_count INTEGER NOT NULL, merged_sessions TEXT NOT NULL DEFAULT '[]')",
      );
      db.prepare("INSERT INTO long_term (id, timestamp, summary, char_count, session_count, merged_sessions) VALUES (1, '2026-08-30T00:00:00Z', ?, ?, 1084, '[]')").run(blob, blob.length);
      db.exec(
        "CREATE TABLE session_summaries (session_path TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL, char_count INTEGER NOT NULL, merge_count INTEGER NOT NULL DEFAULT 0, last_fresh_hash TEXT, updated_at TEXT NOT NULL, unmerged_fresh_content TEXT DEFAULT NULL, last_merged_hash TEXT)",
      );
      db.prepare("INSERT INTO session_summaries (session_path, version, summary, char_count, merge_count, updated_at) VALUES (?, 1, ?, 10, 0, '2026-08-29T00:00:00Z')").run("/sess/x", "unmerged content");
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO meta (key, value) VALUES ('lt_meta_counter', '5')").run();

      const { fn } = fakeEmbedFor({ "add-1": basisVec(0) });
      const report = await rowstore.backfillRowStoreFromTableText(db, { summary: blob, sessionCount: 1084 }, "insert", DEFAULT_CONFIG, { embed: fn });
      expect(report.aborted).toBeNull();
      expect(report.storeRows).toBe(1);
      // long_term byte-identical (the 19,776-char blob is never written by C2).
      const lt = db.prepare("SELECT summary, char_count, session_count FROM long_term WHERE id = 1").get() as { summary: string; char_count: number; session_count: number };
      expect(lt.summary).toBe(blob);
      expect(lt.char_count).toBe(blob.length);
      expect(lt.session_count).toBe(1084);
      // session_summaries (the 54-row unmerged backlog) untouched — NOT a source.
      const ss = db.prepare("SELECT session_path, summary, unmerged_fresh_content FROM session_summaries").all() as unknown[];
      expect(ss).toHaveLength(1);
      // meta untouched.
      const meta = db.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>;
      expect(meta).toEqual([{ key: "lt_meta_counter", value: "5" }]);
      // Only long_term_rows changed.
      expect(rowstore.getRows(db)).toHaveLength(1);
      expect(rowstore.getRows(db)[0].item).toBe("add-1");
    });
  });
});
