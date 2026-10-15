// rowstore-live.test.ts — rowstore-storage C2 live vehicle (design §6, §10.2).
//
// The ONLY code path that runs the one-time C2 backfill (the long_term blob →
// long_term_rows). No runtime hook can reach it: while useRowStore is false,
// rowstore.ts is imported only by test files (inertness, design §7).
//
// Commands (byte-pinned — AGENTS.md's "Row-store backfill vehicle
// (rowstore-storage C2)" section is the source of truth; the two must match
// byte-for-byte, verified at the doc gate):
//
// ROWSTORE_LIVE_DRY=1 npx vitest run rowstore-live
// ROWSTORE_LIVE=1 npx vitest run rowstore-live
// ROWSTORE_LIVE=1 ROWSTORE_BACKFILL_MODE=destructive npx vitest run rowstore-live
//
// Env vars:
// ROWSTORE_LIVE_DRY=1 → full pipeline on a throwaway VACUUM INTO copy of the
//   production DB; asserts the production file is byte-untouched (sha256
//   main[ + -wal] before/after), prints the rehearsal report. DRY is always
//   insert mode.
// ROWSTORE_LIVE=1 → the real backfill into the production DB; auto-spawns the
//   5002 embed server when not READY (dated plan §2.6 amendment — user-approved
//   2026-08-30); 5001 never touched.
// ROWSTORE_BACKFILL_MODE (LIVE only) → insert (default, idempotent re-run:
//   existing rows skipped by exact text) | destructive (transactional
//   clear-and-rebuild — C2-era tool only; it destroys C3 rows after C3's
//   first writes).
//
// Ordering: DRY → user reviews the rehearsal report → LIVE.
//
// Expected reports: "## ROWSTORE DRY REHEARSAL REPORT" / "## ROWSTORE LIVE
// BACKFILL REPORT" — parsed/inserted/store rows, exact dups dropped (+ which
// items), near-dup clusters (+ pair lines), per-chunk + total embed ms,
// production hash before === after, blob byte-identical, useRowStore false.
//
// Safety: DRY opens the production DB read-only (VACUUM INTO copy;
// structurally cannot write); LIVE is additive (long_term_rows only — the
// long_term blob is byte-untouched); the embed server is 5002-only, detached,
// the extension never kills it, 5001 never touched.
//
// Re-run semantics: insert idempotent (a re-run inserts only new rows);
// destructive atomic (single transaction, all-or-nothing) and DANGEROUS after
// C3's first writes (C2-era tool).
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as logger from "../logger.js";
import { backfillRowStoreFromTableText, BACKFILL_EMBED_CHUNK_SIZE, type BackfillMode } from "../rowstore.js";
import { cosineSimilarity, ensureEmbedServer, embedText } from "../embeddings.js";
import { openCacheDb, sqliteReadLongTerm, sqliteCountUnmergedSessions } from "../summarizer.js";
import { loadConfigOnce } from "../config.js";
import { SQLITE_PATH } from "../discoverer.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// Repo root (this file lives in test/) — loadConfigOnce's extensionDir (the user
// config lives at ~/.pi/agent/session-recall.yaml; the extensionDir only serves
// the config.example.yaml bootstrap fallback).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const sha256File = (p: string): string | null =>
  existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;

/** Production file snapshot — main + -wal if present; -shm excluded (transient
 *  reader bookkeeping, not durable state). */
const prodFileSnapshot = (): { main: string | null; wal: string | null } => ({
  main: sha256File(SQLITE_PATH),
  wal: sha256File(`${SQLITE_PATH}-wal`),
});

