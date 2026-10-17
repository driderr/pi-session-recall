// rowstore.ts — C2 (rowstore-storage): the extension's SQLite row store for
// long-term memory. Design: openspec/changes/rowstore-storage/design.md §1–§5.
//
// Dependency direction (one-way): rowstore → summarizer (parseScoreTables /
// PINNED_SECTIONS), rowstore → embeddings (embedBatch / cosineSimilarity).
// No module in the runtime surface imports rowstore.ts — while useRowStore is
// false this file is unreachable from every runtime hook (inertness, design §7).
//
// Discipline: the long_term_rows DDL (plan §5 as-is) lives ONLY here; every
// public entry point self-ensures it (no openCacheDb wiring — that would create
// a summarizer → rowstore → embeddings → summarizer ESM cycle). The six
// byte-pinned LTROW BACKFILL* / LTROW PRUNED lines are constructed ONLY in this
// file (single-emitter rule, design §5). No module-level DB state: every
// function uses only the passed handle (single-connection discipline).
import type { Database as BetterSqliteDb } from "better-sqlite3";
import type { SessionRecallConfig } from "./config.js";
import { log } from "./logger.js";
import { embedBatch, embedText, cosineSimilarity, probeEmbedServerUp, type EmbedKind } from "./embeddings.js";
import {
  parseScoreTables,
  PINNED_SECTIONS,
  type ScoreTableRow,
  recordMergeFailure,
  md5Content,
  sqliteReadUnmergedSessionSummaries,
  sqliteMarkSessionSummariesMerged,
  withLlmBusy,
  llmCallOnce,
  buildMergeModelPair,
} from "./summarizer.js";

// ─── Row-store last-fold sentinel (post-C4-flip time-gate pacing) ─────────────
// The session_start time gate in ROWSTORE mode reads this meta key; the row-store leg
// stamps it AFTER a successful fold (index.ts, the useRowStore branch). The long_term
// blob is never written on this leg, so its frozen timestamp cannot pace row-store
// folds — this sentinel is the owner. Value: decimal epoch-ms string (String(Date.now())).
// Single FIXED key (no prefix-scan) → untouched by pruneMergeQuarantine / correction
// quarantine sweeps.
export const ROWSTORE_LAST_FOLD_MS_KEY = "rowstore_last_fold_ms";
// ─── Frozen public surface (P2 — design §1.2; frozen for C3/C4) ──────────────

export interface LongTermRow {
  id: number;
  item: string;
  score: number;
  lastSeen: number;
  embedding: number[];
}

export interface InsertRowInput {
  item: string;
  score: number;
  lastSeen: number;
  embedding: number[];
  /** ISO-8601 UTC (Z) correction-provenance anchor (this change; D-2) — the
   *  correction marker's timestamp when the row is correction-born, else NULL. */
  correctedAt?: string | null;
}

export interface CandidateHit {
  row: LongTermRow;
  similarity: number;
}

export interface BackfillSource {
  summary: string;   // the long_term id=1 blob text (composed by the caller)
  sessionCount: number; // its session_count (hybrid last_seen fallback)
}

/** The two Decision-2 modes, documented as BackfillInsert (default) /
 *  BackfillDestructive (lowercase values mirror the vehicle env var). */
export type BackfillMode = "insert" | "destructive";

export interface BackfillIo {
  /** Test seam; defaults to embedBatch (Nomic `search_document: ` prefix applied internally). */
  embed?: (texts: string[], kind: EmbedKind) => Promise<number[][] | null>;
}

export interface BackfillReport {
  parsed: number;
  dupsDropped: number;
  nearDupClusters: number;
  inserted: number;
  storeRows: number;
  embedCalls: number;
  chunkMs: number[];
  embedMs: number;
  aborted: "unparseable" | "embed-null" | null;
}

/** Items per embedBatch call (design §4.2 step 6 — margin under the 20 s watchdog). */
export const BACKFILL_EMBED_CHUNK_SIZE = 50;

// ─── Schema self-ensure (P1 — plan §5 SQL as-is) ─────────────────────────────

