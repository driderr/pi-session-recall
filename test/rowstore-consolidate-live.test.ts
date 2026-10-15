// rowstore-consolidate-live.test.ts — manual, rare, user-adjudicated near-dup
// consolidation of the production long_term_rows (pre-C4-flip tooling).
//
// WHY THIS EXISTS: the 165 C2 backfill seed rows were bulk-imported from the
// legacy 19,776-char KB and never passed through C3's per-signal dedup. A
// read-only all-pairs scan (2026-08-29, artifact:
// openspec/changes/rowstore-merge/near-dup-analysis-2026-08-29.txt) found 18
// clusters at >=0.85 — ~11 true duplicates, ~6 same-topic-complementary, 1
// false positive (version-specific facts). The 0.85 threshold cuts real-text
// families mid-cluster, so consolidation is REPORT-AND-ADJUDICATE, never
// mechanical: a human (the user) fills the plan file's mergedText per cluster.
//
// THREE MODES (env-gated; exactly one expected per invocation):
//
//   ROWSTORE_CONSOLIDATE_PLAN=1 npx vitest run rowstore-consolidate-live
//     Read-only scan of production; prints clusters + the borderline
//     0.75–0.85 next-pass queue; writes a FILL-IN plan template to
//     test/rowstore-consolidate-plan.json (refuses to overwrite an existing
//     plan — delete it manually to re-scan).
//
//   ROWSTORE_CONSOLIDATE_DRY=1 npx vitest run rowstore-consolidate-live
//     Applies the plan to a VACUUM INTO throwaway copy; prints the report;
//     asserts production rowstore state is untouched.
//
//   ROWSTORE_CONSOLIDATE_LIVE=1 npx vitest run rowstore-consolidate-live
//     Applies the plan to PRODUCTION in one transaction. Pre-computes every
//     re-embedding BEFORE the transaction (no network inside it); aborts
//     before any write if a plan op references a missing row (post-LIVE
//     re-runs fail loudly, never silently skip).
//
// Plan file (the permanent record of the user's per-cluster decisions; kept
// on disk for reference, not committed): each op carries the source row
// texts, keep/delete row ids, the adjudicated mergedText, and
// score = MAX of member scores (summing inflates — the 19+17 pair showed
// why) + lastSeen = max of member last_seen. action: "merge" (apply) or
// "keep" (adjudicated NOT a duplicate — e.g. version-specific facts that the
// threshold mis-scored). An op with action=null refuses to run: every
// cluster must be explicitly decided.
//
// Merge semantics: complementary merge — mergedText must carry the union of
// member infos; "identical" (mergedText = survivor's current text) deletes
// the losers with no re-embed. Survivors keep their row id (max score, tie
// -> lowest id). Merged text is re-embedded as a document via the 5002 embed
// server (ensureEmbedServer: probe -> detached spawn; C1/C2/C3 precedent;
// the extension never kills the server; 5001 never touched).
//
// Safety: the long_term blob is NEVER touched (asserted byte-identical in
// all modes); session_summaries and merge_quarantine sentinels are never
// touched (asserted); useRowStore must be false (pre-flip tool — post-flip,
// the runtime owns row writes and this vehicle's discipline does not apply).
// DRY never opens production read-write. LIVE writes ONLY long_term_rows.
//
// Re-run semantics: PLAN re-scans CURRENT store state (future runs = re-scan,
// fill, dry, live). DRY is idempotent (fresh copy each invocation). LIVE is
// one-shot per plan: a second LIVE aborts on the missing-row guard.

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigOnce } from "../config.js";
import { SQLITE_PATH } from "../discoverer.js";
import { ensureEmbedServer, embedText, cosineSimilarity } from "../embeddings.js";
import { sqliteReadLongTerm } from "../summarizer.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_PATH = join(dirname(fileURLToPath(import.meta.url)), "rowstore-consolidate-plan.json");

// ─── Plan schema (the user's adjudication record) ───────────────────────────

interface PlanOp {
  id: string;
  action: "merge" | "keep" | null;
  members: number[];
  keep: number;
  delete: number[];
  score: number;
  lastSeen: number;
  mergedText: string | null;
  texts: Record<string, string>;
  sims: string[];
}
interface Plan {
  note: string;
  generated: string;
  threshold: number;
  ops: PlanOp[];
  nextPassQueue: string[];
}

// ─── Shared read helpers ────────────────────────────────────────────────────

