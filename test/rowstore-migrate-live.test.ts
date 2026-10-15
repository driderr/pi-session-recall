// rowstore-migrate-live.test.ts — C3.5 §16.1: the 16.1 MIGRATION vehicle
// (the operator's 2026-09-01 scope ruling: "rows + fold-state sync" — migrate
// the repaired 382-row stable copy to production in ONE short transaction,
// plus the fold-state sync: mark the drained-AND-stable sessions merged,
// drop the prod-only merge_quarantine sentinels).
//
// WHY THIS EXISTS: ruling 6 (2026-08-30/31) — "Migrate the DRY copy to
// production — do NOT re-drain". The stable copy (dry-run-copy-2026-08-30.db,
// sha256-pinned 2edc224f… = the 15.5-repaired 382-row store) IS the
// adjudicated truth. A rows-only migration (option A) was rejected: it would
// force a C4-flip re-drain of the 105 drained sessions (~105 local-LLM
// re-EXTRACTs, score inflation against true confirmation counts — ruling 9,
// near-dup risk). So the migration ALSO syncs the fold state: every session
// the copy already drained AND whose content is unchanged since (the
// last_fresh_hash equality) is marked merged in production; the prod-only
// merge_quarantine sentinels (keys absent from the copy) are dropped.
//
// TWO MODES (env-gated; exactly one expected per invocation) + a hermetic
// unit suite (runs WITHOUT env — the vehicle logic, unit-tested here):
//
//   npx vitest run rowstore-migrate-live
//     Hermetic unit describes only (no env, no production access — all test
//     DB pairs are small tmpdir files with the minimal real-shaped schema;
//     the real stable copy and the production DB are NEVER opened).
//
//   ROWSTORE_MIGRATE_DRY=1 npx vitest run rowstore-migrate-live
//     Rehearses the FULL migration on a VACUUM INTO throwaway of production
//     (production opened strictly read-only — the house readonly open, the
//     API form of file:...?mode=ro; this better-sqlite3 build does not enable
//     SQLite's file: URI mode, verified at build time). HARD-asserts the
//     production rowstore state UNCHANGED (rows still 146; blob sha
//     unchanged; the mark-sync candidates still unmerged; the sentinel set
//     unchanged). The production main/-wal file bytes are captured
//     pre/post and REPORTED (present/size/hash) — NEVER asserted (the
//     2026-08-31 incident: an old WAL byte-identity assert fired on the
//     live session's own writes). Prints + writes
//     <tmp>/rowstore-migrate-dry-report.md — the directory is RETAINED
//     (the operator's review input before the LIVE gate).
//
//   ROWSTORE_MIGRATE_LIVE=1 npx vitest run rowstore-migrate-live
//     The ONE production mutation of 16.1. One-shot guard (rows ≠ 146 →
//     refuse "migration already applied" — the repair-vehicle pattern) →
//     copy integrity pin → the pre-migration VACUUM INTO backup from a
//     read-only handle (repo path, auto-gitignored) → runtime capture →
//     ONE BEGIN IMMEDIATE transaction (DELETE long_term_rows → INSERT the
//     382 copy rows ids preserved → the mark-sync UPDATEs → the sentinel
//     DELETEs → COMMIT; busy_timeout 5000) → the read-only post-verify →
//     report + sidecar JSON into <tmp>/rowstore-migrate-live-<rand>/
//     (RETAINED — the record).
//
// Migration semantics (the 2026-09-01 design, apply-progress.md tail):
//   - Rows: FULL REPLACE — the copy's 382 rows (id/item/score/last_seen/
//     embedding; the copy's ids preserved) replace prod's 146. The
//     embeddings ride along inside the rows: ZERO LLM, ZERO embed calls,
//     5001/5002 never touched (pure SQLite).
//   - Mark-sync set (computed at run time in BOTH legs): prod sessions
//     where unmerged_fresh_content IS NOT NULL AND length > 0 (the house
//     unmerged predicate), AND the copy's session_summaries row for the
//     same session_path exists with unmerged_fresh_content NULL or empty
//     (drained by the copy), AND prod.last_fresh_hash === copy.
//     last_fresh_hash (stable — content unchanged since the drain;
//     sessions with newer content STAY unmerged — C4's fold processes only
//     their delta against the 382 rows). For each: UPDATE session_summaries
//     SET unmerged_fresh_content = NULL, last_merged_hash = <copy's
//     last_merged_hash> WHERE session_path = ?.
//   - Sentinel-drop set: the meta keys in prod starting with
//     merge_quarantine: that are ABSENT from the copy's meta (computed +
//     reported with the key names — expected 1 at design time, NEVER
//     hardcoded).
//   - The long_term blob (id=1) is NEVER touched (HARD assert
//     byte-identical, either leg).
//
// Hermetic DB pair (os.tmpdir, minimal real-shaped schema):
//   long_term_rows(id,item,score,last_seen,embedding) — the real DDL column
//   definitions; session_summaries(session_path,last_fresh_hash,
//   last_merged_hash,unmerged_fresh_content); meta(key,value);
//   long_term(id,summary). The production DB (WAL) is opened read-write
//   ONLY by the env-gated LIVE leg, behind the one-shot guard + the copy
//   pin + the backup.
//
// Safety: the default run (no env) touches NOTHING outside os.tmpdir. The
// DRY leg opens production strictly read-only (structurally cannot write).
// LIVE is one-shot (the guard refuses a re-run); the pre-migration backup
// is KEPT (C4's closeout owns its deletion). useRowStore must be false
// (pre-flip tool — post-flip the runtime owns row writes and this
// discipline does not apply).

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as BetterSqliteDb } from "better-sqlite3";
import { loadConfigOnce } from "../config.js";
import { SQLITE_PATH } from "../discoverer.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGE_DIR = join(REPO_ROOT, "openspec", "changes", "archive", "2026-08-31-rowstore-lessons"); // C3.5 archive move (b2fa687) relocated the change dir
const COPY_PATH = join(CHANGE_DIR, "dry-run-copy-2026-08-30.db");

// ─── The pins (the 2026-09-01 design; the copy sha verified against the
// ─── real file at build time) ──────────────────────────────────────────────
const COPY_SHA256_PIN = "2edc224f0a4de0dbcc691d8d233b9c0b864a0f740ba7c1dc5d52fa6127066619";
const COPY_ROWS_PIN = 382;
const PROD_ROWS_PIN = 146;
const BACKUP_PREFIX = "production-pre-migration-"; // + <YYYY-MM-DD> + .db (repo path, auto-gitignored *.db)

// ─── Core types ────────────────────────────────────────────────────────────

/** The migration pin: the copy to install + the expected pre-state of the
 *  target. Real legs: the 2edc…/382/146 pins. Hermetic: the fixture's own
 *  computed values (the same fail-closed logic, smaller numbers). */