export function ensureRowStoreSchema(db: BetterSqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS long_term_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 1,
      last_seen INTEGER NOT NULL,        -- session_count at merge time (monotonic)
      embedding TEXT NOT NULL,           -- JSON-encoded float[768]
      corrected_at TEXT                 -- NEW (this change): nullable ISO-8601 UTC timestamp, second precision, Z suffix, no fractional seconds (e.g. 2026-09-03T12:34:56Z) — set when the row is correction-born or correction-promoted, NULL otherwise
    )
  `);
  // Add corrected_at column if not present (idempotent) — a CREATE-TABLE-only
  // change is a silent no-op on the live table (F10): the first INSERT that
  // lists the column would then throw and break the whole fold. Mirrors how
  // unmerged_fresh_content was added (summarizer.ts ensureSchema).
  try {
    db.exec("ALTER TABLE long_term_rows ADD COLUMN corrected_at TEXT");
  } catch {
    // Column already exists — safe to ignore
  }
}

// ─── Row storage shape and CRUD (R3 — synchronous; JSON text on disk) ────────

// Store-time boundary guard (C4): an embedding that is not an array of 768
// finite numbers is rejected BEFORE any SQL runs (no partial write). Loud and
// greppable (grep `rejected invalid embedding`); deliberately NO LTROW literal
// (C4 introduces no new LTROW lines — the grep gate).
function assertValidStoreEmbedding(embedding: number[], entry: string): void {
  const shape = Array.isArray(embedding)
    ? `an array of ${embedding.length} element(s)`
    : `a ${typeof embedding}`;
  if (
    !Array.isArray(embedding) ||
    embedding.length !== 768 ||
    !embedding.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    throw new Error(
      `long_term_rows: ${entry} rejected invalid embedding — expected an array of 768 finite numbers, got ${shape}`,
    );
  }
}
export function insertRow(db: BetterSqliteDb, input: InsertRowInput): number {
  assertValidStoreEmbedding(input.embedding, "insertRow");
  ensureRowStoreSchema(db);
  const info = db
    .prepare("INSERT INTO long_term_rows (item, score, last_seen, embedding, corrected_at) VALUES (?, ?, ?, ?, ?)")
    .run(input.item, input.score, input.lastSeen, JSON.stringify(input.embedding), input.correctedAt ?? null);
  return Number(info.lastInsertRowid);
}

/** Additive (this change; D-2): the trailing `correctedAt` (the swept marker
 *  timestamp for a correction-born lesson) SETS / REFRESHES the row's
 *  `corrected_at` (the newer marker wins); absent/NULL PRESERVES the existing
 *  value (COALESCE(?, corrected_at) — the pinned one-expression
 *  set/refresh/preserve rule: a normal lesson carries no correction timestamp,
 *  so the row stays anchored to the original correction moment). */
export function updateRowScoreAndLastSeen(db: BetterSqliteDb, id: number, score: number, lastSeen: number, correctedAt?: string | null): number {
  ensureRowStoreSchema(db);
  const info = db
    .prepare("UPDATE long_term_rows SET score = ?, last_seen = ?, corrected_at = COALESCE(?, corrected_at) WHERE id = ?")
    .run(score, lastSeen, correctedAt ?? null, id);
  return info.changes;
}

/** ONE write: item text + embedding + score bump + last_seen committed together
 *  (C3.5 decision-17 rewrite branch — the one-write invariant, risk R4; the JSON
 *  encoding matches insertRow exactly). Additive (this change; D-2): the trailing
 *  `correctedAt` (the swept marker timestamp for a correction-born lesson) SETS /
 *  REFRESHES the row's `corrected_at` (the newer marker wins); absent/NULL
 *  PRESERVES it (COALESCE(?, corrected_at)) — a rewrite never drops a correction
 *  tag a normal lesson doesn't carry. Self-ensures the schema; returns the
 *  changed-row count (absent id → 0). */
export function updateRowItemEmbeddingScoreAndLastSeen(
  db: BetterSqliteDb,
  id: number,
  item: string,
  embedding: number[],
  score: number,
  lastSeen: number,
  correctedAt?: string | null,
): number {
  assertValidStoreEmbedding(embedding, "updateRowItemEmbeddingScoreAndLastSeen");
  ensureRowStoreSchema(db);
  const info = db
    .prepare("UPDATE long_term_rows SET item = ?, embedding = ?, score = ?, last_seen = ?, corrected_at = COALESCE(?, corrected_at) WHERE id = ?")
    .run(item, JSON.stringify(embedding), score, lastSeen, correctedAt ?? null, id);
  return info.changes;
}

export function deleteRow(db: BetterSqliteDb, id: number): number {
  ensureRowStoreSchema(db);
  const info = db.prepare("DELETE FROM long_term_rows WHERE id = ?").run(id);
  return info.changes;
}

/** All rows in deterministic base order (id ASC); embedding decoded from JSON
 *  text to number[]. No defensive JSON fallback: a parse throw means external
 *  corruption and must fail loudly rather than silently degrade C4's injection. */
export function getRows(db: BetterSqliteDb): LongTermRow[] {
  ensureRowStoreSchema(db);
  const rows = db
    .prepare("SELECT id, item, score, last_seen, embedding FROM long_term_rows ORDER BY id ASC")
    .all() as Array<{ id: number; item: string; score: number; last_seen: number; embedding: string }>;
  return rows.map((r) => ({
    id: r.id,
    item: r.item,
    score: r.score,
    lastSeen: r.last_seen,
    embedding: JSON.parse(r.embedding) as number[],
  }));
}

const INJECTION_SKELETON_CHARS = 58; // keep in sync with summarizer.ts's LT_ROW_TABLE_SKELETON (the 58-char render skeleton — both byte-pinned by test/rowstore-injection.test.ts)

/** C4 injection read (rowstore-injection design §1.2/§2.1 — the pinned SQL, C4-P2): ONE
 *  statement over long_term_rows — rank + sort + byte-exact cumulative-width chop in SQL;
 *  the application receives only the rows that will render. Pure most-used ordering
 *  (score DESC, last_seen DESC, item ASC — byte-wise; NO session-count/decay input — that
 *  is the legacy leg's rank math). The width formula mirrors the render template exactly:
 *  `| <item> | <score> | <lastSeen> |\n` = item + score + lastSeen char counts + 11. The
 *  outer `?` is bound to longTermMaxChars − INJECTION_SKELETON_CHARS so the rendered
 *  section (58-char skeleton + row lines) lands byte-exactly on the budget (T2: the SIMPLE
 *  prefix cut — no skip-and-fill; T3: exact landing, no padding, no slack). The read NEVER
 *  selects the embedding column (T4: corrupted embedding JSON must not affect this path).
 *  Self-ensures the schema (house pattern — empty table → []); a single .all(). */
export function getRowsForInjection(
  db: BetterSqliteDb,
  longTermMaxChars: number,
): Array<{ item: string; score: number; lastSeen: number }> {
  ensureRowStoreSchema(db);
  const rows = db
    .prepare(
      "SELECT item, score, last_seen FROM (" +
        "SELECT item, score, last_seen, " +
        "SUM(LENGTH(item) + LENGTH(CAST(score AS TEXT)) + LENGTH(CAST(last_seen AS TEXT)) + 11) " +
        "OVER (ORDER BY score DESC, last_seen DESC, item ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_chars " +
        "FROM long_term_rows" +
        ") WHERE cumulative_chars <= ? " +
        "ORDER BY score DESC, last_seen DESC, item ASC"
    )
    .all(longTermMaxChars - INJECTION_SKELETON_CHARS) as Array<{ item: string; score: number; last_seen: number }>;
  return rows.map((r) => ({ item: r.item, score: r.score, lastSeen: r.last_seen }));
}

/** unit B (correction-recency-injection 11.1 / D-8 / P5; spec rowstore R5): the
 *  RECENT CORRECTIONS recency read — the correction lessons for the injection
 *  section. LLM-free, network-free, ONE `(db, config)` signature (no seams) —
 *  like the injection score-table read, a pure SQL read: the schema self-ensure
 *  is the FIRST statement (spec R1 — the "every public entry point" list
 *  extends with this entry — a fresh DB works), then the 7/30 effective-window
 *  rule (D-8): count the rows with non-NULL `corrected_at` in the base
 *  `correctionWindowDays` window (fixed-width ISO-8601 UTC, second precision,
 *  Z suffix, no fractional seconds — lexicographic compare = chronological,
 *  D-2's rationale); fewer than `correctionMinItems` → widen to
 *  `correctionMaxWindowDays`. Then the pinned fetch (the exact bytes are
 *  pinned by the 10.1(a) RED fixture — the strict `corrected_at > ?` edge, the
 *  `id DESC` tie-break for same-second timestamps, `LIMIT` the max items): the
 *  `embedding` column is NEVER selected (a corrupted embedding must not affect
 *  this path — the getRowsForInjection T4 posture). Returns the item rows
 *  newest-first + the effective window (days) for the header's `last {N}d`. */
export function getRecentCorrections(
  db: BetterSqliteDb,
  config: SessionRecallConfig,
): { items: string[]; windowDays: number } {
  ensureRowStoreSchema(db);
  const DAY_MS = 24 * 60 * 60 * 1000;
  const isoCutoff = (days: number): string =>
    new Date(Date.now() - days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const countIn = (cutoff: string): number =>
    (db
      .prepare("SELECT COUNT(*) AS n FROM long_term_rows WHERE corrected_at IS NOT NULL AND corrected_at > ?")
      .get(cutoff) as { n: number }).n;
  const baseCutoff = isoCutoff(config.correctionWindowDays);
  const windowDays =
    countIn(baseCutoff) >= config.correctionMinItems
      ? config.correctionWindowDays
      : config.correctionMaxWindowDays;
  const rows = db
    .prepare(
      "SELECT item FROM long_term_rows WHERE corrected_at IS NOT NULL AND corrected_at > ? ORDER BY corrected_at DESC, id DESC LIMIT ?",
    )
    .all(isoCutoff(windowDays), config.correctionMaxItems) as Array<{ item: string }>;
  return { items: rows.map((r) => r.item), windowDays };
}

// ─── Retrieval / prune / backfill (frozen signatures — bodies land in steps 3–4) ───

/** Whole-store brute force (no vector index — plan §8 non-goal; sub-millisecond
 *  at ~200 rows): per-row cosineSimilarity (C1's pure function — 0 on length
 *  mismatch or zero vector), keep sim >= threshold (inclusive bound, P8), sort
 *  similarity DESC with ties broken by id ASC, cap at topK; [] on empty store
 *  or no match. Contract frozen for C3 (design §2). */
export function findCandidates(db: BetterSqliteDb, queryEmb: number[], threshold: number, topK: number): CandidateHit[] {
  ensureRowStoreSchema(db);
  const rows = getRows(db);
  const hits: CandidateHit[] = [];
  for (const row of rows) {
    const similarity = cosineSimilarity(queryEmb, row.embedding);
    if (similarity >= threshold) hits.push({ row, similarity });
  }
  hits.sort((a, b) => (b.similarity - a.similarity) || (a.row.id - b.row.id));
  return hits.slice(0, topK);
}

/** Row-level parity with pruneStaleRows (summarizer.ts:1052-1072): delete exactly
 *  the rows where age = max(0, currentSessionCount − last_seen) is STRICTLY
 *  greater than config.stalePruneAfterSessions (100) AND score is STRICTLY less
 *  than config.stalePruneMinScore (3) — strict comparisons mirroring the legacy
 *  prune exactly (P8); a matched row (age 0) and a future-dated row (clamped to
 *  age 0) are never pruned. No runtime caller in C2 — C3's fold wires it (Q7).
 *  Emits `LTROW PRUNED <n>` on every call, including n = 0 (P3 — constructed
 *  only here). Argument order (db, config, currentSessionCount) is pinned (P2). */
export function pruneStaleRowsInStore(db: BetterSqliteDb, config: SessionRecallConfig, currentSessionCount: number): number {
  ensureRowStoreSchema(db);
  const rows = db
    .prepare("SELECT id, score, last_seen FROM long_term_rows")
    .all() as Array<{ id: number; score: number; last_seen: number }>;
  const drop = rows.filter((r) => {
    const age = Math.max(0, currentSessionCount - r.last_seen);
    return age > config.stalePruneAfterSessions && r.score < config.stalePruneMinScore;
  });
  if (drop.length > 0) {
    const del = db.prepare("DELETE FROM long_term_rows WHERE id = ?");
    db.transaction(() => {
      for (const r of drop) del.run(r.id);
    })();
  }
  log(`LTROW PRUNED ${drop.length}`);
  return drop.length;
}

/** The one-time backfill that migrates the legacy long_term blob into rows
 *  (design §4). Stage order (one async function): ensure → parse (unparseable →
 *  ABORT, zero writes, fail closed) → flatten (PINNED_SECTIONS order) → hybrid
 *  last_seen (Decision 1) → exact-text dedup → chunked embedding (kind
 *  "document", chunks of BACKFILL_EMBED_CHUNK_SIZE) → insert in the selected
 *  mode → near-dup all-pairs report (completion only) → summary line. The
 *  function NEVER reads long_term itself — the caller composes the BackfillSource.
 *  The 54-row session_summaries backlog is NOT a backfill source. Emission
 *  invariant: exactly one of {summary line, ABORT line}, never both (P3). */
export async function backfillRowStoreFromTableText(
  db: BetterSqliteDb,
  source: BackfillSource,
  mode: BackfillMode,
  config: SessionRecallConfig,
  io: BackfillIo = {},
): Promise<BackfillReport> {
  ensureRowStoreSchema(db);
  const embed = io.embed ?? embedBatch;
  const report: BackfillReport = {
    parsed: 0,
    dupsDropped: 0,
    nearDupClusters: 0,
    inserted: 0,
    storeRows: 0,
    embedCalls: 0,
    chunkMs: [],
    embedMs: 0,
    aborted: null,
  };

  // 2. Parse — pure, never throws (summarizer.ts:677-722); unparseable → ABORT,
  //    zero writes (fail closed loudly — the vehicle asserts aborted === null).
  const parsedTables = parseScoreTables(source.summary);
  if (!parsedTables.parseable) {
    log(`LTROW BACKFILL ABORT reason=unparseable inserted=0`);
    report.aborted = "unparseable";
    return report;
  }

  // 3. Flatten rows across all 5 pinned sections in PINNED_SECTIONS order;
  //    section headers are dropped (no section column, D2).
  const flat: ScoreTableRow[] = [];
  for (const name of PINNED_SECTIONS) flat.push(...parsedTables.sections[name]);
  report.parsed = flat.length;

  // 4. Hybrid last_seen (Decision 1, P8): parsed Last-Seen when valid (strict
  //    > 0), else the blob-level session_count. An explicit "0" cell parses to
  //    0 and falls back — the parser's 0-fallback must not make backfilled
  //    rows immediately stale-prune eligible after C4's flip.
  const hybrid = flat.map((r) => ({ ...r, lastSeen: r.lastSeen > 0 ? r.lastSeen : source.sessionCount }));

  // 5. Exact-text dedup (plan §6-C2): group the flattened rows by EXACT item
  //    text (cross-section — sections no longer exist as a column); keep
  //    exactly one row per text — the highest-scored (ties → first in flatten
  //    order, deterministic). One byte-exact DUP line per collapsed text (P3),
  //    emitted in flatten order at this stage, BEFORE embedding (no wasted
  //    embed calls on collapsed rows).
  const dedup = new Map<string, { row: (typeof hybrid)[number]; firstIdx: number; count: number }>();
  hybrid.forEach((r, idx) => {
    const entry = dedup.get(r.item);
    if (!entry) {
      dedup.set(r.item, { row: r, firstIdx: idx, count: 1 });
    } else {
      entry.count++;
      if (r.score > entry.row.score) entry.row = r; // strict > — ties keep the first
    }
  });
  const dedupOrdered = [...dedup.values()].sort((a, b) => a.firstIdx - b.firstIdx);
  const unique = dedupOrdered.map((e) => e.row);
  report.dupsDropped = flat.length - unique.length;
  for (const e of dedupOrdered) {
    if (e.count > 1) log(`LTROW BACKFILL DUP item="${e.row.item}" kept_score=${e.row.score} dropped=${e.count - 1}`);
  }

  // 6. Chunked embedding (exploration D3) + 7. Insert in the selected mode
  //    (R10 / R11) — chunks of exactly BACKFILL_EMBED_CHUNK_SIZE, kind
  //    "document" (Nomic search_document: prefix applied inside embedBatch).
  //    insert (BackfillInsert — the default, idempotent): pre-read existing
  //    item texts into a Set ONCE before the chunk loop; a unique row whose
  //    text is already present is skipped (a re-run skip — counted in NEITHER
  //    dupsDropped NOR inserted); each COMPLETED chunk's inserts run inside
  //    one db.transaction (commit granularity = chunk; a crash loses at most
  //    the in-flight chunk, and the re-run resumes via exact-text skip).
  //    destructive (BackfillDestructive — C2-era tool): ONE db.transaction
  //    that opens only after EVERY chunk has embedded successfully — DELETE
  //    FROM long_term_rows, then insert every unique row. Atomic: success →
  //    store content == exactly the source rows (pre-existing foreign rows
  //    removed); any failure → rollback, store byte-unchanged. Determinism is
  //    content-level only: ids are NOT pinned across re-runs (AUTOINCREMENT
  //    keeps counting after a DELETE; no sqlite_sequence reset — speculative
  //    surface, C3/C4 treat ids as internal).
  //    Per-chunk null semantics (design §4.3): the failed call's `embed:`
  //    detail line is already emitted by embeddings.ts itself (C1 format).
  const texts = unique.map((r) => r.item);
  const allVectors: number[][] = []; // every embedded unique row (near-dup pass runs over these)
  const tEmbedStart = Date.now();
  if (mode === "insert") {
    const existing = new Set<string>(
      (db.prepare("SELECT item FROM long_term_rows").all() as Array<{ item: string }>).map((r) => r.item),
    );
    for (let i = 0; i < texts.length; i += BACKFILL_EMBED_CHUNK_SIZE) {
      const chunkIdx = i / BACKFILL_EMBED_CHUNK_SIZE + 1; // 1-based failed-call index (P3)
      const chunkTexts = texts.slice(i, i + BACKFILL_EMBED_CHUNK_SIZE);
      const t0 = Date.now();
      const got = await embed(chunkTexts, "document");
      if (got === null) {
        // Stop after the in-flight work — chunks before the failed one are
        // already committed; the failed chunk and all subsequent are not
        // inserted. A re-run after the abort is the recovery story (resume).
        log(`LTROW BACKFILL ABORT reason=embed-null chunk=${chunkIdx} inserted=${report.inserted}`);
        report.aborted = "embed-null";
        report.embedMs = Date.now() - tEmbedStart;
        report.storeRows = countRows(db);
        return report;
      }
      report.chunkMs.push(Date.now() - t0);
      report.embedCalls++;
      allVectors.push(...got);
      const chunkRows = unique.slice(i, i + BACKFILL_EMBED_CHUNK_SIZE);
      db.transaction(() => {
        const fresh: InsertRowInput[] = [];
        for (let j = 0; j < chunkRows.length; j++) {
          if (existing.has(chunkRows[j].item)) continue; // re-run skip
          fresh.push({
            item: chunkRows[j].item,
            score: chunkRows[j].score,
            lastSeen: chunkRows[j].lastSeen,
            embedding: got[j],
          });
        }
        report.inserted += writeBackfillRows(db, fresh);
      })();
    }
  } else {
    for (let i = 0; i < texts.length; i += BACKFILL_EMBED_CHUNK_SIZE) {
      const chunkIdx = i / BACKFILL_EMBED_CHUNK_SIZE + 1; // 1-based failed-call index (P3)
      const chunkTexts = texts.slice(i, i + BACKFILL_EMBED_CHUNK_SIZE);
      const t0 = Date.now();
      const got = await embed(chunkTexts, "document");
      if (got === null) {
        // The transaction NEVER opens — zero writes; the store is
        // byte-unchanged (any pre-seeded foreign row untouched).
        log(`LTROW BACKFILL ABORT reason=embed-null chunk=${chunkIdx} inserted=0`);
        report.aborted = "embed-null";
        report.embedMs = Date.now() - tEmbedStart;
        report.storeRows = countRows(db);
        return report;
      }
      report.chunkMs.push(Date.now() - t0);
      report.embedCalls++;
      allVectors.push(...got);
    }
    db.transaction(() => {
      db.prepare("DELETE FROM long_term_rows").run();
      const rebuilt: InsertRowInput[] = unique.map((r, j) => ({
        item: r.item,
        score: r.score,
        lastSeen: r.lastSeen,
        embedding: allVectors[j],
      }));
      report.inserted += writeBackfillRows(db, rebuilt);
    })();
  }
  report.embedMs = Date.now() - tEmbedStart;

  // 8. Near-dup all-pairs pass (R12 — log-only; plan §8 non-goal: no writes,
  //    no row mutation, no auto-consolidation). Runs on COMPLETION only — a
  //    partial similarity picture after an aborted embed stage would mislead
  //    the user's first near-dup review (no partial report). Every pair (i<j)
  //    with cosineSimilarity >= config.embedAutoConsolidateThreshold (0.85,
  //    existing config — zero new fields) yields one byte-exact NEAR line
  //    (P3): sim via toFixed(4) (exactly four decimals), a < b in JS string
  //    order, lines ordered by sim DESC, then a ASC, then b ASC. Emitted after
  //    the summary line. nearDupClusters = the number of union-find connected
  //    components of size >= 2 among those pairs (a chain of 3 → 1 cluster
  //    with 2 pair lines — cluster count != pair count).
  const pairs: Array<{ i: number; j: number; a: string; b: string; sim: number }> = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const sim = cosineSimilarity(allVectors[i], allVectors[j]);
      if (sim >= config.embedAutoConsolidateThreshold) {
        pairs.push({ i, j, a: unique[i].item, b: unique[j].item, sim });
      }
    }
  }
  const parent = unique.map((_, idx) => idx);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const p of pairs) parent[find(p.i)] = find(p.j);
  const sizeByRoot = new Map<number, number>();
  for (let i = 0; i < unique.length; i++) {
    const root = find(i);
    sizeByRoot.set(root, (sizeByRoot.get(root) ?? 0) + 1);
  }
  report.nearDupClusters = [...sizeByRoot.values()].filter((sz) => sz >= 2).length;

  // 9. Summary line — exactly one, on completion (P3; DRY and LIVE, both
  //    modes). n = report.inserted in insert mode (rows written this run),
  //    report.storeRows in destructive mode (rows after rebuild). NEAR lines
  //    follow the summary line.
  report.storeRows = countRows(db);
  const n = mode === "insert" ? report.inserted : report.storeRows;
  log(`LTROW BACKFILL n=${n} dups_dropped=${report.dupsDropped} near_dup_clusters=${report.nearDupClusters}`);
  const nearLines = pairs
    .map((p) => ({ a: p.a < p.b ? p.a : p.b, b: p.a < p.b ? p.b : p.a, sim: p.sim }))
    .sort(
      (p, q) =>
        q.sim - p.sim || (p.a < q.a ? -1 : p.a > q.a ? 1 : 0) || (p.b < q.b ? -1 : p.b > q.b ? 1 : 0),
    );
  for (const p of nearLines) log(`LTROW BACKFILL NEAR a="${p.a}" b="${p.b}" sim=${p.sim.toFixed(4)}`);
  return report;
}

/** Shared row construction for both backfill modes (module-private — P2
 *  frozen surface): one insertRow call per input, so the columns written can
 *  never diverge between the insert and destructive paths. Returns the rows
 *  written. */
function writeBackfillRows(db: BetterSqliteDb, rows: InsertRowInput[]): number {
  for (const r of rows) insertRow(db, r);
  return rows.length;
}

function countRows(db: BetterSqliteDb): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
}

// ─── C3.5 row-store merge engine (rowstore-merge C3 + rowstore-lessons C3.5 — design §1–§4, §9) ───
// The fold's row-store leg: per unmerged session, the session-atomic EXTRACT
// stage (the pinned EXTRACT prompt per 24K-char chunk; the all-or-nothing
// parser) yields lessons, and per lesson → query embed → findCandidates → the
// §5.5 COMPARE prompt (C3's bytes, the lesson in the {bare} slot) or the
// zero-candidate engine short-circuit → the §1.5 write (on `match`, the
// decision-17 enrichment ladder runs BEFORE the write) → the §4 lines (incl.
// LTROW LESSONS + the enrich= token). Every byte-pinned LTROW literal is
// constructed ONLY in this section (P1 — the single-emitter rule extended to
// C3.5). This path NEVER reads or writes the long_term blob, and never reads
// the quarantine sentinel store (excludedPaths arrives precomputed from the
// run-start pass — quarantine-pure).

export type MergeAction = "match" | "new" | "contradict";

/** plan §5 core type verbatim — the ENGINE-SIDE record. `signalIndex` is a
 *  log-correlation index (0-based in-session, content order); it is NEVER sent
 *  to the LLM (the model's JSON has no signalIndex). */
export interface MergeDecision { signalIndex: number; action: MergeAction; rowId?: number; }

/** ONE attempt; null = no parseable text. */
export type SignalLlmCall = (prompt: string) => Promise<string | null>;

export interface RowStoreMergeOptions {
  excludedPaths?: readonly string[];      // run-start quarantine exclusions (index.ts step 7 / harness loop)
  embed?: (text: string, kind: EmbedKind) => Promise<number[] | null>; // default: C1 embedText
  llmCall?: SignalLlmCall;                // default: the §5.4 seam (5-min constant, maxRetries 0)
  probeLlmDown?: () => Promise<boolean>;        // infra pre-check: chat endpoint down? (default: real probe; hermetic runs → up)
  probeEmbedDown?: () => Promise<boolean>;      // infra pre-check: embed endpoint down? (same defaults; 2026-10-16 incident)
  nowMs?: () => number;                   // run timestamp; default Date.now — called ONCE per run
  sessionCountOverride?: number;          // tests pin this; default: the run's SQL count (§3)
  llmBusy?: <T>(fn: () => Promise<T>) => Promise<T | null>; // default: withLlmBusy (skip-not-queue)
  onLlmCall?: (callClass: "extract" | "compare" | "merge", durationMs: number, sessionPath: string) => void; // additive (C3.5): fires AFTER every attempt of every class (retries included); durationMs = the attempt's wall time
  extractCapOverride?: number | null;    // null = unlimited (engine option retained; the flush passes FLUSH_EXTRACT_BATCH = 5, decided 2026-09-04); number = explicit EXTRACT-slot cap; undefined = config.lessonExtractMaxPerRun (session-start, unchanged)
}

export interface RowStoreDecisionRecord {
  sessionPath: string;
  signalIndex: number;          // 0-based in-session, content order
  action: MergeAction;
  rowId?: number;               // match/contradict only
  topSimilarity: number | null; // hits[0].similarity; null on the zero-candidate path
  by: "llm" | "engine";         // "engine" = zero-candidate short-circuit (Q7)
}

/** Per-signal review stream (additive; the pinned aggregate fields above are
 *  unchanged) — the live-gate's human-readable report renders this: WHAT each
 *  decision was made on, with the exact candidates the model was shown. */
export interface RowStoreSignalDetail {
  sessionPath: string;
  signalIndex: number;
  signal: string;                 // the verbatim bare signal
  candidates: { id: number; item: string; similarity: number }[]; // the hits shown (empty when retrieval never ran or returned none)
  outcome:
    | { kind: "decision"; action: MergeAction; rowId?: number; by: "llm" | "engine"; enrich?: "rewrite" | "none" | "rejected" } // enrich: additive C3.5 token (undefined in C3 — toEqual-safe)
    | { kind: "skipped"; reason: "embed-null" | "timeout" | "parse-fail" | "llm-down" | "embed-down" }; // llm-down/embed-down: infra pre-check down — NO strike (2026-10-16)
}

export interface RowStoreMergeResult {
  signalsProcessed: number;         // every signal that reached a decision or a skip
  sessionsMarkedMerged: number;     // includes zero-signal drain sessions
  sessionsFailed: string[];         // session paths with ≥1 failed signal this run (NOT marked merged)
  deferredSessions: number;         // sessions not started because of the run cap
  decisions: RowStoreDecisionRecord[];
  skipped: { sessionPath: string; signalIndex: number; reason: "embed-null" | "timeout" | "parse-fail" | "llm-down" | "embed-down" }[]; // llm-down/embed-down: infra pre-check down — NO strike (2026-10-16)
  signalDetail: RowStoreSignalDetail[]; // per-signal review stream (additive)
  pruned: number;                   // return of pruneStaleRowsInStore
  sessionCount: number;             // the run's value (§3) — harness/report + test asserts
  llmBusySkipped: boolean;          // true when withLlmBusy skip-not-queue fired
}

/** Open Item 7 — the 5-min per-attempt timeout. A constant, not a config key
 *  (zero new config fields — proposal §8); parallel to EMBED_CALL_WATCHDOG_MS
 *  and MERGE_EMERGENCY_WATCHDOG_MS. */
export const ROWSTORE_MERGE_LLM_TIMEOUT_MS = 300_000;

/** C3.5 EXTRACT seam — 300 s per attempt, DRY-calibrated 2026-08-30 (the
 *  tuning pass — ruling 2: an exported constant, NOT a config key — zero new
 *  config fields). Calibration (DRY 2026-08-30, 106 EXTRACT calls): p50=18.2 s,
 *  p90=24.7 s, max=61.1 s (recorded attempts; the single attempt aborted by
 *  the old 30-min watchdog is outside the distribution) — 300 s ≈ 5× the
 *  observed max and matches C3's 300s COMPARE/MERGE seam
 *  (ROWSTORE_MERGE_LLM_TIMEOUT_MS). The 30-min emergency-watchdog start
 *  (1_800_000) was the design's deliberate pre-calibration value. A test
 *  asserting the value here is a tuning-drift canary, not a bug. */
export const EXTRACT_LLM_TIMEOUT_MS = 300_000;

/**
 * task 7.6 — lesson-line length guard: the char budget a lesson line may
 * occupy before the guard bounces it back ONCE (split permitted). Chars, not
 * tokens (measured 3.36 chars/token → ≈1,490 tokens ≈ 27% headroom under the
 * 2,048-token server cap); NO token counting in code — the server remains the
 * final backstop.
 */
export const LESSON_LINE_MAX_CHARS = 5_000;

/** task 7.6 — the pinned rejection line: appended to the SAME prompt (blank line +
 *  this line) on the over-length re-ask at both sites. Module-private — the
 *  frozen-surface pin adds only LESSON_LINE_MAX_CHARS. */
const LESSON_LINE_OVER_LENGTH_REJECTION =
  "Response rejected: over length limit. Re-emit preserving every fact — shorten the wording, or split into multiple one-line lessons.";

/** §4 house rule — similarities render to four decimals. */
function sim4(x: number): string { return x.toFixed(4); }

/** §5.5 prompt template — exact bytes, pinned (P2). One signal line + at most
 *  topK candidate `id: item` lines + the constant rules block. No sections,
 *  never the blob. */
function buildMergePrompt(bare: string, hits: CandidateHit[]): string {
  return [
    "You maintain a small, deduplicated long-term memory store of short fact lines.",
    "Decide how to merge ONE new signal into the store.",
    "",
    "New signal:",
    bare,
    "",
    "Existing rows (id: text), in similarity order:",
    hits.map(h => `${h.row.id}: ${h.row.item}`).join("\n"),
    "",
    "Rules:",
    '- "match" — the signal restates a fact already in an existing row. Include that row\'s rowId.',
    '- "new" — the signal adds a fact no existing row has. Do NOT include rowId.',
    '- "contradict" — the signal directly contradicts an existing row. Include that row\'s rowId.',
    "- rowId MUST be one of the ids listed above.",
    "",
    "Reply with exactly one JSON object and nothing else:",
    '{"action":"match","rowId":<int>} | {"action":"new"} | {"action":"contradict","rowId":<int>}',
  ].join("\n");
}

/** The 70-line pinned EXTRACT prompt (the delta spec :329-398 — transcribed
 *  VERBATIM; risk R2 isolated HERE; a wording change is a §2.6 plan deviation,
 *  flagged, never silent). Line 5 is the `{content}` slot (chunk-agnostic — the
 *  prompt is byte-identical for any input; only the slot varies). Array-of-
 *  strings + join("\n") — NO template literal. The two worked example lessons
 *  are the byte source for the vehicle's EXAMPLE_LESSON_1/_2 constants. */
const EXTRACT_PROMPT_LINES: string[] = [
    "You are extracting actionable lessons from a previous agent session's",
    "recorded content.",
    "",
    "=== SESSION CONTENT START ===",
    "{content}",
    "=== SESSION CONTENT END ===",
    "",
    "A LESSON is something durable and session-independent that was",
    "ESTABLISHED or CONFIRMED in this session:",
    "- a decision that was made, and what it decided",
    "- a root-caused failure: what broke, why, and what fixes or avoids it",
    "- a command or configuration verified to work in this session — the",
    "  exact form that works, not an attempt",
    "- a confirmed property of the system or tooling that is STABLE — where",
    "  something lives, how it behaves, what constrains it — that a future",
    "  session would otherwise have to rediscover",
    "",
    "For every category, the same test: will it still be true in a month?",
    "If it describes this session's current state, it is not a lesson.",
    "",
    "NOT lessons:",
    "- intentions or plans (\"we will do X next\")",
    "- progress updates with no durable takeaway (\"ran the tests, passed\")",
    "- current-state observations (counts, versions in flight, what's being",
    "  worked on) — a snapshot of the session, not of the system",
    "- task steps or instructions specific to this session's work",
    "- raw error text or log dumps — emit the lesson they support, not the dump",
    "- quoted material from documents or other sessions — emit the confirmed",
    "  fact in lesson form, never the document's wording",
    "",
    "If the same fact appears several times in the session, emit it once.",
    "",
    "OUTPUT — your entire response must be exactly one of these two forms,",
    "and nothing else.",
    "",
    "Form A — one bullet per lesson, each on its own line, each line",
    "starting with \"- \" (hyphen, space). Nothing before, after, or between:",
    "",
    "- Use /dev/null, not nul, to discard output in Windows bash",
    "- The 5002 embed server is spawned detached; extension code must never kill it",
    "",
    "Form B — if there are no actionable lessons, exactly this one line:",
    "",
    "(none)",
    "",
    "(none) with a period, different capitalization, or any comment is not",
    "accepted.",
    "",
    "Rules:",
    "- `(none)` is for sessions with no lessons — nothing established or",
    "  confirmed that passes the month test. Don't invent lessons to avoid",
    "  it — but don't reach for it to skip the work either: if a lesson",
    "  exists, emit it.",
    "- No minimum, no target count. Never pad to reach a number.",
    "- Emit a lesson even if it seems basic or likely already known — judging",
    "  it against existing memory is a later stage's job, not yours.",
    "- More than 10 bullets? Re-check: merge bullets that restate the same",
    "  fact, and drop any bullet that is a fact-dump — one that states a",
    "  result but gives no takeaway; if a future session could act on it,",
    "  it is a lesson. There is no maximum; never cut content to hit a",
    "  number.",
    "- Prefer one true lesson over five plausible ones.",
    "- One lesson per line, never wrapped: if it would wrap to a second",
    "  line, state the essence and where the exact form lives (file or",
    "  section) — do not paste multi-line forms; if the exact form exists",
    "  only in this session, state the essence. Use only the \"- \" marker,",
    "  never \"*\", \"•\", or numbers. No headers, no sections, no grouping,",
    "  no sub-bullets, no numbering, no prose, no preamble.",
    "- Short and self-contained: the reader is a future agent session that",
    "  never saw this one; each lesson must make sense alone."
];

/** Assembles the pinned EXTRACT prompt with the session content (or one chunk
 *  of it above the 24K guard) in the slot — the slot substitution is the ONLY
 *  variation (cross-chunk duplicates fall to the COMPARE stage, decision 11). */
function buildExtractPrompt(content: string): string {
  return EXTRACT_PROMPT_LINES.map(l => (l === "{content}" ? content : l)).join("\n");
}

/** The 90-line pinned correction-extract prompt (correction-recency-injection
 *  design §4 — transcribed VERBATIM; the transcription risk isolated HERE, as
 *  with EXTRACT_PROMPT_LINES; the 8.2(e) wording check diffs this block back
 *  against design §4). The two slot lines (${correction} / ${content}) are the
 *  ONLY variation — the block is byte-identical for any input. Array-of-
 *  strings + join("\n") — NO template literal (house pattern). The output
 *  contract (exactly one `- ` lesson line or the exact `(none)`) is enforced
 *  all-or-nothing by the shared parseExtractLessons ladder, tightened to one
 *  lesson (D-1 — the correction teaches at most one lesson). */
const CORRECTION_EXTRACT_PROMPT_LINES: string[] = [
  "An AI coding agent was working on a task that a human was directing.",
  "Partway through, the human interrupted with a correction: a short",
  "instruction that redirects the agent — usually a rejection of what it was",
  "doing, and often what to do instead.",
  "",
  "You are given the correction (one line, exactly as captured — opener-stripped",
  "per the marker) and the recorded work of that session: the task, the commands",
  "the agent ran, what succeeded or failed, and the human's messages.",
  "",
  "=== CORRECTION START ===",
  "${correction}",
  "=== CORRECTION END ===",
  "",
  "=== SESSION CONTEXT START ===",
  "${content}",
  "=== SESSION CONTEXT END ===",
  "",
  "Your task is to decide whether this correction teaches a lesson",
  "worth keeping. If it does, distill it into one line beginning with \"- \".",
  "If it does not, reply (none).",
  "",
  "A lesson is a durable, self-contained fact: what was corrected, what",
  "replaces or constrains it, and — only when the session gives you a reason",
  "— why. Never invent a reason. It must stand on its own, because a later",
  "agent session that never saw this one will read it and act on it. If the",
  "rule only holds for a specific project or repository, name that project in",
  "the line — the session shows which one.",
  "",
  "There is no lesson when:",
  "- it only concerns work in flight — something that will not still be true",
  "  in a month; or",
  "- it rejects something, and neither the correction nor the session makes a",
  "  single clear replacement, constraint, or reason available; or",
  "- it is a question, a confirmation, or a new task, not a redirect; or",
  "- the correction is empty or makes no sense.",
  "",
  "Read the session to understand the correction — what the agent was doing,",
  "what failed, and what the human set in its place. When the correction",
  "itself is bare (\"no\", \"wrong\", \"stop\"), take the rule from what the human",
  "actually did in the session — the command they ran, the value they set. But",
  "only when the session shows one clear, single fix; if it could be about",
  "several recent things, emit (none) rather than guess. Do not mine the",
  "session for any other lesson.",
  "",
  "The correction teaches at most one lesson. If it seems to teach several,",
  "write only the single most durable, most decision-changing one; if two",
  "compete, keep the one the correction itself states and drop the one you",
  "would have to infer from the session.",
  "",
  "OUTPUT — your entire reply is exactly one of these two forms and nothing",
  "else:",
  "",
  "Form A — exactly one line stating the lesson (the rule the correction",
  "establishes, not the correction repeated). It begins with \"- \" (hyphen,",
  "space) as its very first two characters — nothing before the hyphen — is",
  "one physical line and never wrapped, and carries no preamble, trailing",
  "note, or label. Keep it to one sentence: if it is running long, cut the",
  "why, never the rule, and never break the line.",
  "",
  "Form B — when there is no lesson to keep (see the rules above), exactly the",
  "six characters:",
  "(none)",
  "Lowercase, in parentheses, no period, no quotes.",
  "",
  "Three worked examples:",
  "",
  "Example 1 (Form A)",
  "Correction: \"no, use pwsh — bash breaks on Windows\"",
  "Session: the agent's bash command expanded $env:USERPROFILE to empty and",
  "failed; the human reran it in pwsh and it worked.",
  "Reply:",
  "- On Windows, use pwsh, not bash, for $env: expansions — bash makes them empty",
  "",
  "Example 2 (Form B)",
  "Correction: \"actually, skip the tests for now, we'll run them later\"",
  "Session: the agent was mid-refactor of a module, having just edited one of",
  "several files.",
  "Reply:",
  "(none)",
  "",
  "Example 3 (Form A — project-scoped, with a reason)",
  "Correction: \"no, that setting lives in session-recall.yaml\"",
  "Session: the agent changed a repo config file and it had no effect; the",
  "human moved the value to the live yaml and it worked.",
  "Reply:",
  "- In session-recall, set options in session-recall.yaml, not the repo config — Pi loads the live yaml",
  "",
  "The words \"Correction:\", \"Session:\", and \"Reply:\" are labels to help you",
  "read the examples. Your real reply is only the lesson line or (none) —",
  "never a label.",
];

/** Assembles the pinned correction-extract prompt with the swept marker's
 *  opener-stripped text in the ${correction} slot and the session's swept
 *  normal content (all @@CORR lines removed, truncated to the most recent
 *  mergeChunkChars chars) in the ${content} slot — the slot substitution is
 *  the ONLY variation (the frozen block pins the exact line placement). */
function buildCorrectionExtractPrompt(correction: string, content: string): string {
  return CORRECTION_EXTRACT_PROMPT_LINES.map(l => (l === "${correction}" ? correction : l === "${content}" ? content : l)).join("\n");
}

/** The 24K chunk guard (decision 11) — private. Plain character slice; the
 *  boundary is NOT line-aligned (deliberate simplicity pin — the spec's
 *  ⌈chars/24K⌉ is char-based); JS UTF-16 `.length` char basis. A session ≤
 *  chunkChars → exactly one chunk (the whole content — the common path).
 *  chunkChars = config.mergeChunkChars (C1's clamp 2,000–60,000 reused
 *  unchanged). */
function chunkExtractContent(content: string, chunkChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < content.length; i += chunkChars) out.push(content.slice(i, i + chunkChars));
  return out;
}

/** The all-or-nothing EXTRACT parser — the spec procedure (delta spec, carried
 *  word for word) + the pinned implementation: `string[]` (possibly empty =
 *  the exact `(none)` line), `null` = garbage. Step 1: trim, ignore empty
 *  lines anywhere; step 2: the ONLY remaining line exactly `(none)`
 *  (case-sensitive) → zero lessons; step 3: every remaining line must begin
 *  with exactly `- ` (column 0) — the lesson is everything after the marker,
 *  trailing ws trimmed, verbatim; an empty bullet is garbage; step 4: ANY
 *  other line (a header, prose, an `* `/`• ` bullet, a wrapped continuation,
 *  `(None)`) makes the WHOLE output garbage — no salvage (quietly repairing
 *  structure would hide prompt drift). */
function parseExtractLessons(text: string): string[] | null {
  const lines = text.split(/\r?\n/);                 // LF/CR/CRLF — formatting noise, not content (step 1)
  const kept: string[] = [];
  for (const l of lines) if (l.trim() !== "") kept.push(l);
  if (kept.length === 0) return null;                // whitespace-only = garbage (the seam maps true empty → null first)
  if (kept.length === 1 && kept[0].trim() === "(none)") return [];   // step 2 — exact, case-sensitive, the ONLY remaining line
  const lessons: string[] = [];
  for (const l of kept) {
    if (!l.startsWith("- ")) return null;           // step 4 — exact marker, column 0 (an indented bullet is garbage)
    const lesson = l.slice(2).replace(/\s+$/, "");   // step 3 — everything after the marker, trailing ws trimmed, verbatim (no ltrim)
    if (lesson === "") return null;                  // step 3 — an empty bullet is garbage
    lessons.push(lesson);
  }
  return lessons;
}

/** The MERGE (enrichment) prompt — decision 17, ladder branch 4 only —
 *  v5 (task 7.4, the pre-LIVE fix batch): the DRY + the 39-pair re-test
 *  (rewrite-audit-2026-08-30.md §6 O1) proved the v4 append-contract shape
 *  mis-scoped the task — a re-wording wearing a new frame reads as a new
 *  fact (row 182: one fact seven times). The merge IS the task (line 2);
 *  line 3 is one constraint (keep every fact) + one license (the wording
 *  is up to you) — no verb list (a list mis-scopes); the final line drops
 *  the "; "-append contract. Array-of-strings + join("\n") — NO template
 *  literal; the code and the design §4.5 pin move byte-identical in the
 *  same commit. */
function buildEnrichPrompt(stored: string, incoming: string): string {
  return [
    "You maintain one lesson line in a long-term memory store.",
    "Merge the stored lesson and the incoming lesson into one cohesive line.",
    "Keep every fact from both lessons; the wording is up to you.",
    "If the incoming lesson adds nothing the stored lesson doesn't already say — even in different words — output the stored lesson exactly.",
    "",
    "Stored lesson:",
    stored,
    "",
    "Incoming lesson:",
    incoming,
    "",
    "Reply with exactly one line of plain text and nothing else.",
  ].join("\n");
}

/** The MERGE (enrichment) response parser — ONE attempt, NO retry (the design
 *  pin; the fail-safe semantics make a retry valueless): trim; empty or
 *  multi-line = garbage, else the single line. Only ladder branch 4 calls it. */
function parseEnrichResponse(text: string): string | null {
  const t = text.trim();
  if (t === "" || t.includes("\n")) return null;
  return t;
}

/** The shared lesson normalizer (design §7 — P6): trim, lowercase, collapse
 *  whitespace, strip ONE trailing period. EXPORTED — the vehicle's
 *  contamination matcher + the rescue score annotation import this single
 *  copy (no second copy anywhere). */
export function normalizeLesson(s: string): string {
  let t = s.trim().toLowerCase().replace(/\s+/g, " ");
  if (t.endsWith(".")) t = t.slice(0, -1);
  return t;
}

/** §5.6 validation ladder — pinned order (P3, lock rule 3). First failure →
 *  null = garbage (the one parse retry handles it; then the failure policy).
 *  The allow-list guarantees NO DB write ever touches a row the model was not
 *  shown. Unknown extra fields are ignored (lenient on unknowns). */
function parseMergeDecision(text: string, allowedRowIds: readonly number[]): { action: MergeAction; rowId?: number } | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; } // no fence stripping — the contract is exact JSON
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as { action?: unknown; rowId?: unknown };
  if (o.action !== "match" && o.action !== "new" && o.action !== "contradict") return null;
  if (o.action === "match" || o.action === "contradict") {
    if (typeof o.rowId !== "number" || Number.isInteger(o.rowId) !== true) return null;
    if (!allowedRowIds.includes(o.rowId)) return null; // the hard allow-list
    return { action: o.action, rowId: o.rowId };
  }
  if ("rowId" in o) return null; // "new": strict absence of rowId
  return { action: "new" };
}

/** §5.4 default seam — the model pair is built ONCE per run; maxRetries 0 makes
 *  the transient gate `attempt < 0` never true, so a no-text attempt is an
 *  immediate failure with no helper-level retry (lock rule 1). */
function defaultSignalLlmCall(): SignalLlmCall {
  const pair = buildMergeModelPair();
  if (!pair) return async () => null; // no model discovered — every signal fails `timeout` via the policy
  const { modelObj, apiKey } = pair;
  return (prompt) => llmCallOnce(modelObj, apiKey, prompt, 0, {
    timeoutMs: ROWSTORE_MERGE_LLM_TIMEOUT_MS,
    logContext: " [rowstore]",
    summariesCount: 1,
    maxRetries: 0,
  }).then(r => r.text);
}

/** The infra pre-check (2026-10-16 incident): ONE fast probe of the merge
 *  model's /v1/models endpoint — refused/unreachable/aborted = the server is
 *  down. No model discovered → false (nothing to probe; legacy strike
 *  behavior preserved). */
const LLM_DOWN_PROBE_TIMEOUT_MS = 3000;
async function defaultProbeLlmDown(): Promise<boolean> {
  const pair = buildMergeModelPair();
  if (!pair) return false;
  const url = `${pair.modelObj.baseUrl.replace(/\/+$/, "")}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_DOWN_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return !res.ok;
  } catch {
    return true; // refused/reset/aborted — the server is down
  } finally {
    clearTimeout(timer);
  }
}