interface RowRec {
  id: number;
  item: string;
  score: number;
  lastSeen: number;
  embedding: number[];
}

const loadRows = (db: any): RowRec[] =>
  (db.prepare("SELECT id, item, score, last_seen, embedding FROM long_term_rows ORDER BY id").all() as Array<{
    id: number; item: string; score: number; last_seen: number; embedding: string;
  }>).map(r => ({ id: r.id, item: r.item, score: r.score, lastSeen: r.last_seen, embedding: JSON.parse(r.embedding) }));

/** Union-find clustering of all pairs >= threshold; returns clusters (member
 *  id lists) and the pair list (for the borderline next-pass queue). */
const clusterize = (rows: RowRec[], threshold: number): { clusters: number[][]; pairs: Array<[number, number, number]> } => {
  const pairs: Array<[number, number, number]> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const s = cosineSimilarity(rows[i].embedding, rows[j].embedding);
      if (s >= threshold) pairs.push([rows[i].id, rows[j].id, s]);
    }
  }
  const parent = new Map<number, number>(rows.map(r => [r.id, r.id]));
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    while (parent.get(x)! !== root) { const next = parent.get(x)!; parent.set(x, root); x = next; }
    return root;
  };
  for (const [a, b] of pairs) parent.set(find(a), find(b));
  const byRoot = new Map<number, number[]>();
  for (const [a, b] of pairs) {
    const root = find(a);
    if (!byRoot.has(root)) byRoot.set(root, []);
    const list = byRoot.get(root)!;
    for (const id of [a, b]) if (!list.includes(id)) list.push(id);
  }
  const clusters = [...byRoot.values()].map(list => [...list].sort((x, y) => x - y));
  return { clusters, pairs };
};

const pickKeep = (rows: RowRec[], members: number[]): number => {
  const byId = new Map(rows.map(r => [r.id, r]));
  return [...members].sort((a, b) => (byId.get(b)!.score - byId.get(a)!.score) || (a - b))[0];
};

/** Rowstore-state fingerprint (read through the WAL) — mirrors the C3
 *  containment invariant; this vehicle's LIVE mode is the one sanctioned
 *  writer of long_term_rows, so callers assert against EXPECTED state. */
const rowstoreFingerprint = (db: any): { count: number; itemsHash: string; sentinelsHash: string; unmergedCount: number } => {
  const rows = db.prepare("SELECT id, item FROM long_term_rows ORDER BY id").all() as Array<{ id: number; item: string }>;
  const itemsHash = createHash("sha256").update(rows.map(r => `${r.id}:${r.item}`).join("\n")).digest("hex");
  const sents = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'merge_quarantine:%' ORDER BY key").all() as Array<{ key: string; value: string }>;
  const sentinelsHash = createHash("sha256").update(sents.map(s => `${s.key}=${s.value}`).join("\n")).digest("hex");
  const unmergedCount = (db.prepare("SELECT COUNT(*) AS c FROM session_summaries WHERE unmerged_fresh_content IS NOT NULL AND length(unmerged_fresh_content) > 0").get() as { c: number }).c;
  return { count: rows.length, itemsHash, sentinelsHash, unmergedCount };
};

const sha256File = (p: string): string | null =>
  existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
const fileSnapshot = (): { main: string | null; wal: string | null } => ({
  main: sha256File(SQLITE_PATH),
  wal: sha256File(`${SQLITE_PATH}-wal`),
});
const walOrAbsent = (h: string | null): string => h ?? "ABSENT";

/** Validate the plan against CURRENT production rows. Throws on any
 *  inconsistency — missing ids (the post-LIVE re-run guard), double-booked
 *  ids, undecided ops, or score/lastSeen that don't match max-of-members. */