export interface MigratePin {
  copyPath: string;
  expectedCopySha256: string; // the copy MAIN-file sha256 pin (hard, fail-closed)
  expectedCopyRows: number;   // the copy's long_term_rows count pin (hard, fail-closed)
  expectedProdRows: number;   // the target's expected pre-state count (fail-closed + the one-shot guard)
}

export interface CopyRow {
  id: number;
  item: string;
  score: number;
  lastSeen: number;
  embedding: string; // the stored JSON text (byte-compared, never re-serialized)
}

interface CopySession {
  lastFreshHash: string | null;
  lastMergedHash: string | null;
  drained: boolean; // copy's unmerged_fresh_content NULL or empty
}

export interface CopyData {
  rows: CopyRow[]; // id ASC
  sessions: Map<string, CopySession>;
  sentinels: Map<string, string>; // merge_quarantine:* key → value
}

interface ProdSession {
  sessionPath: string;
  lastFreshHash: string | null;
  unmerged: boolean; // the house unmerged predicate
}

export interface MarkSyncEntry {
  sessionPath: string;
  lastMergedHash: string | null; // the copy's value (carried as-is)
}

export interface MigrateOutcome {
  rowsBefore: number;
  rowsAfter: number;
  markSync: MarkSyncEntry[]; // sorted by sessionPath
  sentinelDrops: string[]; // sorted keys
  blobSha256Before: string;
  blobSha256After: string;
}

// ─── Shared read helpers ───────────────────────────────────────────────────

const sha256Of = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const sha256File = (p: string): string | null => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);

/** The house unmerged predicate (AGENTS.md — matches sqliteCountUnmergedSessions). */
const UNMERGED_PREDICATE = "unmerged_fresh_content IS NOT NULL AND length(unmerged_fresh_content) > 0";

function readProdSessions(db: BetterSqliteDb): ProdSession[] {
  return (db.prepare(`SELECT session_path, last_fresh_hash FROM session_summaries WHERE ${UNMERGED_PREDICATE} ORDER BY session_path`).all() as Array<{
    session_path: string; last_fresh_hash: string | null;
  }>).map(r => ({ sessionPath: r.session_path, lastFreshHash: r.last_fresh_hash, unmerged: true }));
}

function readSentinels(db: BetterSqliteDb): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of db.prepare("SELECT key, value FROM meta WHERE key LIKE 'merge_quarantine:%' ORDER BY key").all() as Array<{ key: string; value: string }>) out.set(r.key, r.value);
  return out;
}

function blobSha256(db: BetterSqliteDb, where: string): string {
  const row = db.prepare("SELECT summary FROM long_term WHERE id = 1").get() as { summary: string } | undefined;
  if (!row) throw new Error(`migrate: long_term id=1 missing on ${where} — refusing`);
  return sha256Of(row.summary);
}

// ─── The migration core (exported — the hermetic suite exercises it) ──────

/** The copy integrity pin — HARD, fail-closed BEFORE any write: the main-file
 *  sha256, the row count, and every row's embedding (non-null, length > 10).
 *  Returns the copy's data (rows, session map, sentinel keys). */