/** The C3.5 EXTRACT seam — C3's `defaultSignalLlmCall` body with
 *  `timeoutMs: EXTRACT_LLM_TIMEOUT_MS` (the DRY-calibrated 300s emergency-watchdog class —
 *  ruling 2). Same pair-once-per-run, maxRetries 0, the " [rowstore]" log
 *  context. A second tiny factory — NOT a config change. */
function defaultExtractLlmCall(): SignalLlmCall {
  const pair = buildMergeModelPair();
  if (!pair) return async () => null; // no model discovered — every session fails `timeout` via the policy
  const { modelObj, apiKey } = pair;
  return (prompt) => llmCallOnce(modelObj, apiKey, prompt, 0, {
    timeoutMs: EXTRACT_LLM_TIMEOUT_MS,
    logContext: " [rowstore]",
    summariesCount: 1,
    maxRetries: 0,
  }).then(r => r.text);
}

/** The decision-17 enrichment ladder (design §4.5; P6) as the SHARED body:
 *  mergeSignalsIntoRowStore's inline stage 5 and the §15 repair vehicle's
 *  replay seam (enrichMatchedRow) drive this ONE implementation — the ladder
 *  branches, the over-length re-ask, the re-embed, the one-write, and the
 *  LTROW MERGE-ENRICH audit line. `row` is the matched row (S = row.item,
 *  I = lesson, n = normalizeLesson): 1. n(S)===n(I) → score-only none; 2.
 *  I.includes(S) raw → rewrite = I; 3. n(S).includes(n(I)) → score-only
 *  none; 4. else the MERGE call (ONE attempt, NO retry): m===S → none; m
 *  non-null → rewrite = m (parse-pass — decision B, no mechanical
 *  containment gate); else (fail/timeout/garbage/over-length re-ask
 *  exhausted) → rejected. A rewrite re-embeds the NEW text exactly once; a
 *  null re-embed DEGRADES to score-only + rejected — NO sentinel strike
 *  (R5). `why` = the branch-4 classification only (null on branches 1–3 —
 *  no MERGE call was made). */