const validatePlan = (plan: Plan, rows: RowRec[]): void => {
  const byId = new Map(rows.map(r => [r.id, r]));
  const seen = new Set<number>();
  for (const op of plan.ops) {
    expect(op.action, `op ${op.id}: action is null — every cluster must be explicitly adjudicated ("merge" or "keep")`).not.toBeNull();
    const memberRows = op.members.map(id => {
      const r = byId.get(id);
      expect(r, `op ${op.id}: row ${id} not found in the current store (plan stale? re-run PLAN mode; LIVE is one-shot per plan)`).toBeTruthy();
      expect(seen.has(id), `op ${op.id}: row ${id} is claimed by more than one op`).toBe(false);
      seen.add(id);
      return r;
    });
    if (op.action === "keep") continue; // no writes — decision recorded only
    expect(byId.has(op.keep), `op ${op.id}: keep row ${op.keep} missing`).toBe(true);
    for (const id of op.delete) {
      expect(byId.has(id), `op ${op.id}: delete row ${id} missing`).toBe(true);
      expect(op.members.includes(id), `op ${op.id}: delete row ${id} is not a listed member`).toBe(true);
    }
    expect(op.delete.length, `op ${op.id}: delete must cover every member except keep`).toBe(op.members.length - 1);
    expect(op.delete, `op ${op.id}: keep row must not be in its own delete list`).not.toContain(op.keep);
    expect(op.score, `op ${op.id}: plan score must be MAX of member scores`).toBe(Math.max(...memberRows.map(r => r.score)));
    expect(op.lastSeen, `op ${op.id}: plan lastSeen must be MAX of member last_seen`).toBe(Math.max(...memberRows.map(r => r.lastSeen)));
  }
};

/** Pre-compute every re-embedding (network OUTSIDE the transaction). A null
 *  vector aborts before any write. Returns op id -> vector map. */
const precomputeEmbeddings = async (plan: Plan, rows: RowRec[]): Promise<Map<number, number[]>> => {
  const byId = new Map(rows.map(r => [r.id, r]));
  const out = new Map<number, number[]>();
  for (const op of plan.ops) {
    if (op.action !== "merge" || !op.mergedText) continue;
    if (op.mergedText === byId.get(op.keep)!.item) continue; // identical — no re-embed
    const vec = await embedText(op.mergedText, "document");
    expect(vec, `op ${op.id}: re-embed of mergedText returned null (embed server down?) — aborting before any write`).not.toBeNull();
    out.set(op.keep, vec);
  }
  return out;
};

/** Apply the plan inside ONE transaction on the given db handle. */
const applyPlan = (db: any, plan: Plan, rows: RowRec[], vectors: Map<number, number[]>): void => {
  const byId = new Map(rows.map(r => [r.id, r]));
  const update = db.prepare("UPDATE long_term_rows SET item = ?, score = ?, last_seen = ?, embedding = ? WHERE id = ?");
  const del = db.prepare("DELETE FROM long_term_rows WHERE id = ?");
  const tx = db.transaction(() => {
    for (const op of plan.ops) {
      if (op.action !== "merge") continue;
      for (const id of op.delete) del.run(id);
      const text = op.mergedText ?? byId.get(op.keep)!.item;
      const vec = vectors.has(op.keep) ? vectors.get(op.keep)! : byId.get(op.keep)!.embedding;
      update.run(text, op.score, op.lastSeen, JSON.stringify(vec), op.keep);
    }
  });
  tx();
};

// ─── PLAN mode (read-only scan -> fill-in template) ─────────────────────────