// C1 calibration pairs (session-recall-rowstore-plan.md §11 — nomic-embed-text
// via llama.cpp, the model + prefix conditions the backfill embeds under).
const CALIBRATION_PAIRS: Array<[string, string, string]> = [
  ["always run npm install before starting the dev server", "remember to install npm dependencies before you start the dev server", "true paraphrase"],
  ["reuse database connections across requests", "connection pooling implemented for the DB layer", "same idea, different wording"],
  ["connection pooling implemented for the DB layer", "how to configure rate limiting on an API gateway", "same domain, different concept"],
  ["reuse database connections across requests", "the cat sat on the mat", "unrelated, mundane"],
  ["how to configure rate limiting on an API gateway", "the weather in Tokyo is sunny today", "unrelated, different domain"],
];

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(logger, "log").mockImplementation((m: string) => {
    lines.push(m);
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe.runIf(process.env.ROWSTORE_LIVE_DRY === "1")("rowstore-live DRY rehearsal", () => {
  it("full pipeline on a VACUUM INTO copy; production byte-untouched", { timeout: 600_000 }, async () => {
    const { lines, restore } = captureLog();
    try {
      // (1) Pre-reads on a read-only production handle.
      const ro = new Database(SQLITE_PATH, { readonly: true });
      const longTerm = sqliteReadLongTerm(ro);
      expect(longTerm, "long_term id=1 must exist").toBeTruthy();
      const summary = longTerm!.summary;
      const sessionCount = longTerm!.sessionCount;
      const before = prodFileSnapshot();
      ro.close();
      const config = loadConfigOnce(REPO_ROOT);

      // (2) Embed server — C1 semantics unchanged (probe → detached spawn only
      //     on ECONNREFUSED → readiness poll; never throws).
      const status = await ensureEmbedServer(config);
      expect(status.status, `embed server not ready: ${status.reason ?? "no reason"}`).toBe("ready");

      // (3) WAL-consistent standalone snapshot (a naive file copy can miss
      //     uncommitted WAL frames); the read-only connection makes the
      //     no-write guarantee structural.
      const copyPath = join(mkdtempSync(join(tmpdir(), "rowstore-dry-")), "rehearsal.sqlite");
      const roSnap = new Database(SQLITE_PATH, { readonly: true });
      roSnap.exec(`VACUUM INTO '${copyPath}'`);
      roSnap.close();
      const copyDb = new Database(copyPath); // read-write — the rehearsal target

      // (4) The real pipeline, real embed calls — DRY is always insert mode.
      const report = await backfillRowStoreFromTableText(copyDb, { summary, sessionCount }, "insert", config);

      // (5) Asserts.
      expect(report.aborted, "DRY is a red rehearsal when the pipeline aborts").toBeNull();
      const after = prodFileSnapshot();
      expect(after, "production main[ + -wal] must be byte-untouched").toEqual(before);
      const copyLt = sqliteReadLongTerm(copyDb);
      expect(copyLt!.summary, "blob in the copy must be byte-identical to production").toBe(summary);
      const copyRows = (copyDb.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
      expect(copyRows, "fresh table: every unique source row stored").toBe(report.parsed - report.dupsDropped);
      expect(copyRows).toBe(report.storeRows);
      for (const r of copyDb.prepare("SELECT embedding FROM long_term_rows").all() as Array<{ embedding: string }>) {
        const v: unknown = JSON.parse(r.embedding);
        expect(Array.isArray(v) && v.length === 768 && v.every((x) => typeof x === "number" && Number.isFinite(x)),
          "every stored embedding must be 768 finite numbers").toBe(true);
      }
      // C1 calibration-pair spot-check (real embedText calls, kind "document" —
      // the search_document: prefix the backfill embeds under).
      const calTexts = [...new Set(CALIBRATION_PAIRS.flatMap(([a, b]) => [a, b]))];
      const calVecs = new Map<string, number[]>();
      for (const t of calTexts) {
        const v = await embedText(t, "document");
        expect(v, `calibration embed failed for "${t}"`).not.toBeNull();
        calVecs.set(t, v!);
      }
      const calSims = CALIBRATION_PAIRS.map(([a, b]) => cosineSimilarity(calVecs.get(a)!, calVecs.get(b)!));
      expect(calSims[0], "true-paraphrase pair must be ≥ 0.8").toBeGreaterThanOrEqual(0.8);
      expect(calSims[3], "unrelated pair must be < 0.5").toBeLessThan(0.5);
      expect(calSims[4], "unrelated pair must be < 0.5").toBeLessThan(0.5);
      // Log bytes: exactly one byte-equal summary line + one DUP line per
      // collapsed text + one NEAR line per reported pair.
      const expectedSummary = `LTROW BACKFILL n=${report.inserted} dups_dropped=${report.dupsDropped} near_dup_clusters=${report.nearDupClusters}`;
      expect(lines.filter((l) => l === expectedSummary), "exactly one byte-equal summary line").toHaveLength(1);
      const dupLines = lines.filter((l) => l.startsWith("LTROW BACKFILL DUP "));
      expect(dupLines.every((l) => /^LTROW BACKFILL DUP item=".*" kept_score=\d+ dropped=\d+$/.test(l))).toBe(true);
      const droppedSum = dupLines.reduce((s, l) => s + Number(/dropped=(\d+)$/.exec(l)![1]), 0);
      expect(droppedSum, "one DUP line per collapsed text; dropped counts sum to the report").toBe(report.dupsDropped);
      const nearLines = lines.filter((l) => l.startsWith("LTROW BACKFILL NEAR "));
      expect(nearLines.every((l) => /^LTROW BACKFILL NEAR a="(.*)" b="(.*)" sim=\d\.\d{4}$/.test(l))).toBe(true);
      const parsedNear = nearLines.map((l) => {
        const m = /^LTROW BACKFILL NEAR a="(.*)" b="(.*)" sim=(\d\.\d{4})$/.exec(l)!;
        return { a: m[1], b: m[2], sim: Number(m[3]) };
      });
      expect(parsedNear.every((p) => p.a < p.b), "NEAR lines carry a < b (JS string order)").toBe(true);
      const cmp = (p: { a: string; b: string; sim: number }, q: { a: string; b: string; sim: number }) =>
        q.sim - p.sim || (p.a < q.a ? -1 : p.a > q.a ? 1 : 0) || (p.b < q.b ? -1 : p.b > q.b ? 1 : 0);
      expect(parsedNear.every((p, i) => i === 0 || cmp(parsedNear[i - 1], p) <= 0),
        "NEAR lines ordered by sim DESC, then a ASC, then b ASC").toBe(true);
      expect(config.useRowStore, "C2 writes no config — useRowStore stays false").toBe(false);
      copyDb.close();

      // (6) Rehearsal report (P7 pinned shape).
      const uniqueCount = report.parsed - report.dupsDropped;
      const chunkSizes = Array.from({ length: report.embedCalls }, (_, k) =>
        Math.min(BACKFILL_EMBED_CHUNK_SIZE, uniqueCount - k * BACKFILL_EMBED_CHUNK_SIZE));
      console.log(
        [
          "## ROWSTORE DRY REHEARSAL REPORT",
          "- mode: insert (DRY is always insert)",
          `- copy: ${copyPath} (VACUUM INTO from read-only handle)`,
          `- parsed rows: ${report.parsed}   inserted: ${report.inserted}   store rows: ${report.storeRows}`,
          `- exact dups dropped: ${report.dupsDropped}   ${dupLines.length ? dupLines.join("; ") : "none"}`,
          `- near-dup clusters: ${report.nearDupClusters}   ${nearLines.length ? nearLines.join("; ") : "none"}`,
          `- embed: ${report.embedCalls} calls, chunks [${chunkSizes.join(", ")}], per-chunk ms [${report.chunkMs.join(", ")}], total ${report.embedMs} ms`,
          "- production file hash (main[ + -wal]) before === after: true",
          `- blob in copy byte-identical to production: true (${summary.length} chars)`,
          `- calibration pairs: ${CALIBRATION_PAIRS.map(([, , rel], i) => `${calSims[i].toFixed(4)} (${rel})`).join(" / ")}`,
          "- useRowStore: false (unchanged)",
          "- NEXT: review this report, then run ROWSTORE_LIVE=1 npx vitest run rowstore-live",
        ].join("\n"),
      );
    } finally {
      restore();
    }
  });
});
describe.runIf(process.env.ROWSTORE_LIVE === "1")("rowstore-live LIVE real run", () => {
  it("real backfill into the production DB; blob byte-untouched", { timeout: 600_000 }, async () => {
    const { lines, restore } = captureLog();
    try {
      // (1) Pre-reads on a read-only handle.
      const ro = new Database(SQLITE_PATH, { readonly: true });
      const ltBefore = sqliteReadLongTerm(ro);
      expect(ltBefore, "long_term id=1 must exist").toBeTruthy();
      // First run: long_term_rows does not exist yet — the self-ensure happens inside
      // the backfill (the first rowstore call against this DB); on re-runs the table exists.
      const rowsTableExists = (ro.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'long_term_rows'").get() as { name: string } | undefined) !== undefined;
      const preRows = rowsTableExists ? (ro.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c : 0;
      const preBacklog = sqliteCountUnmergedSessions(ro);
      ro.close();
      const config = loadConfigOnce(REPO_ROOT);
      expect(config.useRowStore, "C2 writes no config — useRowStore stays false").toBe(false);

      // (2) Embed server — auto-spawn when 5002 is not READY (dated plan §2.6
      //     amendment, user-approved 2026-08-28; C1 lifecycle semantics
      //     unchanged). The port always comes from config.embedServerPort —
      //     5001 never touched or spawned by any path.
      const status = await ensureEmbedServer(config);
      expect(status.status, `embed server not ready: ${status.reason ?? "no reason"}`).toBe("ready");

      // (3) Mode selection from ROWSTORE_BACKFILL_MODE (LIVE-only) — fail-soft:
      //     anything not exactly "destructive" runs insert (the non-destructive
      //     mode is the fallback); an unrecognized value logs a console note.
      const modeRaw = process.env.ROWSTORE_BACKFILL_MODE;
      const mode: BackfillMode = modeRaw === "destructive" ? "destructive" : "insert";
      if (modeRaw !== undefined && modeRaw !== "insert" && modeRaw !== "destructive") {
        console.log(`[rowstore-live] unrecognized ROWSTORE_BACKFILL_MODE="${modeRaw}" — falling back to insert (fail-soft)`);
      }

      // (4) The production read-write handle (house single-connection path —
      //     the LT_LIVE precedent at lt-conversion-live.test.ts:225).
      const db = await openCacheDb();
      expect(db, "openCacheDb must return the live DB handle").toBeTruthy();
      const report = await backfillRowStoreFromTableText(
        db!,
        { summary: ltBefore!.summary, sessionCount: ltBefore!.sessionCount },
        mode,
        config,
      );

      // (5) Post-asserts.
      expect(report.aborted, "LIVE aborted — see the LTROW BACKFILL ABORT line").toBeNull();
      const ltAfter = sqliteReadLongTerm(db!);
      const postRows = (db!.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
      expect(postRows, "store must equal the unique source rows (both modes)").toBe(report.parsed - report.dupsDropped);
      expect(ltAfter!.summary, "the long_term blob must be byte-identical (C2 is additive)").toBe(ltBefore!.summary);
      expect(config.useRowStore, "useRowStore still false after LIVE").toBe(false);
      expect(sqliteCountUnmergedSessions(db!), "unmerged backlog must be untouched by C2").toBe(preBacklog);
      // Exactly one byte-equal summary line (n per mode semantics) + DUP/NEAR lines.
      const n = mode === "insert" ? report.inserted : report.storeRows;
      const expectedSummary = `LTROW BACKFILL n=${n} dups_dropped=${report.dupsDropped} near_dup_clusters=${report.nearDupClusters}`;
      expect(lines.filter((l) => l === expectedSummary), "exactly one byte-equal summary line").toHaveLength(1);
      const dupLines = lines.filter((l) => l.startsWith("LTROW BACKFILL DUP "));
      expect(dupLines.every((l) => /^LTROW BACKFILL DUP item=".*" kept_score=\d+ dropped=\d+$/.test(l))).toBe(true);
      const nearLines = lines.filter((l) => l.startsWith("LTROW BACKFILL NEAR "));
      expect(nearLines.every((l) => /^LTROW BACKFILL NEAR a=".*" b=".*" sim=\d\.\d{4}$/.test(l))).toBe(true);

      // (6) LIVE report (P7 — same shape as the DRY rehearsal report, with the
      //     mode, the production blob hash before === after, and the row counts).
      const uniqueCount = report.parsed - report.dupsDropped;
      const chunkSizes = Array.from({ length: report.embedCalls }, (_, k) =>
        Math.min(BACKFILL_EMBED_CHUNK_SIZE, uniqueCount - k * BACKFILL_EMBED_CHUNK_SIZE));
      const blobHashBefore = createHash("sha256").update(ltBefore!.summary).digest("hex");
      const blobHashAfter = createHash("sha256").update(ltAfter!.summary).digest("hex");
      console.log(
        [
          "## ROWSTORE LIVE BACKFILL REPORT",
          `- mode: ${mode}`,
          `- parsed rows: ${report.parsed}   inserted: ${report.inserted}   store rows: ${report.storeRows}`,
          `- exact dups dropped: ${report.dupsDropped}   ${dupLines.length ? dupLines.join("; ") : "none"}`,
          `- near-dup clusters: ${report.nearDupClusters}   ${nearLines.length ? nearLines.join("; ") : "none"}`,
          `- embed: ${report.embedCalls} calls, chunks [${chunkSizes.join(", ")}], per-chunk ms [${report.chunkMs.join(", ")}], total ${report.embedMs} ms`,
          `- production blob sha256 before === after: ${blobHashBefore === blobHashAfter} (${ltBefore!.summary.length} chars)`,
          `- pre-run store rows: ${preRows}   unmerged backlog before === after: ${preBacklog} (untouched)`,
          "- useRowStore: false (unchanged)",
          "- NEXT: review the near-dup pairs above (plan §7 first look at real near-duplicates); insert re-run is idempotent, destructive is a C2-era tool",
        ].join("\n"),
      );
    } finally {
      restore();
    }
  });
});