async function runEnrichmentLadder(
  db: BetterSqliteDb,
  row: { id: number; item: string; score: number },
  lesson: string,
  sessionCount: number,
  embed: (text: string, kind: EmbedKind) => Promise<number[] | null>,
  merge: SignalLlmCall,
  correctedAt?: string | null, // ADDITIVE (correction-recency-injection D-2): the swept marker timestamp for a correction-born lesson — SETS/REFRESHES the row's corrected_at through the COALESCE write paths; absent → PRESERVES (a normal lesson carries no correction timestamp)
): Promise<{
  enrich: "rewrite" | "none" | "rejected";
  finalItem: string;
  m: string | null;
  why: "llm-null" | "empty" | "multiline" | "byte-equal" | "pass" | "re-embed-null" | "over-length" | null;
  reaskedOverLength: boolean;
}> {
  let rewrite: string | null = null;
  const nS = normalizeLesson(row.item); // hoisted — branch 1 + 3 share the normalizations
  const nI = normalizeLesson(lesson);
  let enrich: "rewrite" | "none" | "rejected" = "none";
  // task 7.3 — the branch-4 outcome audit (ONE line per MERGE decision;
  // branches 1–3 emit none). `m` is recorded (const→let in the ladder
  // below); the re-embed-null degrade refines `why` at the re-embed.
  let enrichAudit: { why: "llm-null" | "empty" | "multiline" | "byte-equal" | "pass" | "re-embed-null" | "over-length"; m: string | null } | null = null;
  let reaskedOverLength = false;
  if (nS === nI) {
    // 1 — normalized-identical: score-only, no MERGE call
  } else if (lesson.includes(row.item)) {
    rewrite = lesson; // 2 — raw superset: the incoming lesson is the new text
  } else if (nS.includes(nI)) {
    // 3 — normalized restatement: score-only, no MERGE call
  } else {
    // ONE attempt, NO retry (the design pin). The seam's null (fail /
    // timeout / no text) maps straight to the rejected branch — the
    // parser only ever sees text.
    const mtext = await merge(buildEnrichPrompt(row.item, lesson));
    let m = mtext === null ? null : parseEnrichResponse(mtext);
    if (m !== null && m.length > LESSON_LINE_MAX_CHARS) {
      // task 7.6 — length guard (MERGE site): the SOLE exception to the
      // one-attempt pin — a parse-failure never re-asks; an over-length
      // parse does, ONCE (same prompt + blank line + the pinned
      // rejection line — split permitted; same seam, no backoff, the
      // per-class timeout unchanged). Still over (or the re-ask yields
      // nothing usable) → the m = null path.
      const mtext2 = await merge(buildEnrichPrompt(row.item, lesson) + "\n\n" + LESSON_LINE_OVER_LENGTH_REJECTION);
      const m2 = mtext2 === null ? null : parseEnrichResponse(mtext2);
      reaskedOverLength = true;
      m = m2 !== null && m2.length <= LESSON_LINE_MAX_CHARS ? m2 : null;
    }
    enrichAudit = {
      why: mtext === null ? "llm-null"
        : m === null && reaskedOverLength ? "over-length"
        : m === null ? (mtext.trim() === "" ? "empty" : "multiline")
        : m === row.item ? "byte-equal"
        : "pass",
      m,
    };
    if (m !== null && m === row.item) {
      // byte-equal: score-only, no re-embed
    } else if (m !== null) {
      rewrite = m; // 4 — parse-pass: the proposed merge is the new text
    } else {
      enrich = "rejected"; // fail/timeout/garbage: score-only, no strike
    }
  }
  if (rewrite !== null) {
    const docEmb = await embed(rewrite, "document"); // exactly one re-embed of the NEW text
    if (docEmb === null) {
      rewrite = null; // DEGRADE to score-only — NO sentinel strike (R5)
      enrich = "rejected";
      if (enrichAudit) enrichAudit.why = "re-embed-null"; // task 7.3 — the degrade is recorded with the model's line
    } else {
      // ONE write: item + embedding + score bump + last_seen committed together (R4).
      updateRowItemEmbeddingScoreAndLastSeen(db, row.id, rewrite, docEmb, row.score + 1, sessionCount, correctedAt);
      enrich = "rewrite";
    }
  }
  if (rewrite === null) updateRowScoreAndLastSeen(db, row.id, row.score + 1, sessionCount, correctedAt); // no second read
  // task 7.3 — the branch-4 audit line (AFTER the write, immediately before
  // the MERGE-DECISION; the model's exact words are recorded — the LIVE
  // report is self-reconstructing without a sampling appendix).
  if (enrichAudit) log(`LTROW MERGE-ENRICH rowId=${row.id} enrich=${enrich} why=${enrichAudit.why} s=${row.item} i=${lesson} m=${enrichAudit.m === null ? "-" : enrichAudit.m}`);
  return { enrich, finalItem: rewrite ?? row.item, m: enrichAudit?.m ?? null, why: enrichAudit?.why ?? null, reaskedOverLength };
}