describe.runIf(process.env.ROWSTORE_CONSOLIDATE_PLAN === "1")("rowstore-consolidate — PLAN (read-only scan)", () => {
  it("prints clusters + borderline queue; writes the plan template", () => {
    const config = loadConfigOnce(REPO_ROOT);
    expect(config.useRowStore, "pre-flip tool — useRowStore must be false").toBe(false);
    const ro = new Database(SQLITE_PATH, { readonly: true });
    try {
      const rows = loadRows(ro);
      const threshold = config.embedAutoConsolidateThreshold;
      const { clusters, pairs } = clusterize(rows, threshold);
      const byId = new Map(rows.map(r => [r.id, r]));
      const t4 = (x: number): string => x.toFixed(4);

      // Borderline queue: pairs in [0.75, threshold) — the next-pass queue
      // (threshold cuts real-text families mid-cluster; logged, not acted on).
      const allPairs: Array<[number, number, number]> = [];
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const s = cosineSimilarity(rows[i].embedding, rows[j].embedding);
          if (s >= 0.75 && s < threshold) allPairs.push([rows[i].id, rows[j].id, s]);
        }
      }
      allPairs.sort((a, b) => b[2] - a[2]);
      const clustered = new Set(pairs.flatMap(([a, b]) => [a, b]));
      const queue = allPairs
        .filter(([a, b]) => !clustered.has(a) || !clustered.has(b))
        .slice(0, 25)
        .map(([a, b, s]) => `  ${t4(s)}  [${a}] ${byId.get(a)!.item.slice(0, 100)}\n          [${b}] ${byId.get(b)!.item.slice(0, 100)}`);

      const ops: PlanOp[] = clusters.map(members => {
        const memberRows = members.map(id => byId.get(id)!);
        const keep = pickKeep(rows, members);
        const opPairs = pairs.filter(([a, b]) => members.includes(a) && members.includes(b));
        return {
          id: `c${members.join("+")}`,
          action: null, // the user decides: "merge" | "keep"
          members,
          keep, // suggested: max score, tie -> lowest id
          delete: members.filter(id => id !== keep), // suggested
          score: Math.max(...memberRows.map(r => r.score)),
          lastSeen: Math.max(...memberRows.map(r => r.lastSeen)),
          mergedText: null, // the user writes the complementary merge here
          texts: Object.fromEntries(memberRows.map(r => [String(r.id), r.item])),
          sims: opPairs.map(([a, b, s]) => `${a}~${b}: ${t4(s)}`),
        };
      });

      const report = [
        "## ROWSTORE CONSOLIDATE PLAN (read-only scan)",
        "",
        `rows=${rows.length} threshold=${t4(threshold)} clusters=${clusters.length}`,
        "",
        "### clusters (fill the plan file: action + mergedText per op)",
        ...ops.flatMap(op => [
          `\n[op ${op.id}] suggested keep=${op.keep} delete=[${op.delete.join(", ")}] score=${op.score} last_seen=${op.lastSeen}`,
          ...op.members.map(id => `  [${id}] score=${byId.get(id)!.score} last_seen=${byId.get(id)!.lastSeen}: ${byId.get(id)!.item}`),
          ...op.sims.map(s => `    pair ${s}`),
        ]),
        "",
        "### next-pass queue (borderline 0.75–0.85, unclustered, top 25 — logged, not acted on)",
        ...(queue.length > 0 ? queue : ["  (none)"]),
        "",
        `plan template written: ${PLAN_PATH}`,
      ].join("\n");
      console.log(report);

      if (existsSync(PLAN_PATH)) {
        // Never clobber an existing (possibly adjudicated) plan.
        throw new Error(`plan file already exists — refusing to overwrite: ${PLAN_PATH} (delete it manually to re-scan)`);
      }
      const plan: Plan = {
        note: "Near-dup consolidation plan. Per op: action='merge' applies mergedText to `keep`, deletes `delete` " +
              "rows, score=max-of-members (never sum), lastSeen=max-of-members; action='keep' = adjudicated NOT a " +
              "duplicate (no writes). mergedText=null + action='merge' = delete losers, survivor text unchanged. " +
              "Complementary merges must carry the union of member infos.",
        generated: new Date().toISOString(),
        threshold,
        ops,
        nextPassQueue: queue,
      };
      writeFileSync(PLAN_PATH, JSON.stringify(plan, null, 2) + "\n");
      expect(JSON.parse(readFileSync(PLAN_PATH, "utf8")).ops.length).toBe(ops.length);
    } finally {
      ro.close();
    }
  });
});

// ─── DRY / LIVE shared runner ───────────────────────────────────────────────