export function pinCopy(pin: MigratePin): CopyData {
  if (!existsSync(pin.copyPath)) throw new Error(`migrate: the copy is missing — refusing: ${pin.copyPath}`);
  const sha = sha256File(pin.copyPath);
  if (sha !== pin.expectedCopySha256) throw new Error(`migrate: copy sha mismatch — pin ${pin.expectedCopySha256.slice(0, 8)}…, found ${sha ? `${sha.slice(0, 8)}…` : "unreadable"} — refusing (fail-closed, before any write)`);
  const db = new Database(pin.copyPath, { readonly: true });
  try {
    const count = (db.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
    if (count !== pin.expectedCopyRows) throw new Error(`migrate: copy row count drift — expected ${pin.expectedCopyRows}, found ${count} — refusing (fail-closed, before any write)`);
    const rawRows = db.prepare("SELECT id, item, score, last_seen, embedding FROM long_term_rows ORDER BY id").all() as Array<{ id: number; item: string; score: number; last_seen: number; embedding: string | null }>;
    const rows: CopyRow[] = [];
    for (const r of rawRows) {
      if (r.embedding === null) throw new Error(`migrate: copy row ${r.id} has a NULL embedding — refusing (fail-closed, before any write)`);
      let parsed: unknown;
      try { parsed = JSON.parse(r.embedding); } catch { throw new Error(`migrate: copy row ${r.id} embedding is not JSON — refusing (fail-closed, before any write)`); }
      if (!Array.isArray(parsed) || parsed.length <= 10) throw new Error(`migrate: copy row ${r.id} embedding length ${Array.isArray(parsed) ? parsed.length : "n/a"} must be > 10 — refusing (fail-closed, before any write)`);
      rows.push({ id: r.id, item: r.item, score: r.score, lastSeen: r.last_seen, embedding: r.embedding });
    }
    const sessions = new Map<string, CopySession>();
    for (const s of db.prepare("SELECT session_path, last_fresh_hash, last_merged_hash, unmerged_fresh_content FROM session_summaries").all() as Array<{ session_path: string; last_fresh_hash: string | null; last_merged_hash: string | null; unmerged_fresh_content: string | null }>) {
      sessions.set(s.session_path, { lastFreshHash: s.last_fresh_hash, lastMergedHash: s.last_merged_hash, drained: s.unmerged_fresh_content === null || s.unmerged_fresh_content === "" });
    }
    return { rows, sessions, sentinels: readSentinels(db) };
  } finally {
    db.close();
  }
}

/** The prod pre-state guard + the LIVE one-shot guard (fail-closed, BEFORE
 *  any write): count === the copy's row count → "migration already applied";
 *  count !== the expected pre-state → "row count drift". */
export function assertProdRowCount(db: BetterSqliteDb, pin: MigratePin): number {
  const count = (db.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
  if (count === pin.expectedCopyRows) throw new Error(`migration already applied (long_term_rows = ${count} = the migration's outcome) — refusing to re-run (one-shot; to reset: restore production from its pre-migration backup — a fresh operator decision, never a convenience)`);
  if (count !== pin.expectedProdRows) throw new Error(`migrate: production row count drift — expected ${pin.expectedProdRows}, found ${count} — refusing (fail-closed, before any write)`);
  return count;
}

/** The mark-sync set (the 2026-09-01 design): drained (in the copy + the
 *  copy shows merged) ∩ stable (prod.last_fresh_hash === copy.
 *  last_fresh_hash). Sorted by sessionPath. */
export function computeMarkSyncSet(prodSessions: ProdSession[], copy: CopyData): MarkSyncEntry[] {
  const out: MarkSyncEntry[] = [];
  for (const s of prodSessions) {
    if (!s.unmerged) continue; // already-merged stays (not unmerged in prod)
    const c = copy.sessions.get(s.sessionPath);
    if (!c) continue; // drained-but-absent-from-copy stays
    if (!c.drained) continue; // the copy still carries it unmerged → stays
    if (s.lastFreshHash !== c.lastFreshHash) continue; // drained-but-unstable (newer content since the drain) stays
    out.push({ sessionPath: s.sessionPath, lastMergedHash: c.lastMergedHash });
  }
  out.sort((a, b) => (a.sessionPath < b.sessionPath ? -1 : 1));
  return out;
}

/** The full pipeline against a TARGET db (DRY: the VACUUM INTO throwaway;
 *  LIVE: production; hermetic: the tmpdir prod stand-in):
 *  (1) copy pin → (2) run-time capture (the count guard, the blob sha, the
 *  mark-sync set, the sentinel-drop set) → (3) ONE transaction
 *  (BEGIN IMMEDIATE: DELETE long_term_rows → INSERT the copy's rows → the
 *  mark-sync UPDATEs → the sentinel DELETEs → COMMIT; ROLLBACK on any
 *  failure) → (4) the post-verify (a fresh READ-ONLY handle on the target
 *  file: exact-set equality vs the in-memory copy, blob byte-identity, the
 *  marked sessions unmerged=0, the sentinel set == the copy's). */
export function runMigration(targetDb: BetterSqliteDb, targetPath: string, pin: MigratePin): MigrateOutcome {
  // (1) The copy integrity pin — hard, fail-closed before any write.
  const copy = pinCopy(pin);
  // (2) The run-time capture — fail-closed before any write (WAL reality: an
  //     active Pi session writes production at turn boundaries — pin only what
  //     the migration owns, recomputed at run time).
  const rowsBefore = assertProdRowCount(targetDb, pin);
  const blobBefore = blobSha256(targetDb, "the target");
  const markSync = computeMarkSyncSet(readProdSessions(targetDb), copy);
  const prodSentinels = readSentinels(targetDb);
  const sentinelDrops = [...prodSentinels.keys()].filter(k => !copy.sentinels.has(k)).sort();
  // (3) The ONE transaction: BEGIN IMMEDIATE → DELETE long_term_rows → INSERT
  //     the copy's rows (ids preserved) → the mark-sync UPDATEs → the sentinel
  //     DELETEs → COMMIT (ROLLBACK on any failure — no partial writes).
  const insRow = targetDb.prepare("INSERT INTO long_term_rows (id, item, score, last_seen, embedding) VALUES (?, ?, ?, ?, ?)");
  const updSync = targetDb.prepare("UPDATE session_summaries SET unmerged_fresh_content = NULL, last_merged_hash = ? WHERE session_path = ?");
  const delSentinel = targetDb.prepare("DELETE FROM meta WHERE key = ?");
  targetDb.exec("BEGIN IMMEDIATE");
  try {
    targetDb.exec("DELETE FROM long_term_rows");
    for (const r of copy.rows) insRow.run(r.id, r.item, r.score, r.lastSeen, r.embedding);
    for (const m of markSync) updSync.run(m.lastMergedHash, m.sessionPath);
    for (const k of sentinelDrops) delSentinel.run(k);
    targetDb.exec("COMMIT");
  } catch (err) {
    try { targetDb.exec("ROLLBACK"); } catch { /* the rollback itself failed — surface the original error */ }
    throw err;
  }
  // (4) The post-verify — a fresh READ-ONLY handle on the target file, same run.
  const ro = new Database(targetPath, { readonly: true });
  try {
    const afterRows = ro.prepare("SELECT id, item, score, last_seen, embedding FROM long_term_rows ORDER BY id").all() as Array<{ id: number; item: string; score: number; last_seen: number; embedding: string }>;
    if (afterRows.length !== copy.rows.length) throw new Error(`migrate post-verify: row count ${afterRows.length} != the copy's ${copy.rows.length} — refusing`);
    for (let i = 0; i < copy.rows.length; i++) {
      const c = copy.rows[i]; const a = afterRows[i];
      if (a.id !== c.id || a.item !== c.item || a.score !== c.score || a.last_seen !== c.lastSeen) throw new Error(`migrate post-verify: exact-set equality failed at row ${i} (id ${a.id} vs the copy's ${c.id}) — refusing`);
      if (sha256Of(a.embedding) !== sha256Of(c.embedding)) throw new Error(`migrate post-verify: the embedding bytes differ for id ${c.id} — refusing`);
    }
    const blobAfter = blobSha256(ro, "the target");
    if (blobAfter !== blobBefore) throw new Error("migrate post-verify: the long_term blob changed — refusing (it must be byte-identical)");
    const stillUnmerged = ro.prepare(`SELECT session_path FROM session_summaries WHERE session_path = ? AND ${UNMERGED_PREDICATE}`);
    for (const m of markSync) {
      if (stillUnmerged.get(m.sessionPath)) throw new Error(`migrate post-verify: ${m.sessionPath} is still unmerged after the mark-sync UPDATE — refusing`);
    }
    const afterSentinels = readSentinels(ro);
    if (JSON.stringify([...afterSentinels.keys()].sort()) !== JSON.stringify([...copy.sentinels.keys()].sort())) throw new Error("migrate post-verify: the target's sentinel set != the copy's sentinel set — refusing");
    return { rowsBefore, rowsAfter: afterRows.length, markSync, sentinelDrops, blobSha256Before: blobBefore, blobSha256After: blobAfter };
  } finally {
    ro.close();
  }
}

// ─── The report + the env-gated legs ──────────────────────────────────────

interface FileSha { present: boolean; size: number | null; sha256: string | null; }

function fileInfo(p: string): FileSha {
  if (!existsSync(p)) return { present: false, size: null, sha256: null };
  return { present: true, size: statSync(p).size, sha256: sha256File(p) };
}

const fileLine = (f: FileSha): string => (f.present && f.sha256 ? `present size=${f.size} sha256=${f.sha256}` : "ABSENT");
const fileStatus = (a: FileSha, b: FileSha): string => (a.present === b.present && a.size === b.size && a.sha256 === b.sha256 ? "IDENTICAL" : "CHANGED");

export interface MigrateReportInput {
  mode: "DRY" | "LIVE";
  generated: string;
  prodPath: string;
  copyPath: string;
  copySha256: string;
  copyRows: number;
  rowsBefore: number;
  rowsAfter: number;
  markSync: string[]; // the applied session_paths (sorted)
  sentinelDrops: string[]; // the dropped keys (sorted)
  postVerifyLabel: string;
  backup: { path: string; sha256: string } | null;
  prodIntegrity: {
    rows: number;
    rowsUnchanged: boolean;
    blobUnchanged: boolean;
    markSyncStillUnmerged: boolean;
    sentinelSetUnchanged: boolean;
  } | null;
  fileBefore: { main: FileSha; wal: FileSha };
  fileAfter: { main: FileSha; wal: FileSha };
  sha256SidecarPath: string;
  jsonSidecarPath: string | null;
  reportPath: string;
  expectedProdRows: number;
}

/** The report — pure + byte-pinned (TRIANGULATE): the operator reads this
 *  before the LIVE gate (the DRY rehearsal) and after (the LIVE record). */
export function buildMigrateReport(a: MigrateReportInput): string {
  const out: string[] = [];
  out.push(`## ROWSTORE MIGRATE ${a.mode} REPORT`, "");
  out.push(`mode=${a.mode}`, `generated=${a.generated}`);
  out.push(`prod db: ${a.prodPath}`, `copy: ${a.copyPath} (sha256=${a.copySha256})`, "");
  out.push("### copy pin");
  out.push(`copy_sha256=${a.copySha256} (pin OK)`, `copy_rows=${a.copyRows}`, `copy_embeddings_ok=yes (all ${a.copyRows} non-null, length > 10)`, "");
  out.push("### mark-sync set (drained in the copy + content-stable)");
  out.push(`mark_sync=${a.markSync.length}`);
  if (a.markSync.length === 0) out.push("  (none)"); else for (const s of a.markSync) out.push(`  ${s}`);
  out.push("");
  out.push("### sentinel drops (prod-only merge_quarantine: keys)");
  out.push(`sentinel_drops=${a.sentinelDrops.length}`);
  if (a.sentinelDrops.length === 0) out.push("  (none)"); else for (const k of a.sentinelDrops) out.push(`  ${k}`);
  out.push("");
  out.push("### transaction");
  out.push(`rows_before=${a.rowsBefore} rows_after=${a.rowsAfter}`);
  if (a.backup) out.push(`backup=${a.backup.path} (sha256=${a.backup.sha256})`);
  out.push(`BEGIN IMMEDIATE: DELETE FROM long_term_rows → INSERT ${a.rowsAfter} rows → ${a.markSync.length} mark-sync UPDATEs → ${a.sentinelDrops.length} sentinel DELETEs → COMMIT`, "");
  out.push(`### post-verify (${a.postVerifyLabel})`);
  out.push(`exact_set_equality=yes (${a.rowsAfter} rows: id/item/score/last_seen + embedding sha256)`, "blob_byte_identical=yes", "mark_sync_drained=yes", "sentinel_set_equals_copy=yes", "");
  if (a.prodIntegrity) {
    out.push("### prod integrity (HARD assert — read through the WAL)");
    out.push(`prod_rows=${a.prodIntegrity.rows} (${a.prodIntegrity.rowsUnchanged ? "unchanged" : "CHANGED"})`, `blob_sha256=${a.prodIntegrity.blobUnchanged ? "unchanged" : "CHANGED"}`, `mark_sync_candidates_still_unmerged=${a.prodIntegrity.markSyncStillUnmerged ? "yes" : "no"}`, `sentinel_set=${a.prodIntegrity.sentinelSetUnchanged ? "unchanged" : "CHANGED"}`, "");
  }
  out.push("### prod file bytes (REPORTED, never asserted — the WAL reality)");
  out.push(`main before=${fileLine(a.fileBefore.main)}`, `main after=${fileLine(a.fileAfter.main)}`, `-wal before=${fileLine(a.fileBefore.wal)}`, `-wal after=${fileLine(a.fileAfter.wal)}`, `status: main=${fileStatus(a.fileBefore.main, a.fileAfter.main)} -wal=${fileStatus(a.fileBefore.wal, a.fileAfter.wal)}`, "");
  out.push(`sha256_sidecar=${a.sha256SidecarPath}`);
  if (a.jsonSidecarPath) out.push(`sidecar=${a.jsonSidecarPath}`);
  out.push(`report_file=${a.reportPath}`, "");
  out.push(a.mode === "DRY" ? "STOP — the operator reviews this rehearsal report; the LIVE leg is a separate, separately-approved gate (ROWSTORE_MIGRATE_LIVE=1)." : `one-shot: a re-run is refused (rows ≠ ${a.expectedProdRows} → "migration already applied"); the pre-migration backup is KEPT (C4's closeout owns its deletion).`);
  return out.join("\n");
}

// ─── The env-gated leg runners (real production paths) ─────────────────────

const realPin = (): MigratePin => ({
  copyPath: COPY_PATH,
  expectedCopySha256: COPY_SHA256_PIN,
  expectedCopyRows: COPY_ROWS_PIN,
  expectedProdRows: PROD_ROWS_PIN,
});

/** DRY — rehearses the FULL migration on a VACUUM INTO throwaway of
 *  production; production is opened strictly read-only (the house readonly
 *  open — the API form of file:...?mode=ro; this better-sqlite3 build does
 *  not enable SQLite's file: URI mode — verified at build time); the report
 *  directory is RETAINED. */
async function runDryLeg(): Promise<void> {
  const config = loadConfigOnce(REPO_ROOT);
  expect(config.useRowStore, "pre-flip tool — useRowStore must be false").toBe(false);
  const pin = realPin();
  if (!existsSync(SQLITE_PATH)) throw new Error(`migrate DRY: production DB missing — refusing: ${SQLITE_PATH}`);
  const tmp = mkdtempSync(join(tmpdir(), "rowstore-migrate-dry-"));
  const fileBefore = { main: fileInfo(SQLITE_PATH), wal: fileInfo(`${SQLITE_PATH}-wal`) };
  // (1) The pre-state — strictly read-only (structurally cannot write).
  const ro = new Database(SQLITE_PATH, { readonly: true });
  let preRows: number;
  let preBlob: string;
  let preCandidates: MarkSyncEntry[];
  let preSentinels: string[];
  try {
    preRows = assertProdRowCount(ro, pin);
    preBlob = blobSha256(ro, "production");
    preCandidates = computeMarkSyncSet(readProdSessions(ro), pinCopy(pin));
    preSentinels = [...readSentinels(ro).entries()].sort().map(e => `${e[0]}=${e[1]}`);
  } finally {
    ro.close();
  }
  // (2) The VACUUM INTO throwaway from a read-only handle (the C2/C3
  //     mechanism verbatim — a naive file copy can miss uncommitted WAL frames).
  const throwawayPath = join(tmp, "rehearsal.db");
  const roSnap = new Database(SQLITE_PATH, { readonly: true });
  try { roSnap.exec(`VACUUM INTO '${throwawayPath}'`); } finally { roSnap.close(); }
  // (3) The full pipeline against the TARGET (the copy pin, the guards,
  //     the ONE transaction, the read-only post-verify — the hermetic suite
  //     proves each).
  const db = new Database(throwawayPath);
  let outcome: MigrateOutcome;
  try { outcome = runMigration(db, throwawayPath, pin); } finally { db.close(); }
  // (4) HARD-assert the production rowstore state UNCHANGED (a fresh
  //     read-only handle — read through the WAL; the file BYTES are NOT
  //     asserted — they legitimately change).
  const ro2 = new Database(SQLITE_PATH, { readonly: true });
  let postRows: number;
  let postBlob: string;
  let candidatesStillUnmerged = true;
  let sentinelsUnchanged = true;
  try {
    postRows = (ro2.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
    postBlob = blobSha256(ro2, "production");
    const stillUnmerged = ro2.prepare(`SELECT session_path FROM session_summaries WHERE session_path = ? AND ${UNMERGED_PREDICATE}`);
    for (const c of preCandidates) {
      if (!stillUnmerged.get(c.sessionPath)) candidatesStillUnmerged = false;
    }
    sentinelsUnchanged = JSON.stringify([...readSentinels(ro2).entries()].sort().map(e => `${e[0]}=${e[1]}`)) === JSON.stringify(preSentinels);
    expect(postRows, "DRY: the production row count must be unchanged").toBe(pin.expectedProdRows);
    expect(postRows, "DRY: the production row count must equal the pre-state").toBe(preRows);
    expect(postBlob, "DRY: the long_term blob sha must be unchanged").toBe(preBlob);
    expect(candidatesStillUnmerged, "DRY: every mark-sync candidate must still be unmerged (production untouched)").toBe(true);
    expect(sentinelsUnchanged, "DRY: the sentinel set must be unchanged").toBe(true);
  } finally {
    ro2.close();
  }
  // (5) The after file snapshot — REPORTED, never asserted (CHANGED is a
  //     legitimate outcome; an old WAL byte-identity assert fired on the
  //     live session's own writes — the 2026-08-31 incident).
  const fileAfter = { main: fileInfo(SQLITE_PATH), wal: fileInfo(`${SQLITE_PATH}-wal`) };
  // (6) The production.sha256 sidecar (the house convention: the 4-line
  //     main/wal before/after form) + the report. The directory is RETAINED
  //     (the operator's review input before the LIVE gate).
  const sha256SidecarPath = join(tmp, "production.sha256");
  const walOrAbsent = (h: FileSha): string => (h.present && h.sha256 ? h.sha256 : "ABSENT");
  writeFileSync(sha256SidecarPath, [`main before=${walOrAbsent(fileBefore.main)}`, `wal before=${walOrAbsent(fileBefore.wal)}`, `main after=${walOrAbsent(fileAfter.main)}`, `wal after=${walOrAbsent(fileAfter.wal)}`].join("\n") + "\n");
  const reportPath = join(tmp, "rowstore-migrate-dry-report.md");
  const report = buildMigrateReport({
    mode: "DRY",
    generated: new Date().toISOString(),
    prodPath: SQLITE_PATH,
    copyPath: pin.copyPath,
    copySha256: pin.expectedCopySha256,
    copyRows: pin.expectedCopyRows,
    rowsBefore: outcome.rowsBefore,
    rowsAfter: outcome.rowsAfter,
    markSync: outcome.markSync.map(m => m.sessionPath),
    sentinelDrops: outcome.sentinelDrops,
    postVerifyLabel: "rehearsal target, read-only",
    backup: null,
    prodIntegrity: { rows: postRows, rowsUnchanged: postRows === preRows, blobUnchanged: postBlob === preBlob, markSyncStillUnmerged: candidatesStillUnmerged, sentinelSetUnchanged: sentinelsUnchanged },
    fileBefore,
    fileAfter,
    sha256SidecarPath,
    jsonSidecarPath: null,
    reportPath,
    expectedProdRows: pin.expectedProdRows,
  });
  writeFileSync(reportPath, report);
  console.log("\n" + report);
}

/** LIVE — the ONE production mutation of 16.1: the one-shot guard (before
 *  any backup) → the copy pin → the pre-migration VACUUM INTO backup (repo
 *  path, auto-gitignored, from a read-only handle, BEFORE the transaction)
 *  → run-time capture → the ONE BEGIN IMMEDIATE transaction → the read-only
 *  post-verify → the sidecar JSON + the report (the tmp dir is RETAINED). */
async function runLiveLeg(): Promise<void> {
  const config = loadConfigOnce(REPO_ROOT);
  expect(config.useRowStore, "pre-flip tool — useRowStore must be false").toBe(false);
  const pin = realPin();
  if (!existsSync(SQLITE_PATH)) throw new Error(`migrate LIVE: production DB missing — refusing: ${SQLITE_PATH}`);
  const tmp = mkdtempSync(join(tmpdir(), "rowstore-migrate-live-"));
  const fileBefore = { main: fileInfo(SQLITE_PATH), wal: fileInfo(`${SQLITE_PATH}-wal`) };
  // (1) The one-shot guard — BEFORE any backup/write.
  const ro = new Database(SQLITE_PATH, { readonly: true });
  try { assertProdRowCount(ro, pin); } finally { ro.close(); }
  // (2) The copy integrity pin.
  pinCopy(pin);
  // (3) The pre-migration backup — VACUUM INTO from a READ-ONLY handle → the
  //     repo path (auto-gitignored by the *.db rule) — BEFORE the
  //     transaction. Same-day re-run after a FAILED earlier LIVE (the
  //     guard proved no successful migration): the existing backup must be
  //     the pre-migration bytes or the leg refuses.
  const backupPath = join(CHANGE_DIR, `${BACKUP_PREFIX}${new Date().toISOString().slice(0, 10)}.db`);
  if (existsSync(backupPath)) {
    expect(sha256File(backupPath), "an existing same-day backup must be the pre-migration bytes (a failed earlier LIVE left it)").toBe(sha256File(SQLITE_PATH));
  } else {
    const roSnap = new Database(SQLITE_PATH, { readonly: true });
    try { roSnap.exec(`VACUUM INTO '${backupPath}'`); } finally { roSnap.close(); }
  }
  // (4) The full pipeline on PRODUCTION: the run-time capture (guards) →
  //     the ONE BEGIN IMMEDIATE transaction → the read-only post-verify.
  const rw = new Database(SQLITE_PATH);
  rw.pragma("busy_timeout = 5000");
  let outcome: MigrateOutcome;
  try { outcome = runMigration(rw, SQLITE_PATH, pin); } finally { rw.close(); }
  // (5) The after file snapshot — REPORTED, never asserted (CHANGED
  //     expected — the commit rewrites the main file and the WAL).
  const fileAfter = { main: fileInfo(SQLITE_PATH), wal: fileInfo(`${SQLITE_PATH}-wal`) };
  // (6) The sidecar JSON (the record) + the production.sha256 + the report.
  //     The directory is RETAINED (the record; C4's closeout owns cleanup).
  const MIGRATE_SQL = [
    "BEGIN IMMEDIATE",
    "DELETE FROM long_term_rows",
    "INSERT INTO long_term_rows (id, item, score, last_seen, embedding) VALUES (?, ?, ?, ?, ?)  -- the copy's rows (ids preserved)",
    "UPDATE session_summaries SET unmerged_fresh_content = NULL, last_merged_hash = ? WHERE session_path = ?  -- per mark-sync session (the copy's last_merged_hash)",
    "DELETE FROM meta WHERE key = ?  -- per prod-only merge_quarantine: sentinel",
    "COMMIT",
  ];
  const sidecarPath = join(tmp, "rowstore-migrate-live-sidecar.json");
  writeFileSync(sidecarPath, JSON.stringify({
    generated: new Date().toISOString(),
    prod: {
      path: SQLITE_PATH,
      rowsBefore: outcome.rowsBefore,
      rowsAfter: outcome.rowsAfter,
      blobSha256Before: outcome.blobSha256Before,
      blobSha256After: outcome.blobSha256After,
      backupPath,
      backupSha256: sha256File(backupPath),
      fileBytes: {
        main: { before: fileBefore.main, after: fileAfter.main },
        wal: { before: fileBefore.wal, after: fileAfter.wal },
      },
    },
    copy: { path: pin.copyPath, sha256: pin.expectedCopySha256, rows: pin.expectedCopyRows },
    markSync: outcome.markSync,
    sentinelDrops: outcome.sentinelDrops,
    postVerify: { exactSetEquality: true, blobByteIdentical: true, markSyncDrained: true, sentinelSetEqualsCopy: true },
    sql: MIGRATE_SQL,
  }, null, 2) + "\n");
  const sha256SidecarPath = join(tmp, "production.sha256");
  const walOrAbsent = (h: FileSha): string => (h.present && h.sha256 ? h.sha256 : "ABSENT");
  writeFileSync(sha256SidecarPath, [`main before=${walOrAbsent(fileBefore.main)}`, `wal before=${walOrAbsent(fileBefore.wal)}`, `main after=${walOrAbsent(fileAfter.main)}`, `wal after=${walOrAbsent(fileAfter.wal)}`].join("\n") + "\n");
  const reportPath = join(tmp, "rowstore-migrate-live-report.md");
  const report = buildMigrateReport({
    mode: "LIVE",
    generated: new Date().toISOString(),
    prodPath: SQLITE_PATH,
    copyPath: pin.copyPath,
    copySha256: pin.expectedCopySha256,
    copyRows: pin.expectedCopyRows,
    rowsBefore: outcome.rowsBefore,
    rowsAfter: outcome.rowsAfter,
    markSync: outcome.markSync.map(m => m.sessionPath),
    sentinelDrops: outcome.sentinelDrops,
    postVerifyLabel: "production, read-only",
    backup: { path: backupPath, sha256: sha256File(backupPath) ?? "" },
    prodIntegrity: null,
    fileBefore,
    fileAfter,
    sha256SidecarPath,
    jsonSidecarPath: sidecarPath,
    reportPath,
    expectedProdRows: pin.expectedProdRows,
  });
  writeFileSync(reportPath, report);
  console.log("\n" + report);
}

// ─── Hermetic fixture (os.tmpdir prod/copy DB pairs) ───────────────────────

/** A deterministic 12-dim vector (the pin only requires length > 10; the
 *  real rows are 768-dim). Different seeds → different vectors. */
const vec = (seed: number): number[] => Array.from({ length: 12 }, (_, i) => Number(((seed * 31 + i * 7) % 97) / 100));

interface FixtureRow { id: number; item: string; score: number; lastSeen: number; embedding: number[]; }
interface FixtureSession { sessionPath: string; lastFreshHash: string | null; lastMergedHash: string | null; unmergedFreshContent: string | null; }

// The prod stand-in: 3 rows (the fixture's "146").
const PROD_ROWS: FixtureRow[] = [
  { id: 1, item: "PROD-ROW-1", score: 2, lastSeen: 1083, embedding: vec(1) },
  { id: 2, item: "PROD-ROW-2", score: 1, lastSeen: 1083, embedding: vec(2) },
  { id: 3, item: "PROD-ROW-3", score: 5, lastSeen: 1083, embedding: vec(3) },
];
// The copy stand-in: 5 rows (the fixture's "382"); the ids are the copy's own
// (preserved through the full replace).
const COPY_ROWS: FixtureRow[] = [
  { id: 10, item: "COPY-ROW-10", score: 3, lastSeen: 1084, embedding: vec(10) },
  { id: 11, item: "COPY-ROW-11", score: 1, lastSeen: 1084, embedding: vec(11) },
  { id: 12, item: "COPY-ROW-12", score: 4, lastSeen: 1084, embedding: vec(12) },
  { id: 13, item: "COPY-ROW-13", score: 1, lastSeen: 1084, embedding: vec(13) },
  { id: 14, item: "COPY-ROW-14", score: 9, lastSeen: 1084, embedding: vec(14) },
];

// The mark-sync control matrix (the 2026-09-01 design's filter, one session
// per leg of the filter):
const PROD_SESSIONS: FixtureSession[] = [
  { sessionPath: "drained-stable.jsonl",   lastFreshHash: "H1",     lastMergedHash: null, unmergedFreshContent: "pending-A" },  // → MARKED (drained in the copy + the hash stable)
  { sessionPath: "drained-unstable.jsonl", lastFreshHash: "H2-NEW", lastMergedHash: null, unmergedFreshContent: "pending-B" },  // stays (newer content than the copy's drain)
  { sessionPath: "drained-absent.jsonl",   lastFreshHash: "H3",     lastMergedHash: null, unmergedFreshContent: "pending-C" },  // stays (no copy row for this session)
  { sessionPath: "already-merged.jsonl",   lastFreshHash: "H4",     lastMergedHash: "M4", unmergedFreshContent: null },         // stays (not unmerged in prod)
  { sessionPath: "not-drained.jsonl",      lastFreshHash: "H5",     lastMergedHash: null, unmergedFreshContent: "pending-D" },  // stays (the copy still carries it unmerged)
];
const COPY_SESSIONS: FixtureSession[] = [
  { sessionPath: "drained-stable.jsonl",   lastFreshHash: "H1",     lastMergedHash: "M1", unmergedFreshContent: null },
  { sessionPath: "drained-unstable.jsonl", lastFreshHash: "H2-OLD", lastMergedHash: "M2", unmergedFreshContent: null },
  { sessionPath: "not-drained.jsonl",      lastFreshHash: "H5",     lastMergedHash: null, unmergedFreshContent: "still-queued" },
  { sessionPath: "copy-only.jsonl",        lastFreshHash: "H6",     lastMergedHash: "M6", unmergedFreshContent: null },  // absent from prod — never touched
];

// The sentinel control matrix: prod carries one prod-only merge_quarantine:
// key (the fixture's "c29a…"), one shared key (same value in both), and one
// non-sentinel meta key (never touched).
const PROD_META: Array<[string, string]> = [
  ["merge_quarantine:prod-only.jsonl", '{"headPath":"prod-only.jsonl","failures":3}'],
  ["merge_quarantine:shared.jsonl", '{"headPath":"shared.jsonl","failures":2}'],
  ["lt_meta_counter", "1084"],
];
const COPY_META: Array<[string, string]> = [
  ["merge_quarantine:shared.jsonl", '{"headPath":"shared.jsonl","failures":2}'],
];

const PROD_BLOB = "PROD-BLOB — the legacy long_term summary (never touched by the migration)";
const COPY_BLOB = "COPY-BLOB (never read by the migration)";

/** Seed a DB file with the minimal real-shaped schema (the spec's four
 *  tables; long_term_rows carries the real DDL column definitions). */
function seedDb(path: string, rows: FixtureRow[], sessions: FixtureSession[], meta: Array<[string, string]>, blob: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE long_term_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 1,
      last_seen INTEGER NOT NULL,
      embedding TEXT NOT NULL
    );
    CREATE TABLE session_summaries (
      session_path TEXT PRIMARY KEY,
      last_fresh_hash TEXT,
      last_merged_hash TEXT,
      unmerged_fresh_content TEXT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE long_term (id INTEGER PRIMARY KEY, summary TEXT)
  `);
  const insR = db.prepare("INSERT INTO long_term_rows (id, item, score, last_seen, embedding) VALUES (?, ?, ?, ?, ?)");
  for (const r of rows) insR.run(r.id, r.item, r.score, r.lastSeen, JSON.stringify(r.embedding));
  const insS = db.prepare("INSERT INTO session_summaries (session_path, last_fresh_hash, last_merged_hash, unmerged_fresh_content) VALUES (?, ?, ?, ?)");
  for (const s of sessions) insS.run(s.sessionPath, s.lastFreshHash, s.lastMergedHash, s.unmergedFreshContent);
  const insM = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  for (const [k, v] of meta) insM.run(k, v);
  db.prepare("INSERT INTO long_term (id, summary) VALUES (1, ?)").run(blob);
  db.close();
}

/** Build the hermetic prod/copy pair in a tmp dir + the pin computed from
 *  the pair's own bytes (the real legs use the 2edc…/382/146 pins). */
function seedPair(tmp: string): { prodPath: string; copyPath: string; pin: MigratePin } {
  const prodPath = join(tmp, "prod.db");
  const copyPath = join(tmp, "copy.db");
  seedDb(prodPath, PROD_ROWS, PROD_SESSIONS, PROD_META, PROD_BLOB);
  seedDb(copyPath, COPY_ROWS, COPY_SESSIONS, COPY_META, COPY_BLOB);
  const pin: MigratePin = {
    copyPath,
    expectedCopySha256: sha256File(copyPath)!,
    expectedCopyRows: COPY_ROWS.length,
    expectedProdRows: PROD_ROWS.length,
  };
  return { prodPath, copyPath, pin };
}

/** The full four-table snapshot (the "pristine" comparator for the
 *  fail-closed tests). */
function snapshotTables(db: BetterSqliteDb): { rows: string[]; sessions: string[]; meta: string[]; blob: string } {
  const rows = db.prepare("SELECT id, item, score, last_seen, embedding FROM long_term_rows ORDER BY id").all() as Array<{ id: number; item: string; score: number; last_seen: number; embedding: string }>;
  const sessions = db.prepare("SELECT session_path, last_fresh_hash, last_merged_hash, unmerged_fresh_content FROM session_summaries ORDER BY session_path").all() as Array<{ session_path: string; last_fresh_hash: string | null; last_merged_hash: string | null; unmerged_fresh_content: string | null }>;
  const meta = db.prepare("SELECT key, value FROM meta ORDER BY key").all() as Array<{ key: string; value: string }>;
  const blobRow = db.prepare("SELECT summary FROM long_term WHERE id = 1").get() as { summary: string } | undefined;
  return {
    rows: rows.map(r => `${r.id}|${r.item}|${r.score}|${r.last_seen}|${sha256Of(r.embedding)}`),
    sessions: sessions.map(s => `${s.session_path}|${s.last_fresh_hash ?? "∅"}|${s.last_merged_hash ?? "∅"}|${s.unmerged_fresh_content ?? "∅"}`),
    meta: meta.map(m => `${m.key}=${m.value}`),
    blob: blobRow ? sha256Of(blobRow.summary) : "ABSENT",
  };
}

// ─── Hermetic unit suite (runs WITHOUT env — the spec's 7 contract tests) ──

describe("rowstore-migrate — hermetic unit suite (no env; prod/copy DB pairs in os.tmpdir())", () => {
  it("(1) full replace: the copy's ids + every column replace the target's rows exactly", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rowstore-migrate-u1-"));
    try {
      const { prodPath, pin } = seedPair(tmp);
      const db = new Database(prodPath);
      try {
        runMigration(db, prodPath, pin);
        const after = db.prepare("SELECT id, item, score, last_seen, embedding FROM long_term_rows ORDER BY id").all() as Array<{ id: number; item: string; score: number; last_seen: number; embedding: string }>;
        expect(after.length, "the target must carry exactly the copy's rows").toBe(COPY_ROWS.length);
        COPY_ROWS.forEach((c, i) => {
          expect(after[i].id, `row ${i}: the copy's id must be preserved`).toBe(c.id);
          expect(after[i].item).toBe(c.item);
          expect(after[i].score).toBe(c.score);
          expect(after[i].last_seen).toBe(c.lastSeen);
          expect(after[i].embedding, `row ${c.id}: the embedding must be the copy's stored bytes`).toBe(JSON.stringify(c.embedding));
        });
        for (const p of PROD_ROWS) expect(after.some(a => a.id === p.id), `old prod row ${p.id} must be gone (full replace)`).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("(2) mark-sync: a drained-AND-stable session gets unmerged_fresh_content=NULL + the copy's last_merged_hash", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rowstore-migrate-u2-"));
    try {
      const { prodPath, pin } = seedPair(tmp);
      const db = new Database(prodPath);
      try {
        runMigration(db, prodPath, pin);
        const s = db.prepare("SELECT unmerged_fresh_content AS u, last_merged_hash AS m FROM session_summaries WHERE session_path = ?").get("drained-stable.jsonl") as { u: string | null; m: string | null };
        expect(s.u, "the marked session must be drained (unmerged_fresh_content NULL)").toBeNull();
        expect(s.m, "the marked session must carry the copy's last_merged_hash").toBe("M1");
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("(3) sentinel drop: exactly the prod-only merge_quarantine: keys are removed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rowstore-migrate-u3-"));
    try {
      const { prodPath, pin } = seedPair(tmp);
      const db = new Database(prodPath);
      try {
        runMigration(db, prodPath, pin);
        const keys = (db.prepare("SELECT key FROM meta WHERE key LIKE 'merge_quarantine:%' ORDER BY key").all() as Array<{ key: string }>).map(k => k.key);
        expect(keys, "exactly the prod-only sentinel is dropped; the shared one stays").toEqual(["merge_quarantine:shared.jsonl"]);
        expect((db.prepare("SELECT value FROM meta WHERE key = 'merge_quarantine:shared.jsonl'").get() as { value: string }).value).toBe('{"headPath":"shared.jsonl","failures":2}');
        expect((db.prepare("SELECT value FROM meta WHERE key = 'lt_meta_counter'").get() as { value: string }).value, "non-sentinel meta keys are never touched").toBe("1084");
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("(4) fail-closed on prod row-count drift (the fixture's 147): refuses with no partial writes — every table pristine", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rowstore-migrate-u4-"));
    try {
      const { prodPath, pin } = seedPair(tmp);
      const db = new Database(prodPath);
      try {
        db.prepare("INSERT INTO long_term_rows (id, item, score, last_seen, embedding) VALUES (?, 'DRIFT-ROW', 1, 1083, ?)").run(4, JSON.stringify(vec(4))); // 3 → 4 rows
        const before = snapshotTables(db);
        expect(() => runMigration(db, prodPath, pin)).toThrow(/row count drift/);
        expect(snapshotTables(db), "no partial writes — all four tables byte-pristine after the refusal").toEqual(before);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("(5) fail-closed on copy sha mismatch (1 byte appended to a temp copy): refuses before any write", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rowstore-migrate-u5-"));
    try {
      const { prodPath, copyPath, pin } = seedPair(tmp);
      appendFileSync(copyPath, "x"); // corrupt the copy's main file by 1 byte
      const db = new Database(prodPath);
      try {
        const before = snapshotTables(db);
        expect(() => runMigration(db, prodPath, pin)).toThrow(/copy sha mismatch/);
        expect(snapshotTables(db), "no writes — all four tables pristine after the refusal").toEqual(before);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("(6) the long_term blob is byte-identical across a successful migration", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rowstore-migrate-u6-"));
    try {
      const { prodPath, pin } = seedPair(tmp);
      const db = new Database(prodPath);
      try {
        const before = (db.prepare("SELECT summary FROM long_term WHERE id = 1").get() as { summary: string }).summary;
        runMigration(db, prodPath, pin);
        const after = (db.prepare("SELECT summary FROM long_term WHERE id = 1").get() as { summary: string }).summary;
        expect(after, "the blob text must be byte-identical").toBe(before);
        expect(sha256Of(after)).toBe(sha256Of(before));
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("(7) one-shot guard: a second run against the already-migrated store refuses (rows = the copy's count — the fixture's 382)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rowstore-migrate-u7-"));
    try {
      const { prodPath, pin } = seedPair(tmp);
      const db = new Database(prodPath);
      try {
        runMigration(db, prodPath, pin); // the first run: 3 → 5 rows (the copy's count)
        expect(() => runMigration(db, prodPath, pin)).toThrow(/already applied/);
        expect((db.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c, "the store is untouched by the refused re-run").toBe(COPY_ROWS.length);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
// ─── The env-gated legs (opt-in; never run in a plain `npm test`) ─────────

describe.runIf(process.env.ROWSTORE_MIGRATE_DRY === "1")("rowstore-migrate — DRY leg (env-gated: ROWSTORE_MIGRATE_DRY=1)", () => {
  it("rehearses the full migration on a VACUUM INTO throwaway; production state stays unchanged; the report dir is RETAINED", async () => {
    const preDirs = new Set(readdirSync(tmpdir()).filter(n => n.startsWith("rowstore-migrate-")));
    await runDryLeg();
    const postDirs = readdirSync(tmpdir()).filter(n => n.startsWith("rowstore-migrate-"));
    const kept = postDirs.filter(n => !preDirs.has(n));
    expect(kept, "the DRY leg must leave exactly one retained report dir").toHaveLength(1);
    const dir = join(tmpdir(), kept[0]);
    expect(existsSync(join(dir, "rowstore-migrate-dry-report.md")), "the DRY report must be written (RETAINED)").toBe(true);
    expect(existsSync(join(dir, "production.sha256")), "the production.sha256 sidecar must be written (RETAINED)").toBe(true);
    expect(readdirSync(dir).filter(n => n === "rehearsal.db").length, "the VACUUM INTO throwaway stays inside the tmp dir (the operator may inspect it)").toBe(1);
  }, 120_000);
});

describe.runIf(process.env.ROWSTORE_MIGRATE_LIVE === "1")("rowstore-migrate — LIVE leg (env-gated: ROWSTORE_MIGRATE_LIVE=1)", () => {
  it("applies the one-shot migration to production: rows → the copy's 382, the fold-state synced, the backup + the report RETAINED", async () => {
    const preDirs = new Set(readdirSync(tmpdir()).filter(n => n.startsWith("rowstore-migrate-")));
    const preRows = prodRowCountForLeg();
    const preBlobSha = prodBlobShaForLeg();
    expect(preRows, "production must be pre-migration before the LIVE leg").toBe(PROD_ROWS_PIN);
    expect(preBlobSha, "the blob sha must be captured pre-migration (byte-identity assert)").toBeTruthy();
    await runLiveLeg();
    expect(prodRowCountForLeg(), "production must carry the copy's rows after the LIVE leg").toBe(COPY_ROWS_PIN);
    const postDirs = readdirSync(tmpdir()).filter(n => n.startsWith("rowstore-migrate-"));
    const kept = postDirs.filter(n => !preDirs.has(n));
    expect(kept, "the LIVE leg must leave exactly one retained record dir").toHaveLength(1);
    const dir = join(tmpdir(), kept[0]);
    expect(existsSync(join(dir, "rowstore-migrate-live-report.md")), "the LIVE report must be written (RETAINED)").toBe(true);
    expect(existsSync(join(dir, "rowstore-migrate-live-sidecar.json")), "the sidecar JSON must be written (RETAINED)").toBe(true);
    expect(existsSync(join(dir, "production.sha256")), "the production.sha256 sidecar must be written (RETAINED)").toBe(true);
    const backup = readdirSync(CHANGE_DIR).filter(n => n.startsWith(BACKUP_PREFIX) && n.endsWith(".db"));
    expect(backup.length, "the pre-migration backup must exist in the repo (auto-gitignored; C4's closeout owns its deletion)").toBe(1);
    expect(sha256File(join(CHANGE_DIR, backup[0])), "the backup must be a complete DB file").toBeTruthy();
    // the blob is byte-identical (read through the WAL — the rowstore state,
    // not the file bytes)
    expect(prodBlobShaForLeg(), "the long_term blob must be byte-identical after the migration").toBe(preBlobSha);
  }, 120_000);
});

/** Small read-only observers for the LEG tests (the core owns the
 *  invariants; these only observe). */

function prodRowCountForLeg(): number {
  const ro = new Database(SQLITE_PATH, { readonly: true });
  try { return (ro.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c; } finally { ro.close(); }
}

function prodBlobShaForLeg(): string | null {
  const ro = new Database(SQLITE_PATH, { readonly: true });
  try {
    const row = ro.prepare("SELECT summary FROM long_term WHERE id = 1").get() as { summary: string } | undefined;
    return row ? sha256Of(row.summary) : null;
  } finally { ro.close(); }
}