// ─── The fold correction stream (correction-recency-injection — D-1/D-3/D-6/
// D-10 / §3) ───────────────────────────────────────────────────────────────────
// The @@CORR marker lines (the D-3 line class in unmerged_fresh_content) run
// their OWN stream inside mergeSignalsIntoRowStore — swept out BEFORE the
// normal EXTRACT stage, processed first, and isolated from the normal stream
// (D-6): a correction is apply-once (never re-processed with a re-fold), a
// line is removed from the backlog ONLY after its extraction + write succeeds
// (a valid (none) included), and a failure strikes the line's OWN
// corr_quarantine sentinel — NEVER the session's merge_quarantine (a bad
// correction cannot knock out the normal merge, §3). Every byte-pinned CORROW
// literal is constructed ONLY in this section (the single-emitter rule, D-10).

/** The meta key for one marker line's quarantine sentinel (D-6 — the line's
 *  OWN key, independent of the session's merge_quarantine:<hash> row). */
const CORR_QUARANTINE_KEY_PREFIX = "corr_quarantine:";

/** The 7-day recheck (mirrors summarizer's MERGE_QUARANTINE_RECHECK_MS /
 *  pruneMergeQuarantine): a terminally quarantined line (3 strikes) is
 *  retried by a later fold once this window has elapsed (§3). */
const CORR_QUARANTINE_RECHECK_MS = 7 * 24 * 60 * 60 * 1000; // 604,800,000 — 7 days

/** The sigil split of correctionMarkerFormat around its single ${timestamp}
 *  slot (D-3 "parse follows config" — F6): the prefix (everything before the
 *  slot) + the suffix (everything after it), so a changed format stays
 *  parseable. loadConfig guarantees exactly one ${timestamp} (trimmed,
 *  non-empty). */
function corrMarkerSigils(markerFormat: string): { prefix: string; suffix: string } {
  const idx = markerFormat.indexOf("${timestamp}");
  return { prefix: markerFormat.slice(0, idx), suffix: markerFormat.slice(idx + "${timestamp}".length) };
}

/** Parse ONE backlog line as a marker (the D-3 sweep unit): the line must
 *  begin with the format's prefix; the timestamp is the single capture group
 *  between the two sigil parts; the text is what follows the closing sigil
 *  (the capture's one separator space stripped — the verbatim,
 *  opener-stripped correction text). null = not a marker line (it stays
 *  normal content): an unclosed sigil, an empty timestamp, or an empty
 *  prefix (a degenerate format) never reads as a marker. */