const runConsolidation = async (mode: "dry" | "live"): Promise<void> => {
  const config = loadConfigOnce(REPO_ROOT);
  expect(config.useRowStore, "pre-flip tool — useRowStore must be false").toBe(false);
  expect(existsSync(PLAN_PATH), "plan file missing — run PLAN mode first (then fill it in)").toBe(true);
  const plan: Plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));

  // (1) Pre-reads on a read-only production handle (structurally cannot write).
  const ro = new Database(SQLITE_PATH, { readonly: true });
  const rows = loadRows(ro);
  const longTerm = sqliteReadLongTerm(ro);
  expect(longTerm, "long_term id=1 must exist").toBeTruthy();
  const blobBefore = longTerm!.summary;
  const prodBefore = rowstoreFingerprint(ro);
  const before = fileSnapshot();
  ro.close();
  validatePlan(plan, rows);

  // (2) Embed server (C1 semantics: probe -> detached spawn; never throws).
  const status = await ensureEmbedServer(config);
  expect(status.status, `embed server not ready: ${status.reason ?? "no reason"}`).toBe("ready");

  // (3) Pre-compute re-embeddings (network outside the transaction).
  const tEmbed0 = Date.now();
  const vectors = await precomputeEmbeddings(plan, rows);
  const embedMs = Date.now() - tEmbed0;

  const mergeOps = plan.ops.filter(op => op.action === "merge");
  const keepOps = plan.ops.filter(op => op.action === "keep");
  const deletedTotal = mergeOps.reduce((n, op) => n + op.delete.length, 0);
  const reembeddedTotal = vectors.size;

  let db: any;
  let targetLabel: string;
  let targetAfter: { count: number; itemsHash: string; sentinelsHash: string; unmergedCount: number };
  let rowstoreBefore = prodBefore.count;
  try {
    if (mode === "dry") {
      // VACUUM INTO from a read-only handle (C2/C3 mechanism verbatim — a
      // naive file copy can miss uncommitted WAL frames).
      const tmp = mkdtempSync(join(tmpdir(), "rowstore-consolidate-"));
      const copyPath = join(tmp, "copy.db");
      const roSnap = new Database(SQLITE_PATH, { readonly: true });
      roSnap.exec(`VACUUM INTO '${copyPath}'`);
      roSnap.close();
      db = new Database(copyPath);
      targetLabel = "copy (VACUUM INTO — production untouched)";
      rowstoreBefore = (db.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
    } else {
      db = new Database(SQLITE_PATH);
      db.pragma("busy_timeout = 10000"); // an active Pi session writes session_summaries at turn boundaries
      targetLabel = "PRODUCTION (single transaction)";
    }
    applyPlan(db, plan, rows, vectors);
    targetAfter = rowstoreFingerprint(db);
    db.close();
    db = null;
  } finally {
    if (db) db.close();
  }

  // (4) Post-reads on a fresh read-only production handle.
  const ro2 = new Database(SQLITE_PATH, { readonly: true });
  const blobAfter = sqliteReadLongTerm(ro2)!.summary;
  const prodAfter = rowstoreFingerprint(ro2);
  ro2.close();
  const after = fileSnapshot();

  // (5) Expected production state (LIVE) / untouched state (DRY).
  const expectedProdCount = mode === "live" ? prodBefore.count - deletedTotal : prodBefore.count;

  // (6) Report.
  const byId = new Map(rows.map(r => [r.id, r]));
  const t = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const perOp = mergeOps.map((op, i) => {
    const unchanged = op.mergedText === null || op.mergedText === byId.get(op.keep)!.item;
    const embedNote = op.mergedText === null ? "no re-embed (loser deletion only)"
      : unchanged ? "no re-embed (text identical)" : `re-embedded (share of ${embedMs}ms total)`;
    return [
      `[${i + 1}/${mergeOps.length}] ${op.id} keep=${op.keep} delete=[${op.delete.join(", ")}] score=${op.score} last_seen=${op.lastSeen}`,
      ...op.members.map(id => `  was[${id}] s=${byId.get(id)!.score}: ${t(byId.get(id)!.item, 160)}`),
      `  new: ${t(op.mergedText ?? byId.get(op.keep)!.item, 160)} — ${embedNote}`,
      "",
    ];
  });

  const report = [
    "## ROWSTORE CONSOLIDATE REPORT",
    "",
    `mode=${mode} target=${targetLabel}`,
    `plan file: ${PLAN_PATH}`,
    `ops: total=${plan.ops.length} merged=${mergeOps.length} kept-untouched=${keepOps.length} deleted_rows=${deletedTotal} re-embedded=${reembeddedTotal}`,
    `rowstore_delta: before=${rowstoreBefore} after=${targetAfter.count}`,
    "",
    "### per-op review",
    ...(perOp.length > 0 ? perOp.flat() : ["(none)"]),
    ...(keepOps.length > 0 ? [
      "### kept-untouched (adjudicated NOT duplicates)",
      ...keepOps.map(op => `[${op.id}] rows [${op.members.join(", ")}] — ${t(Object.values(op.texts)[0] ?? "", 160)}`),
      "",
    ] : []),
    "### production integrity",
    `sha256 main before=${walOrAbsent(before.main)} after=${walOrAbsent(after.main)} status=${after.main === before.main ? "IDENTICAL" : mode === "live" ? "CHANGED (expected — live mode writes)" : "CHANGED (UNEXPECTED)"}`,
    `sha256 -wal before=${walOrAbsent(before.wal)} after=${walOrAbsent(after.wal)} status=${after.wal === before.wal ? "IDENTICAL" : "CHANGED/ABSENT (reported, not asserted — active Pi session)"}`,
    `long_term blob byte-identical=${blobAfter === blobBefore ? "yes" : "no"}`,
    `rowstore_state: rows=${prodAfter.count === prodBefore.count ? "IDENTICAL" : "CHANGED"} sentinels=${prodAfter.sentinelHash === prodBefore.sentinelHash ? "IDENTICAL" : "CHANGED"} unmerged=${prodAfter.unmergedCount >= prodBefore.unmergedCount ? "NOT-REDUCED" : "REDUCED"}`,
  ].join("\n");
  console.log(report);

  // (7) Mechanical asserts.
  expect(blobAfter, "the long_term blob must be byte-identical (this vehicle never touches it)").toBe(blobBefore);
  if (mode === "dry") {
    // Rowstore state must be untouched; unmerged is NOT-REDUCED, not equal —
    // an active Pi session legitimately writes session_summaries at turn
    // boundaries (the 2026-08-31 8.1 re-run #2 lesson, C3 pattern).
    expect(prodAfter.count, "DRY: production row count must be untouched").toBe(prodBefore.count);
    expect(prodAfter.itemsHash, "DRY: production row items must be untouched").toBe(prodBefore.itemsHash);
    expect(prodAfter.sentinelHash, "DRY: sentinels must be untouched").toBe(prodBefore.sentinelHash);
    expect(prodAfter.unmergedCount, "DRY: unmerged count must not DECREASE (live session only adds)").toBeGreaterThanOrEqual(prodBefore.unmergedCount);
    expect(targetAfter.count, "DRY: copy row count must equal before - deleted").toBe(rowstoreBefore - deletedTotal);
  } else {
    expect(prodAfter.count, "LIVE: production row count must equal before - deleted").toBe(expectedProdCount);
    expect(prodAfter.sentinelHash, "LIVE: merge_quarantine sentinels must be untouched").toBe(prodBefore.sentinelHash);
    // Exact item-set check: every non-deleted row unchanged except planned survivors.
    const deleteSet = new Set(mergeOps.flatMap(op => op.delete));
    const ro3 = new Database(SQLITE_PATH, { readonly: true });
    const afterRows = loadRows(ro3);
    ro3.close();
    const afterById = new Map(afterRows.map(r => [r.id, r]));
    expect(afterRows.length, "LIVE: row count").toBe(expectedProdCount);
    for (const r of rows) {
      if (deleteSet.has(r.id)) { expect(afterById.has(r.id), `LIVE: row ${r.id} must be deleted`).toBe(false); continue; }
      const keepOp = mergeOps.find(op => op.action === "merge" && op.keep === r.id && op.mergedText !== null && op.mergedText !== r.item);
      const after = afterById.get(r.id)!;
      expect(after, `LIVE: row ${r.id} must still exist`).toBeTruthy();
      if (keepOp) {
        expect(after.item, `LIVE: survivor ${r.id} must carry the plan mergedText`).toBe(keepOp.mergedText);
        expect(after.score, `LIVE: survivor ${r.id} score`).toBe(keepOp.score);
        expect(after.lastSeen, `LIVE: survivor ${r.id} last_seen`).toBe(keepOp.lastSeen);
        const vec = vectors.get(r.id);
        expect(vec, `LIVE: survivor ${r.id} re-embed vector was computed`).toBeTruthy();
        expect(JSON.stringify(after.embedding), `LIVE: survivor ${r.id} stored vector`).toBe(JSON.stringify(vec));
      } else {
        expect(after.item, `LIVE: row ${r.id} item must be unchanged`).toBe(r.item);
        expect(after.score, `LIVE: row ${r.id} score must be unchanged`).toBe(r.score);
      }
    }
  }
};

describe.runIf(process.env.ROWSTORE_CONSOLIDATE_DRY === "1")("rowstore-consolidate — DRY (VACUUM copy)", () => {
  it("applies the plan to a throwaway copy; production untouched; report printed", { timeout: 600_000 }, async () => {
    await runConsolidation("dry");
  });
});

describe.runIf(process.env.ROWSTORE_CONSOLIDATE_LIVE === "1")("rowstore-consolidate — LIVE (production)", () => {
  it("applies the plan to production in one transaction; exact expected state; report printed", { timeout: 600_000 }, async () => {
    await runConsolidation("live");
  });
});