function parseCorrMarkerLine(line: string, markerFormat: string): { timestamp: string; text: string } | null {
  const { prefix, suffix } = corrMarkerSigils(markerFormat);
  if (prefix === "" || !line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const idx = rest.indexOf(suffix);
  if (idx < 0) return null;
  const timestamp = rest.slice(0, idx);
  if (timestamp === "") return null;
  return { timestamp, text: rest.slice(idx + suffix.length).replace(/^\s+/, "") };
}

/** The D-3 sweep — a FULL line scan of the backlog (NOT a tail-scan — the
 *  backlog accumulates across turns, so a correction is not guaranteed to be
 *  the last line): every line that parses as a marker is pulled out, in
 *  backlog order, with its timestamp + text; the marker-free normal content
 *  rejoins its lines byte-identical (a marker-free backlog is untouched — the
 *  pre-change fold path). */
function sweepCorrectionMarkers(content: string, markerFormat: string): {
  markers: Array<{ line: string; timestamp: string; text: string }>;
  normal: string;
} {
  const markers: Array<{ line: string; timestamp: string; text: string }> = [];
  const normalLines: string[] = [];
  for (const line of content.split("\n")) {
    const parsed = parseCorrMarkerLine(line, markerFormat);
    if (parsed === null) normalLines.push(line);
    else markers.push({ line, timestamp: parsed.timestamp, text: parsed.text });
  }
  return { markers, normal: normalLines.join("\n") };
}

/** Rewrite a session's unmerged backlog in place (the §3 retain-until-
 *  success path — the marker-free normal content + the failed marker lines,
 *  or the failed marker lines alone). Mirrors the house UPDATE shape
 *  (summarizer's sqliteAppendUnmergedFreshContent /
 *  sqliteMarkSessionSummariesMerged); the merge-state predicate
 *  (IS NOT NULL AND length > 0) is untouched. */
function rewriteUnmergedFreshContent(db: BetterSqliteDb, sessionPath: string, content: string): void {
  db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run(content, sessionPath);
}

/** Strike the line's OWN quarantine sentinel (D-6 / §3 — NEVER the session's
 *  merge_quarantine): the meta row corr_quarantine:<md5(marker line)> →
 *  {markerLine, failures (1..3), quarantinedAt (ms|null)} — a per-line 3-
 *  strike count, 3 strikes → terminal (quarantinedAt = nowMs, the 7-day
 *  recheck anchor, mirroring pruneMergeQuarantine). Returns the persisted
 *  count + whether THIS strike is the terminal one (the line then leaves the
 *  backlog for the sentinel). A corrupt sentinel JSON restarts the count (the
 *  row is replaced). */
function strikeCorrQuarantine(db: BetterSqliteDb, markerLine: string, nowMs: number): { failures: number; terminal: boolean } {
  const key = CORR_QUARANTINE_KEY_PREFIX + md5Content(markerLine);
  const existing = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  let failures = 1;
  if (existing) {
    try {
      const prev = JSON.parse(existing.value) as { failures?: unknown };
      if (typeof prev.failures === "number") failures = Math.min(prev.failures, 3) + 1;
    } catch {
      // corrupt sentinel JSON — restart the count (the row is replaced below)
    }
  }
  const terminal = failures >= 3;
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    key,
    JSON.stringify({ markerLine, failures: Math.min(failures, 3), quarantinedAt: terminal ? nowMs : null }),
  );
  return { failures: Math.min(failures, 3), terminal };
}

/** The D-10 log line (byte-pinned, single emitter — rowstore.ts only):
 *  CORROW OUTCOME status=<ok|none|quarantine> corrected_at=<ts> <detail> —
 *  ok: lesson="<…>" (truncated to 120 chars + … — log-only, the row keeps
 *  the full lesson); none: - (a valid (none) — a healthy outcome, not a
 *  failure); quarantine: reason=<malformed-output|llm-error|parse-error>. */
function corrRowOutcomeLine(status: "ok" | "none" | "quarantine", correctedAt: string, detail: string): string {
  return `CORROW OUTCOME status=${status} corrected_at=${correctedAt} ${detail}`;
}

/** The D-10 ok detail — the lesson quoted, truncated to 120 chars + … when
 *  longer (log-only — the row keeps the full lesson). */
function corrRowLessonDetail(lesson: string): string {
  const t = lesson.length > 120 ? lesson.slice(0, 120) + "…" : lesson;
  return `lesson="${t}"`;
}

/** The correction reply classifier — the shared parseExtractLessons
 *  all-or-nothing ladder, tightened to the D-1 one-lesson contract: exactly
 *  one `- ` lesson line (the lesson) or the exact `(none)` (the legal empty
 *  outcome); any other shape (garbage lines, a prefixed reply, MORE than one
 *  lesson) is malformed — no salvage. */
type CorrectionReply =
  | { kind: "lesson"; lesson: string }
  | { kind: "none" }
  | { kind: "malformed" };

function classifyCorrectionReply(text: string): CorrectionReply {
  const parsed = parseExtractLessons(text);
  if (parsed !== null && parsed.length === 1) return { kind: "lesson", lesson: parsed[0] };
  if (parsed !== null && parsed.length === 0) return { kind: "none" };
  return { kind: "malformed" };
}

type CorrectionExtractOutcome =
  | { kind: "lesson"; lesson: string }
  | { kind: "none" }
  | { kind: "failure"; reason: "malformed-output" | "llm-error" };

/** The correction-extract retry ladder (the §5.4 house pattern adapted to the
 *  D-1 contract): ONE attempt of the pinned prompt; a first-call no-text is
 *  an IMMEDIATE `llm-error` (lock rule 1 — no retry); a thrown call (an LLM
 *  error) → EXACTLY ONE retry (same prompt, no backoff); a malformed first
 *  reply → EXACTLY ONE retry (same prompt, no backoff); last-observed-mode-
 *  wins on the retry (a null retry reads llm-error). */
async function correctionExtractCall(extract: SignalLlmCall, prompt: string): Promise<CorrectionExtractOutcome> {
  let threw = false;
  let text: string | null;
  try {
    text = await extract(prompt);
  } catch {
    threw = true;
    text = null;
  }
  // no-text: immediate failure, no retry (lock rule 1).
  if (!threw && text === null) return { kind: "failure", reason: "llm-error" };
  // a valid first reply (a lesson or (none)) is consumed as-is — NO second call.
  if (!threw && text !== null) {
    const c = classifyCorrectionReply(text);
    if (c.kind !== "malformed") return c;
  }
  // a retry is due (a thrown call OR a malformed first reply) — EXACTLY ONE, same prompt, no backoff.
  try {
    text = await extract(prompt);
  } catch {
    return { kind: "failure", reason: "llm-error" };
  }
  if (text === null) return { kind: "failure", reason: "llm-error" }; // last observed mode wins
  const c = classifyCorrectionReply(text);
  if (c.kind === "malformed") return { kind: "failure", reason: "malformed-output" };
  return c;
}

/** The shared per-lesson pipeline (stages 1–6 — the C3.5 body, extracted as
 *  ONE implementation for two callers): stage 1 query embed (null →
 *  embed-null, NO CANDIDATES line — retrieval never ran); stage 2
 *  findCandidates (C2 frozen: inclusive threshold, sim DESC + id ASC, topK
 *  cap); stage 3 the LTROW CANDIDATES line (every lesson whose retrieval ran);
 *  stage 4 the decision — the zero-candidate engine short-circuit (Q7) or the
 *  COMPARE call (C3's prompt byte-identical — the same candidate ordering, the
 *  validation ladder, allow-list, and the one-parse-retry policy; a first-call
 *  no-text is an IMMEDIATE timeout — lock rule 1); stage 5 the §1.5 write (the
 *  decision-17 enrichment ladder on `match` — the shared runEnrichmentLadder
 *  body; deleteRow on `contradict`; the pre-insert document embed on `new` —
 *  a null document embed leaves zero row-side side effects); stage 6 the LTROW
 *  MERGE-DECISION line (only AFTER the write committed; enrich= last). The
 *  NORMAL stream (mergeSignalsIntoRowStore's inline loop) and the CORRECTION
 *  stream (the swept @@CORR lines — D-6: "the EXISTING per-lesson pipeline —
 *  no new machinery") both drive this body; they differ only in the write's
 *  corrected_at (the correction stream passes the swept marker timestamp →
 *  the D-2 set/refresh through the COALESCE write paths; the normal stream
 *  passes nothing → preserves) and in the failure policy (onFail — normal:
 *  the session's merge_quarantine sentinel + the LTROW MERGE-SKIP line;
 *  correction: the line's OWN corr_quarantine sentinel + the CORROW line —
 *  the streams never share a failure, §3). */
type LessonPipelineOutcome =
  | { failed: true; reason: "embed-null" | "timeout" | "parse-fail"; candidates: CandidateHit[] }
  | { failed: false; decision: { action: MergeAction; rowId?: number }; by: "llm" | "engine"; topSimilarity: number | null; enrich: "rewrite" | "none" | "rejected"; candidates: CandidateHit[] };

async function runLessonPipeline(
  db: BetterSqliteDb,
  config: SessionRecallConfig,
  sessionCount: number,
  embed: (text: string, kind: EmbedKind) => Promise<number[] | null>,
  compare: SignalLlmCall,
  merge: SignalLlmCall,
  lesson: string,
  onFail: (reason: "embed-null" | "timeout" | "parse-fail", candidates: CandidateHit[]) => void,
  correctedAt?: string | null,
): Promise<LessonPipelineOutcome> {
  const queryEmb = await embed(lesson, "query");
  if (queryEmb === null) { onFail("embed-null", []); return { failed: true, reason: "embed-null", candidates: [] }; }

  const hits = findCandidates(db, queryEmb, config.embedRetrievalThreshold, config.embedRetrievalTopK);

  log(`LTROW CANDIDATES n=${hits.length} pairs=${hits.length === 0 ? "-" : hits.map(h => `${h.row.id}:${sim4(h.similarity)}`).join(":")}`);

  let decision: { action: MergeAction; rowId?: number } | null = null;
  let by: "llm" | "engine";
  if (hits.length === 0) {
    decision = { action: "new" };
    by = "engine";
  } else {
    by = "llm";
    const prompt = buildMergePrompt(lesson, hits);
    const allowedRowIds = hits.map(h => h.row.id);
    const text = await compare(prompt);
    if (text !== null) {
      decision = parseMergeDecision(text, allowedRowIds);
      if (decision === null) {
        const text2 = await compare(prompt); // EXACTLY ONE retry — same prompt, no backoff
        if (text2 === null) { onFail("timeout", hits); return { failed: true, reason: "timeout", candidates: hits }; } // last observed mode wins
        decision = parseMergeDecision(text2, allowedRowIds);
        if (decision === null) { onFail("parse-fail", hits); return { failed: true, reason: "parse-fail", candidates: hits }; }
      }
    } else {
      onFail("timeout", hits);
      return { failed: true, reason: "timeout", candidates: hits };
    }
  }

  let enrich: "rewrite" | "none" | "rejected" = "none";
  if (decision.action === "match") {
    const hit = hits.find(h => h.row.id === decision.rowId)!; // allow-listed ⇒ present
    enrich = (await runEnrichmentLadder(db, hit.row, lesson, sessionCount, embed, merge, correctedAt)).enrich;
  } else if (decision.action === "contradict") {
    deleteRow(db, decision.rowId!); // contradict: the lesson is discarded (net deletion)
  } else {
    const docEmb = await embed(lesson, "document");
    if (docEmb === null) { onFail("embed-null", hits); return { failed: true, reason: "embed-null", candidates: hits }; } // no insert, no partial state
    insertRow(db, { item: lesson, score: 1, lastSeen: sessionCount, embedding: docEmb, correctedAt: correctedAt ?? null });
  }

  log(`LTROW MERGE-DECISION action=${decision.action} rowId=${decision.action === "new" ? "-" : decision.rowId} top=${hits.length === 0 ? "-" : sim4(hits[0].similarity)} by=${by} enrich=${enrich}`);
  return { failed: false, decision, by, topSimilarity: hits.length === 0 ? null : hits[0].similarity, enrich, candidates: hits };
}

/** Process ONE swept correction marker line (D-6, the spec R2 per-run
 *  sequence): the correction-extract call (the pinned §4 prompt; ONE call per
 *  line — NO per-run cap; context = the session's swept normal content,
 *  truncated to the most recent mergeChunkChars chars) → the EXISTING
 *  per-lesson pipeline (query embed → findCandidates → decide → write) with
 *  corrected_at = the marker's timestamp (the D-2 set/refresh) → the D-10
 *  CORROW line. A valid `(none)` is a healthy consumption (no row,
 *  status=none). ANY failure (extract or pipeline) → no row + a strike on the
 *  line's OWN corr_quarantine sentinel (never the session's merge_quarantine
 *  — §3) + the CORROW quarantine line; the outcome classifies the line —
 *  `retained` (strikes < 3: it stays in the backlog for the next run's
 *  retry) or `terminal` (3rd strike: it moves to the sentinel — the 7-day
 *  recheck retries it). A success (or a valid (none)) RELEASES the line's
 *  sentinel (no orphan strike record for a resolved line). `sessionPath`
 *  labels the result records (a sentinel-recheck retry passes its meta key —
 *  the owning session's content was drained at terminalization). */
type CorrectionLineOutcome = { kind: "ok" | "none" | "retained" | "terminal" };

async function processCorrectionMarkerLine(
  db: BetterSqliteDb,
  config: SessionRecallConfig,
  marker: { line: string; timestamp: string; text: string },
  context: string,
  sessionCount: number,
  nowMs: number,
  sessionPath: string,
  signalIndex: number,
  extract: SignalLlmCall,
  compare: SignalLlmCall,
  merge: SignalLlmCall,
  embed: (text: string, kind: EmbedKind) => Promise<number[] | null>,
  result: RowStoreMergeResult,
): Promise<CorrectionLineOutcome> {
  const sentinelKey = CORR_QUARANTINE_KEY_PREFIX + md5Content(marker.line);
  const out = await correctionExtractCall(extract, buildCorrectionExtractPrompt(marker.text, context));
  if (out.kind === "none") {
    db.prepare("DELETE FROM meta WHERE key = ?").run(sentinelKey); // a resolved line releases its strike record
    log(corrRowOutcomeLine("none", marker.timestamp, "-"));
    return { kind: "none" };
  }
  if (out.kind === "failure") {
    const { terminal } = strikeCorrQuarantine(db, marker.line, nowMs);
    log(corrRowOutcomeLine("quarantine", marker.timestamp, `reason=${out.reason}`));
    return { kind: terminal ? "terminal" : "retained" };
  }
  const lesson = out.lesson;
  let pipelineTerminal = false;
  const pipeline = await runLessonPipeline(
    db, config, sessionCount, embed, compare, merge, lesson,
    (reason, candidates) => {
      // a pipeline failure of the extracted lesson — the §3 isolation: the
      // line's OWN sentinel + the CORROW line, NEVER the session's
      // merge_quarantine. The P4 reason vocabulary maps the pipeline reasons:
      // parse-fail → parse-error; embed-null / timeout → llm-error.
      const { terminal } = strikeCorrQuarantine(db, marker.line, nowMs);
      pipelineTerminal = terminal;
      result.skipped.push({ sessionPath, signalIndex, reason });
      result.signalDetail.push({ sessionPath, signalIndex, signal: lesson, candidates: candidates.map(c => ({ id: c.row.id, item: c.row.item, similarity: c.similarity })), outcome: { kind: "skipped", reason } });
      result.signalsProcessed++;
      log(corrRowOutcomeLine("quarantine", marker.timestamp, `reason=${reason === "parse-fail" ? "parse-error" : "llm-error"}`));
    },
    marker.timestamp,
  );
  if (pipeline.failed) return { kind: pipelineTerminal ? "terminal" : "retained" };
  result.decisions.push({
    sessionPath, signalIndex, action: pipeline.decision.action, rowId: pipeline.decision.rowId,
    topSimilarity: pipeline.topSimilarity, by: pipeline.by,
  });
  result.signalDetail.push({ sessionPath, signalIndex, signal: lesson, candidates: pipeline.candidates.map(c => ({ id: c.row.id, item: c.row.item, similarity: c.similarity })), outcome: { kind: "decision", action: pipeline.decision.action, rowId: pipeline.decision.rowId, by: pipeline.by, enrich: pipeline.enrich } });
  result.signalsProcessed++;
  db.prepare("DELETE FROM meta WHERE key = ?").run(sentinelKey); // a resolved line releases its strike record
  log(corrRowOutcomeLine("ok", marker.timestamp, corrRowLessonDetail(lesson)));
  return { kind: "ok" };
}

/** The row-store fold (design §1.3/§1.4, C3.5 re-key: the unit is the SESSION
 *  — one EXTRACT stage per 24K-char chunk, then the per-lesson pipeline).
 *  Flag-gated caller: index.ts step 8 (useRowStore) + the env-gated live
 *  harness. Byte-pinned lines emitted here (P1): LTROW MODE ROWSTORE (first),
 *  LTROW MERGE-DEFERRED (before any lesson line; none when 0), per lesson-
 *  yielding session LTROW LESSONS n=<k> (n=0 quiet; before the first per-
 *  lesson line), per lesson LTROW CANDIDATES then exactly one of
 *  LTROW MERGE-DECISION (enrich= token last) | LTROW MERGE-SKIP (an EXTRACT
 *  failure carries signal="extract-failed"), LTROW PRUNED <n> (last, from the
 *  C2 prune). session= identifiers carry the FULL session path (not the
 *  basename — nested subagent session files are all named session.jsonl;
 *  the 2026-09-04 quarantine post-mortem). */
export async function mergeSignalsIntoRowStore(
  db: BetterSqliteDb,
  config: SessionRecallConfig,
  options: RowStoreMergeOptions = {},
): Promise<RowStoreMergeResult> {
  // §1.3 step 1 — exactly once per call, the very first line of the run.
  log("LTROW MODE ROWSTORE");
  // step 2 — the run's session count: ONCE, before any write (§3 pinned SQL).
  const sessionCount = options.sessionCountOverride ??
    Number((db.prepare("SELECT COUNT(DISTINCT session_path) AS n FROM session_summaries").get() as { n: number }).n);
  const runNow = (options.nowMs ?? Date.now)(); // the run's single timestamp (sentinel keying, §9.1)
  const embed = options.embed ?? embedText;
  const llmBusy = options.llmBusy ?? withLlmBusy;
  // per-class seams (design §4.4): EXTRACT gets its own 30-min seam; COMPARE +
  // MERGE keep C3's 300s seam. When a test/vehicle injects options.llmCall, ONE
  // injected seam serves all three classes (the scripted sequence is in call
  // order: per session, the EXTRACT calls first — one per chunk, in chunk
  // order — then the per-lesson COMPARE/MERGE calls; the injected seam's
  // timeout is the injector's). The production path (no injection) is
  // unaffected — unit tests stay hermetic.
  const extractCall = options.llmCall ?? defaultExtractLlmCall(); // EXTRACT_LLM_TIMEOUT_MS
  const compareCall = options.llmCall ?? defaultSignalLlmCall();  // ROWSTORE_MERGE_LLM_TIMEOUT_MS (COMPARE + MERGE — C3 unchanged)
  const excluded = new Set(options.excludedPaths ?? []);

  // Infra pre-check wiring (2026-10-16 incident): a downed endpoint must not
  // strike sessions. Explicit probe options always win; hermetic runs
  // (injected llmCall/embed) default to "up" — the injected seam never
  // touches a real server, so a real probe would test the machine, not the
  // engine.
  const hermetic = options.llmCall !== undefined || options.embed !== undefined;
  const probeLlmDown = options.probeLlmDown ?? (hermetic ? (async () => false) : defaultProbeLlmDown);
  const probeEmbedDown = options.probeEmbedDown ?? (hermetic ? (async () => false) : async () => probeEmbedServerUp(config.embedServerPort));

  const outcome = await llmBusy(async () => {
    // step 4 — oldest-first unmerged sessions; quarantine-excluded paths filtered
    // out here (quarantine-pure — the engine never reads the sentinel store;
    // excluded sessions are not counted, not deferred, not logged).
    const sessions = sqliteReadUnmergedSessionSummaries(db).filter(s => !excluded.has(s.session_path));
    // step 5 — selection: whole-session atomic units, oldest-first. The cap
    // counts EXTRACT CALLS — the 24K-chunk slots (the engine's own char meter;
    // no input clamp below the 24K guard). A session starts iff it is the first
    // selected session (always — forward progress for oversized sessions; never
    // split) or fits NON-STRICTLY (count + calls <= cap — the pinned scenarios:
    // five 1-call sessions at cap 4 → A–D start, E deferred; A(1) + B(3) = 4
    // FITS a cap of 4; the operator shift from C3's `<` is deliberate — risk
    // R1, verified by the re-keyed g9 suite).
    const cap = options.extractCapOverride === null
      ? Number.POSITIVE_INFINITY
      : options.extractCapOverride ?? config.lessonExtractMaxPerRun;
    const chunkChars = config.mergeChunkChars;
    const started: Array<{ path: string; content: string; calls: number }> = [];
    let count = 0;
    let deferred = 0;
    sessions.forEach((s, i) => {
      const chars = s.unmerged_fresh_content.length;
      const calls = chars <= chunkChars ? 1 : Math.ceil(chars / chunkChars);
      if (i === 0 || count + calls <= cap) {
        started.push({ path: s.session_path, content: s.unmerged_fresh_content, calls });
        count += calls;
      } else {
        deferred++;
      }
    });
    // step 6 — at most one DEFERRED line per run, before any signal line.
    if (deferred > 0) log(`LTROW MERGE-DEFERRED sessions=${deferred}`);

    const result: RowStoreMergeResult = {
      signalsProcessed: 0, sessionsMarkedMerged: 0, sessionsFailed: [], deferredSessions: deferred,
      decisions: [], skipped: [], signalDetail: [], pruned: 0, sessionCount, llmBusySkipped: false,
    };

    // step 5.5 — the correction 7-day recheck (D-6 / §3) — BEFORE the session
    // loop (the correction stream precedes the normal stream): a terminally
    // quarantined marker line (3 strikes → quarantinedAt set; the line left
    // its session's backlog at terminalization) is retried once its 7-day
    // recheck is due. The sentinel holds only the marker line — the owning
    // session's content was drained, so the retry's context slot is the empty
    // string (judgment pin 4). A success writes the row (corrected_at = the
    // marker timestamp) and RELEASES the sentinel; a failure re-arms the
    // recheck (quarantinedAt = now — the next retry is another 7 days out).
    // A sentinel line that no longer parses under the current
    // correctionMarkerFormat (F6 — a format change orphans pre-existing
    // markers) is retained silently: never lost, re-checked every run, a no-op
    // until the format matches again. The sentinel-retry LLM calls ride the
    // raw per-class seams (the onLlmCall timing seam is session-scoped — the
    // recheck has no session).
    for (const sentinel of db.prepare("SELECT key, value FROM meta WHERE key LIKE ?").all(CORR_QUARANTINE_KEY_PREFIX + "%") as Array<{ key: string; value: string }>) {
      let entry: unknown;
      try {
        entry = JSON.parse(sentinel.value);
      } catch {
        continue; // corrupt sentinel JSON — kept (the house quarantine posture)
      }
      if (typeof entry !== "object" || entry === null) continue;
      const sentinelEntry = entry as { markerLine?: unknown; quarantinedAt?: unknown };
      if (typeof sentinelEntry.markerLine !== "string" || typeof sentinelEntry.quarantinedAt !== "number") continue;
      if (runNow - sentinelEntry.quarantinedAt < CORR_QUARANTINE_RECHECK_MS) continue; // the recheck is not due
      const parsed = parseCorrMarkerLine(sentinelEntry.markerLine, config.correctionMarkerFormat);
      if (parsed === null) continue; // an orphaned-format line — retained, never lost
      await processCorrectionMarkerLine(
        db, config, { line: sentinelEntry.markerLine, timestamp: parsed.timestamp, text: parsed.text },
        "", sessionCount, runNow, sentinel.key, -1,
        extractCall, compareCall, compareCall, embed, result,
      );
    }

    for (const s of started) {
      // infra pre-check: are the endpoints down RIGHT NOW? A failure while
      // down is infrastructure, not a record fault — it skips the quarantine
      // strike (2026-10-16 incident: the 2026-10-13 5001 outage parked 3
      // unrelated sessions for 7 days; the 2026-10-15 5002 death struck 2
      // more). The session stays in the backlog for the next run's retry.
      const [llmDown, embedDown] = await Promise.all([probeLlmDown(), probeEmbedDown()]);
      // the per-attempt timing seam (additive, design §1.2): fires AFTER every
      // attempt of every class (retries included), durationMs = the attempt's
      // wall time, sessionPath = the full session path (the DRY's per-class
      // latency-distribution source — p50/p90/max).
      const onCall = options.onLlmCall;
      const timed = (callClass: "extract" | "compare" | "merge", call: SignalLlmCall): SignalLlmCall =>
        async (prompt: string) => {
          const t0 = Date.now();
          const text = await call(prompt);
          if (onCall) onCall(callClass, Date.now() - t0, s.path);
          return text;
        };
      const extract = timed("extract", extractCall);
      const compare = timed("compare", compareCall);
      const merge = timed("merge", compareCall); // the MERGE class reuses C3's 300s seam

      // ── the correction stream (FIRST — D-6 / spec R2) ─────────────────────
      // Sweep-before-extract: the @@CORR marker lines are pulled out of the
      // backlog BEFORE the EXTRACT stage (the normal stream's chunks are
      // marker-free). Each swept line, in backlog order, runs ONE
      // correction-extract call (NO per-run cap — the one-per-3-turns capture
      // rate limit bounds the count) with the session's swept normal content
      // (the most recent mergeChunkChars chars — the D-6 context bound) as
      // context → the EXISTING per-lesson pipeline with corrected_at = the
      // marker's timestamp (the D-2 set/refresh). A line is consumed ONLY on
      // success (a valid (none) included); a failed line is RETAINED for the
      // next run (its own corr_quarantine sentinel struck — never the
      // session's merge_quarantine, §3) and the normal stream runs regardless
      // (failure isolation).
      const { markers, normal } = sweepCorrectionMarkers(s.content, config.correctionMarkerFormat);
      const corrContext = normal.slice(-chunkChars); // the D-6 context bound — the most recent mergeChunkChars chars (slice(-n) is the whole string once n ≥ length; mergeChunkChars is clamped ≥ 2,000)
      const retainedMarkerLines: string[] = [];
      let corrLessonCount = 0;
      for (let mi = 0; mi < markers.length; mi++) {
        const lineOutcome = await processCorrectionMarkerLine(
          db, config, markers[mi], corrContext, sessionCount, runNow, s.path, mi,
          extract, compare, merge, embed, result,
        );
        if (lineOutcome.kind === "ok") corrLessonCount++;
        else if (lineOutcome.kind === "retained") retainedMarkerLines.push(markers[mi].line);
        // "none" / "terminal": the line is consumed (the terminal line now
        // lives in its sentinel — the 7-day recheck retries it).
      }

      // ── EXTRACT stage (session-atomic: all-or-fail) ─────────────────────────
      // Chunk per the 24K guard; per chunk in chunk order, the one-call +
      // at-most-one-PARSE-retry loop (C3's pattern carried): first-call no-text
      // → IMMEDIATE `timeout` (lock rule 1 — no retry); garbage → exactly one
      // retry (same prompt, no backoff); retry no-text → `timeout` (last
      // observed mode wins); retry garbage → `parse-fail`. ANY failure → the
      // session-level failure policy (decision 9): sentinel strike on the SAME
      // (session, content-md5) key a lesson failure would use, the
      // extract-failed SKIP line, STOP the session (remaining chunks
      // unattempted — the stage precedes all lesson writes), continue.
      const lessons: string[] = [];
      let extractFailure: "timeout" | "parse-fail" | null = null;
      for (const chunk of chunkExtractContent(normal, chunkChars)) { // marker-free — sweep-before-extract (D-3/D-6); a marker-only backlog yields no chunks
        if (extractFailure !== null) break;
        const prompt = buildExtractPrompt(chunk);
        const text = await extract(prompt);
        if (text === null) { extractFailure = "timeout"; break; }
        let parsed = parseExtractLessons(text);
        if (parsed === null) {
          const text2 = await extract(prompt); // EXACTLY ONE retry — same prompt, no backoff
          if (text2 === null) { extractFailure = "timeout"; break; } // last observed mode wins
          parsed = parseExtractLessons(text2);
        }
        if (parsed === null) {
          extractFailure = "parse-fail";
        } else {
          // parsed is non-null in this branch (the null case above always
          // leaves extractFailure set), so the push below is null-safe.
          if (parsed.some(l => l.length > LESSON_LINE_MAX_CHARS)) {
            // task 7.6 — length guard (EXTRACT site): ANY line over budget →
            // re-ask ONCE (same prompt + blank line + the pinned rejection line —
            // split permitted). Retry budget: at most ONE retry PER FAILURE CLASS
            // (parse-garbage OR over-length), hard cap 3 total attempts per
            // chunk, no loops.
            const text3 = await extract(prompt + "\n\n" + LESSON_LINE_OVER_LENGTH_REJECTION);
            if (text3 !== null) {
              const parsed3 = parseExtractLessons(text3);
              if (parsed3 !== null && !parsed3.some(l => l.length > LESSON_LINE_MAX_CHARS)) parsed = parsed3;
            }
            if (parsed.some(l => l.length > LESSON_LINE_MAX_CHARS)) extractFailure = "parse-fail"; // still over → the EXISTING session-failure policy — no new strike semantics
          }
          if (extractFailure === null) lessons.push(...parsed);
        }
      }
      if (extractFailure !== null) {
        const infraDown = llmDown; // EXTRACT is an LLM call — the chat endpoint is the relevant side
        const skipReason = infraDown ? "llm-down" : extractFailure;
        const rec = infraDown ? null : recordMergeFailure(db, s.path, md5Content(s.content), runNow); // meta only, no row write; infra → NO strike
        result.skipped.push({ sessionPath: s.path, signalIndex: -1, reason: skipReason });
        result.signalDetail.push({ sessionPath: s.path, signalIndex: -1, signal: "extract-failed", candidates: [], outcome: { kind: "skipped", reason: skipReason } });
        result.signalsProcessed++;
        log(`LTROW MERGE-SKIP reason=${skipReason} session=${s.path} signal="extract-failed"`); // FULL path — nested subagent files are all named session.jsonl (2026-09-04 quarantine post-mortem)
        if (rec !== null && rec.failures >= 3) log(`rowstore merge: quarantined ${s.path} (3 consecutive failures)`);
        result.sessionsFailed.push(s.path);
        if (markers.length > 0) {
          // the swept markers must not re-fold (apply-once — D-6): rewrite the
          // backlog as the marker-free normal content (re-folded next run) +
          // the retained failed marker lines (an extract failure implies
          // non-empty normal content, so it is always present).
          rewriteUnmergedFreshContent(db, s.path, [normal, ...retainedMarkerLines].filter(p => p !== "").join("\n"));
        }
        continue;
      }
      // n counts BOTH streams' lessons (the correction stream's resolved
      // lessons + the normal stream's extracted lessons). n = 0 → quiet: NO
      // LESSONS line (n=0 quiet, decision 10), no per-lesson lines, no skip
      // line — mark merged (processed, not retried).
      const totalLessons = corrLessonCount + lessons.length;
      if (totalLessons > 0) {
        // k > 0 → the session's line, once, after the EXTRACT stage resolves,
        // before its first normal per-lesson line (the correction stream's
        // per-lesson lines precede it — the count covers them).
        log(`LTROW LESSONS n=${totalLessons} session=${s.path}`);
      }

      let sessionFailed = false;
      for (let i = 0; i < lessons.length; i++) {
        const lesson = lessons[i];
        /** §9 — stop-session-continue-run: the verbatim sentinel keying
         *  (sessionPath + md5Content of the run's content), then MERGE-SKIP, then
         *  the 3rd-strike house line. No row write. A match-decision
         *  enrichment failure is NOT a lesson failure (the fail-safe — §4.5). */
        const fail = (reason: "embed-null" | "timeout" | "parse-fail", candidates: CandidateHit[] = []) => {
          const infraDown = reason === "embed-null" ? embedDown : llmDown; // the failing stage → its endpoint
          const skipReason = infraDown ? (reason === "embed-null" ? "embed-down" : "llm-down") : reason;
          const rec = infraDown ? null : recordMergeFailure(db, s.path, md5Content(s.content), runNow); // infra → NO strike
          result.skipped.push({ sessionPath: s.path, signalIndex: i, reason: skipReason });
          result.signalDetail.push({ sessionPath: s.path, signalIndex: i, signal: lesson, candidates: candidates.map(c => ({ id: c.row.id, item: c.row.item, similarity: c.similarity })), outcome: { kind: "skipped", reason: skipReason } });
          result.signalsProcessed++;
          log(`LTROW MERGE-SKIP reason=${skipReason} session=${s.path} signal="${lesson}"`);
          if (rec !== null && rec.failures >= 3) log(`rowstore merge: quarantined ${s.path} (3 consecutive failures)`);
          sessionFailed = true;
        };
        // stages 1–6 via the shared per-lesson pipeline (query embed →
        // findCandidates → CANDIDATES → decide (+the one-parse-retry ladder)
        // → the §1.5 write → MERGE-DECISION after the commit) — the normal
        // stream's failure policy is the session's merge_quarantine sentinel
        // + MERGE-SKIP (fail); the correction stream drives the SAME body with
        // its own sentinel + CORROW policy and the marker timestamp as
        // corrected_at (D-6 — the EXISTING per-lesson pipeline, no new
        // machinery).
        const out = await runLessonPipeline(db, config, sessionCount, embed, compare, merge, lesson, fail);
        if (out.failed) break;
        result.decisions.push({
          sessionPath: s.path, signalIndex: i, action: out.decision.action, rowId: out.decision.rowId,
          topSimilarity: out.topSimilarity, by: out.by,
        });
        result.signalDetail.push({ sessionPath: s.path, signalIndex: i, signal: lesson, candidates: out.candidates.map(c => ({ id: c.row.id, item: c.row.item, similarity: c.similarity })), outcome: { kind: "decision", action: out.decision.action, rowId: out.decision.rowId, by: out.by, enrich: out.enrich } });
        result.signalsProcessed++;
      }
      if (sessionFailed || retainedMarkerLines.length > 0) {
        result.sessionsFailed.push(s.path); // NOT marked merged — monotonic, no silent loss (§9.2 / §3 retain-until-success)
        if (markers.length > 0) {
          // the failed marker lines are RETAINED for the next run; the
          // marker-free normal content is drained when (and only when) the
          // normal stream resolved it (sessionFailed = false — its lessons
          // were written: the backlog holds the failed marker lines ONLY —
          // judgment pin 3). A normal-stream failure keeps the normal content
          // for the pre-existing re-fold alongside the failed marker lines.
          const parts = sessionFailed ? [normal, ...retainedMarkerLines] : retainedMarkerLines;
          rewriteUnmergedFreshContent(db, s.path, parts.filter(p => p !== "").join("\n"));
        }
      } else {
        sqliteMarkSessionSummariesMerged(db, [s.path]); // mark-merged strictly last — once BOTH streams are done (every normal lesson resolved + every correction line succeeded or terminally quarantined — P7)
        result.sessionsMarkedMerged++;
      }
    }

    // run end — prune ALWAYS (even when nothing was processed); LTROW PRUNED <n>
    // (n = 0 included) emits from inside it — the last line of the run.
    result.pruned = pruneStaleRowsInStore(db, config, sessionCount);
    return result;
  });

  if (outcome === null) {
    // withLlmBusy skip-not-queue (run-level — it logged its own line). No writes,
    // nothing marked, no prune.
    log("rowstore merge: skipped (llm busy)");
    return {
      signalsProcessed: 0, sessionsMarkedMerged: 0, sessionsFailed: [], deferredSessions: 0,
      decisions: [], skipped: [], signalDetail: [], pruned: 0, sessionCount, llmBusySkipped: true,
    };
  }
  return outcome;
}

// ─── §15 repair vehicle seam (task 15.2 — the export-surface pin re-keyed
// ADDITIVELY per the C2 P2 precedent: the frozen surface gains exactly this
// ONE export; the per-lesson pipeline is NOT re-runnable for the 39-pair
// replay — the COMPARE matcher would re-match against a changing store — so
// the replay supplies the match itself) ────────────────────────────────────

/** Drive the engine's REAL decision-17 enrichment ladder against a KNOWN
 * matched row (the §15 repair vehicle's replay seam): the row's current
 * item IS `S`, `lesson` IS `I` — the match is GIVEN (no retrieval, no
 * COMPARE call). The shared body runEnrichmentLadder carries the ladder
 * branches, the over-length re-ask, the re-embed, the one-write, and the
 * LTROW MERGE-ENRICH audit line (constructed ONLY here — the vehicle
 * captures it via the house logger spy; single-emitter discipline). The
 * caller injects only the MERGE-class seam (options.mergeCall — the
 * tripwire + forward in the PLAN vehicle) and the embed seam (options.embed
 * — 5002-only) and never constructs a prompt. Defaults: the C3 300s
 * MERGE-class seam (the mock alias's forwarding reaches the real 5001) + the
 * C1 embedText (5002). Throws on an absent row (a stale plan — the vehicle
 * validates first). */
export async function enrichMatchedRow(
  db: BetterSqliteDb,
  rowId: number,
  lesson: string,
  sessionCount: number,
  options: {
    mergeCall?: SignalLlmCall;
    embed?: (text: string, kind: EmbedKind) => Promise<number[] | null>;
  } = {},
): Promise<{
  enrich: "rewrite" | "none" | "rejected";
  beforeItem: string;
  finalItem: string;
  m: string | null;
  why: "llm-null" | "empty" | "multiline" | "byte-equal" | "pass" | "re-embed-null" | "over-length" | null;
  reaskedOverLength: boolean;
}> {
  const row = db
    .prepare("SELECT id, item, score FROM long_term_rows WHERE id = ?")
    .get(rowId) as { id: number; item: string; score: number } | undefined;
  if (!row) throw new Error(`enrichMatchedRow: row ${rowId} not found (stale plan?)`);
  const merge = options.mergeCall ?? defaultSignalLlmCall();
  const embed = options.embed ?? embedText;
  const out = await runEnrichmentLadder(db, row, lesson, sessionCount, embed, merge);
  return { enrich: out.enrich, beforeItem: row.item, finalItem: out.finalItem, m: out.m, why: out.why, reaskedOverLength: out.reaskedOverLength };
}
