// rowstore-merge-live.test.ts — rowstore-merge C3 live-gate vehicle (design §7, §13).
//
// The ONLY code path that runs the C3 merge engine (mergeSignalsIntoRowStore)
// against real data. No runtime hook can reach it: while useRowStore is false,
// the index.ts step-8.1 branch is inert (lock rule 4).
//
// Command (byte-pinned — AGENTS.md's "Row-store merge live-gate vehicle
// (rowstore-merge C3)" section is the source of truth; the two must match
// byte-for-byte, verified at the doc gate):
//
// ROWSTORE_MERGE_LIVE=1 npx vitest run rowstore-merge-live
//
// What it does: ALWAYS copy-targeted — the production DB is opened read-only
// and snapshotted with VACUUM INTO into a throwaway copy; every engine run
// targets the copy only; production containment is asserted as NO
// rowstore-state mutation (main + long_term blob byte-identity; long_term_rows
// count + item set; merge_quarantine sentinel set; unmerged count not
// reduced) — WAL bytes/presence are REPORTED, not asserted (an active Pi
// session writes production at turn boundaries — the 2026-08-31 8.1 re-run #2
// incident). Auto-spawns the 5002 embed
// server when not READY (C1/C2 precedent); 5001 never touched.
//
// LLM stage: the engine's default seam (defaultSignalLlmCall → llmCallOnce →
// complete) resolves through vitest's alias to test/mocks/pi-ai.ts for EVERY
// test file. The mock's empty-queue default is { content: [], stopReason:
// "stop" } — without forwarding, every signal fails `timeout` in ~0ms with
// NO real LLM contact (the 2026-08-29 8.1 first-run incident: 149/149
// timeout, 22 runs, 3.5s). Fix (lt-conversion-live precedent): import the
// real package PAST the alias and forward the mock's calls to it, so the
// engine's own production seam reaches the real complete() while
// mockCompleteCalls() recording still works. A tripwire after the report
// fails mechanically if signals were processed but zero decisions produced.
// Expected report: "## ROWSTORE MERGE LIVE REPORT" — drain
// runs/signals/marked/failed/quarantined + incomplete flag; decision + skip
// histograms (fixed key order, zeros rendered, never omitted); MERGE-DECISION
// + CANDIDATES transcripts (verbatim logger bytes, emission order; (none) for
// an empty section); per-signal review (human-readable — the signal text,
// the candidates shown, the decision); pooled similarity distribution (percentile formulas
// incl. the N = 0 case); production-integrity block (sha256 main/-wal status,
// blob byte-identical, sidecar path).
//
// Re-run semantics: safe and idempotent against production — every invocation
// rebuilds the copy from CURRENT production state (fresh VACUUM INTO);
// reports are per-invocation snapshots; harness quarantine strikes live only
// in the copy and never persist.
//
// NO destructive backfill: this vehicle never writes the production DB. After
// C3's first REAL production writes (which begin only at C4's flip),
// ROWSTORE_LIVE=1 ROWSTORE_BACKFILL_MODE=destructive must NOT be re-run
// against any shared store — the C2 destructive backfill destroys C3 rows.
//
// C3.5 extension (rowstore-lessons) — two more env gates on this SAME
// vehicle. This block is the byte source for AGENTS.md's vehicle section —
// the three command lines must match byte-for-byte (verified at the doc
// gate).
//
// ROWSTORE_MERGE_LIVE=1 npx vitest run rowstore-merge-live
//   C3's live gate (unchanged) — ALWAYS copy-targeted: a fresh VACUUM INTO
//   copy per invocation; the full unmerged backlog drains against the copy;
//   production is opened read-only and containment is asserted; the P7
//   report "## ROWSTORE MERGE LIVE REPORT" is printed.
//
// ROWSTORE_LESSONS_DRY=1 npx vitest run rowstore-merge-live
//   The C3.5 DRY rehearsal (design §2.3) — the FULL unmerged backlog drains
//   through the production engine (the EXTRACT stage included) against a
//   fresh VACUUM INTO copy, then the rescue section runs exactly ONE EXTRACT
//   over the production long_term blob (off-distribution gate data —
//   candidate lessons from the legacy KB). Zero production impact — the main
//   sha256, the blob bytes, and the rowstore-state fingerprint are asserted
//   unchanged (the -wal line is REPORTED, not asserted). The §9.1 report
//   "## ROWSTORE LESSONS DRY REPORT" is printed + written to
//   <tmp>/rowstore-lessons-dry-report.md — the calibration evidence the user
//   reviews before the flip (the §7.1 gate input).
//
// ROWSTORE_LESSONS_LIVE=1 ROWSTORE_LESSONS_LIVE_MODE=additive|rescue-replace npx vitest run rowstore-merge-live
//   The C3.5 LIVE drain (design §2.4) — the only production mutation in
//   C3.5. The production engine drains the FULL unmerged backlog (real
//   writes; the long_term blob is never touched by any engine path). The
//   mode is the user's choice from the DRY report — the vehicle FAILS FAST
//   on a missing/invalid ROWSTORE_LESSONS_LIVE_MODE (exactly 'additive' or
//   'rescue-replace'; it never auto-selects): additive inserts the drained
//   lessons on top of the existing rows; rescue-replace is one-shot — it
//   writes the sidecar <tmp>/rescue-replace-cleared-rows.json (all legacy
//   rows: id/item/score/last_seen) BEFORE a single transaction that clears
//   those rows and inserts the rescued + backlog lessons (the sidecar is
//   the rollback artifact; C3.5 never deletes it). The blob stays
//   BYTE-IDENTICAL (hard assert, either mode); the sha256 main/-wal after +
//   the rowstore-state fingerprint after are REPORTED (CHANGED expected).
//   The §9.2 report "## ROWSTORE LESSONS LIVE REPORT" is printed + written
//   to <tmp>/rowstore-lessons-live-report.md.
//
// Re-run semantics: DRY rebuilds a fresh copy per invocation (safe,
// idempotent, zero production impact). LIVE marks every drained session
// processed (zero-lesson sessions included) — a repeated LIVE invocation
// drains 0 (the vehicle asserts it: second_run_drained=0). rescue-replace
// is one-shot: a second run finds no legacy rows (empty snapshot → no
// sidecar, cleared_sidecar=-).
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as logger from "../logger.js";
import { mergeSignalsIntoRowStore, EXTRACT_LLM_TIMEOUT_MS, insertRow, normalizeLesson, type RowStoreMergeResult, type RowStoreSignalDetail } from "../rowstore.js";
import { ensureEmbedServer, embedText } from "../embeddings.js";
import { sqliteReadLongTerm, sqliteReadUnmergedSessionSummaries, pruneMergeQuarantine, buildMergeModelPair, llmCallOnce } from "../summarizer.js";
import { loadConfigOnce } from "../config.js";
import { SQLITE_PATH } from "../discoverer.js";
import { mockCompleteReset, mockCompleteSetDefault } from "@earendil-works/pi-ai"; // the recording mock (via the vitest alias)
import * as realPiAi from "../node_modules/@earendil-works/pi-ai/dist/index.js"; // the real SDK PAST the alias (lt-conversion-live precedent)

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// Repo root (this file lives in test/) — loadConfigOnce's extensionDir (the
// user config lives at ~/.pi/agent/session-recall.yaml; the extensionDir only
// serves the config.example.yaml bootstrap fallback).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const sha256File = (p: string): string | null =>
  existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;

/** Rowstore-state fingerprint on a READ-ONLY production handle — the precise
 *  containment invariant (2026-08-31 8.1 re-run #2 incident): the vehicle must
 *  write NO rowstore state to production. Read through the WAL, so an
 *  uncheckpointed vehicle write is caught exactly like a checkpointed one. */
/** Human-readable per-lesson rendering for the live-gate review (2026-08-31:
 *  the pinned mechanical sections are parse-first; the transcript review
 *  needs WHAT each decision was made on). Additive section. C3.5 re-key
 *  (rowstore-lessons): signal→lesson (lessonIndex=/lesson:) + the decision
 *  line gains enrich=<token> from the additive detail field; SKIP outcomes
 *  unchanged. All three reports (C3 + DRY + LIVE) render through this.
 *  task 7.2: the session= label is the unique sessionLabel (run sessions
 *  disambiguated by their run segment — a label resolving to exactly one
 *  session path). */

/** task 7.2 — the UNIQUE per-session label. The 2026-08-30 DRY ambiguity:
 *  102 of 106 backlog sessions were subagent run sessions nested under their
 *  parent main session's directory (…\<parent-token>\<runUUID>\run-0\
 *  session.jsonl — the parent file shares the token too), so the old
 *  first-token-anything derivation gave every run-0 session its parent's
 *  label (~5 distinct labels for 106 sessions). Fix: main session files
 *  keep their own token; run sessions are disambiguated by the run segment
 *  (<parent-token>/<runUUID>/run-N). Rendering only — no engine/store
 *  change; every LTROW byte-pin untouched. */
const sessionLabel = (p: string): string => {
  const tokenRe = /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z?_[0-9a-f-]+/;
  const parts = p.split(/[\\/]+/);
  let tokenIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) if (tokenRe.test(parts[i])) { tokenIdx = i; break; }
  if (tokenIdx === -1) return p; // no token anywhere — the whole path (the old fallback)
  const token = parts[tokenIdx].match(tokenRe)![0];
  const tail = parts.slice(tokenIdx + 1);
  const runIdx = tail.findIndex(seg => /^run-\d+$/.test(seg));
  return runIdx > 0 ? `${token}/${tail[runIdx - 1]}/${tail[runIdx]}` : token;
};

const renderLessonDetail = (d: RowStoreSignalDetail): string[] => {
  const t = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const sid = sessionLabel(d.sessionPath);
  const cand = d.candidates.length === 0
    ? `  candidates:  (none — retrieval empty or never ran)`
    : d.candidates.map(c => `  candidates:  [${c.id}] ${c.similarity.toFixed(4)}  ${t(c.item, 110)}`).join("\n"); // design §9.3-3: the label prefixes each entry line (one per line)
  const cap = d.outcome.kind === "decision" && (d.outcome.enrich === "rewrite" || d.outcome.enrich === "rejected") ? 400 : 220; // task 7.3 — rewrite/rejected entries carry the fuller context (the candidate list stays 110)
  const out = d.outcome.kind === "decision"
    ? `  decision:    ${d.outcome.action.toUpperCase()}${d.outcome.rowId !== undefined ? ` row=${d.outcome.rowId}` : ""} (by ${d.outcome.by}) enrich=${d.outcome.enrich ?? "none"}`
    : `  decision:    SKIP reason=${d.outcome.reason}`;
  return [`session=${sid} lessonIndex=${d.signalIndex}`, `  lesson:      ${t(d.signal, cap)}`, cand, out, ""];
};

const prodRowState = (ro: any): { count: number; itemsHash: string; sentinelHash: string; unmergedCount: number } => {
  const rows = ro.prepare("SELECT id, item FROM long_term_rows ORDER BY id").all() as Array<{ id: number; item: string }>;
  const itemsHash = createHash("sha256").update(rows.map(r => `${r.id}:${r.item}`).join("\n")).digest("hex");
  const sents = ro.prepare("SELECT key, value FROM meta WHERE key LIKE 'merge_quarantine:%' ORDER BY key").all() as Array<{ key: string; value: string }>;
  const sentinelHash = createHash("sha256").update(sents.map(s => `${s.key}=${s.value}`).join("\n")).digest("hex");
  const unmergedCount = (ro.prepare("SELECT COUNT(*) AS c FROM session_summaries WHERE unmerged_fresh_content IS NOT NULL AND length(unmerged_fresh_content) > 0").get() as { c: number }).c;
  return { count: rows.length, itemsHash, sentinelHash, unmergedCount };
};

/** Production file snapshot — main + -wal if present; -shm excluded (transient
 *  reader bookkeeping, not durable state). */
const prodFileSnapshot = (): { main: string | null; wal: string | null } => ({
  main: sha256File(SQLITE_PATH),
  wal: sha256File(`${SQLITE_PATH}-wal`),
});

const sim4 = (x: number): string => x.toFixed(4);
// ---------------------------------------------------------------------------
// C3.5 vehicle constants + pure helpers (task 5.1) — the DRY/LIVE describes
// below consume these; the non-gated unit describe pins their bytes.
// ---------------------------------------------------------------------------

interface LegacyRow { id: number; item: string; score: number; last_seen: number; }

/** The pinned EXTRACT prompt's two example lessons — the contamination
 *  matcher's source of truth (spec R7: raw / normalized / unflagged). */
const EXAMPLE_LESSON_1 = "Use /dev/null, not nul, to discard output in Windows bash";
const EXAMPLE_LESSON_2 = "The 5002 embed server is spawned detached; extension code must never kill it";

/** The vehicle's frozen copy of the engine's private EXTRACT prompt (the spec
 *  :329-398 transcription source — byte-identical to rowstore.ts's
 *  EXTRACT_PROMPT_LINES; the 12.2 grep gate + the 1.1 prompt-shape fixture
 *  cross-check the match). Assembles the rescue-EXTRACT call: the engine's
 *  builder/parser are private (§1.2), so the vehicle carries the prompt bytes
 *  here and runs the SAME production seam (buildMergeModelPair + llmCallOnce
 *  + EXTRACT_LLM_TIMEOUT_MS) the drain uses. */
const RESCUE_EXTRACT_PROMPT_LINES = [
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
  "  never saw this one; each lesson must make sense alone.",
];

/** The C3 pooled-percentile formula reused for the latency stats — N = 0 →
 *  "-"; S[floor(q*(N-1))]. */
const pctile = (sorted: number[], q: number): string =>
  sorted.length === 0 ? "-" : sim4(sorted[Math.floor(q * (sorted.length - 1))]);

/** Spec R7 contamination check: byte-identical to an example lesson →
 *  "raw"; else identical after normalizeLesson (imported — P6, no second
 *  copy) → "normalized"; else unflagged. Flagged lessons are REPORTED and
 *  FLOW ON (the user adjudicates at the review gate — no mechanical
 *  exclusion). */
const contaminationHit = (lesson: string): "raw" | "normalized" | null => {
  if (lesson === EXAMPLE_LESSON_1 || lesson === EXAMPLE_LESSON_2) return "raw";
  const n = normalizeLesson(lesson);
  if (n === normalizeLesson(EXAMPLE_LESSON_1) || n === normalizeLesson(EXAMPLE_LESSON_2)) return "normalized";
  return null;
};

/** The rescue-section annotation match (design §2.3-5, order pinned):
 *  (1) normalizeLesson identity; (2) else raw containment either way (first
 *  match wins, row order); (3) else null → the report renders score=-. */
const rescueRowScoreAnnotation = (lesson: string, legacyRows: LegacyRow[]): number | null => {
  const n = normalizeLesson(lesson);
  for (const row of legacyRows) if (normalizeLesson(row.item) === n) return row.score;
  for (const row of legacyRows) {
    if (row.item !== "" && (lesson.includes(row.item) || row.item.includes(lesson))) return row.score;
  }
  return null;
};

/** The §2.6 sidecar schema — stable key order as pinned; the DB column names
 *  verbatim (id / item / score / last_seen); rowCount for the recovery chain.
 *  A unit test pins the BYTES for a 2-row fixture. */
const serializeSidecar = (rows: LegacyRow[], meta: { writtenAt: string; productionDb: string; blobBeforeSha256: string }): string =>
  JSON.stringify({
    change: "rowstore-lessons",
    vehicle: "rowstore-merge-live (C3.5 LIVE, rescue-replace)",
    writtenAt: meta.writtenAt,
    productionDb: meta.productionDb,
    blobBeforeSha256: meta.blobBeforeSha256,
    rows,
    rowCount: rows.length,
  });

/** The rescue-EXTRACT response parser — the spec §Procedure pin (P3), a
 *  test-side copy of the engine's private parseExtractLessons (§1.2): trim;
 *  ignore empty lines; a sole remaining line that is exactly (none) → zero
 *  lessons; else every remaining line must start with "- " at column 0 →
 *  lessons verbatim, trailing ws trimmed; else garbage → null. */
const parseRescueLessons = (text: string | null): string[] | null => {
  if (text === null) return null;
  const kept = text.trim().split(/\r?\n/).filter(l => l.trim() !== "");
  if (kept.length === 0) return null;
  if (kept.length === 1 && kept[0].trim() === "(none)") return [];
  const lessons: string[] = [];
  for (const l of kept) {
    if (!l.startsWith("- ")) return null;
    const lesson = l.slice(2).replace(/\s+$/, "");
    if (lesson === "") return null;
    lessons.push(lesson);
  }
  return lessons;
};

// ─── report agg shapes + builders (the §9.1 / §9.2 byte layouts) ───

interface ProdRowStateSnap { count: number; itemsHash: string; sentinelHash: string; unmergedCount: number; }

interface ReportIntegrity {
  beforeMain: string; afterMain: string;
  beforeWal: string | null; afterWal: string | null;
  blobBefore: string; blobAfter: string;
  prodBefore: ProdRowStateSnap; prodAfter: ProdRowStateSnap;
}

interface ReportCore {
  runs: number; sessionsStarted: number; lessons: number; marked: number; failed: number; quarantined: number; drained: boolean;
  extractCalls: number; chunkedSessions: number;
  decisionHist: { match: number; new: number; contradict: number };
  skipHist: { "embed-null": number; timeout: number; "parse-fail": number };
  lessonsTranscript: string[];
  decisionTranscript: string[];
  candidatesTranscript: string[];
  enrichTranscript: string[];
  skipTranscript: string[];
  signalDetail: RowStoreSignalDetail[];
  emptySessions: Array<{ label: string; chars: number }>;
  pooled: number[];
  threshold: number;
  rowstoreBefore: number; rowstoreAfter: number;
  integrity: ReportIntegrity;
  sidecarPath: string;
  reportPath: string;
}

interface DryAgg extends ReportCore {
  perSession: Array<{ label: string; chars: number; latencyMs: number; empty: boolean; opening: string; lessons: string[] }>;
  contamination: Array<{ label: string; lesson: string; hit: "raw" | "normalized" }>;
  rescue: { sourceChars: number; extractCalls: number; survivors: Array<{ score: number | null; lesson: string }> };
  latency: { extract: number[]; compare: number[]; merge: number[] };
}

interface LiveAgg extends ReportCore {
  liveMode: "additive" | "rescue-replace";
  secondRunDrained: number;
  rowsCleared: number; rescuedInserted: number;
  clearedSidecarPath: string | null;
}

const RESCUE_LABEL = "label: candidate lessons from the legacy KB (off-distribution gate data — not session-extraction evidence)";

/** enrich_histogram — parsed from the verbatim MERGE-DECISION transcript
 *  (the enrich= token is the line's last field; emission order preserved). */
const enrichHistogram = (decisionTranscript: string[]): { rewrite: number; none: number; rejected: number } => {
  const h = { rewrite: 0, none: 0, rejected: 0 };
  for (const line of decisionTranscript) {
    const m = line.match(/enrich=(rewrite|none|rejected)$/);
    if (m) h[m[1] as "rewrite" | "none" | "rejected"]++;
  }
  return h;
};

/** Per-class latency stats — the same pooled formula over per-class
 *  millisecond arrays (integers rendered), max = S[N-1] (N=0 → -). */
const latencyStat = (arr: number[]) => {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  const at = (q: number): string => (n === 0 ? "-" : String(s[Math.floor(q * (n - 1))]));
  return { n, p50: at(0.5), p90: at(0.9), max: n === 0 ? "-" : String(s[n - 1]) };
};

const transcriptSection = (title: string, lines: string[]): string[] =>
  [title, lines.length > 0 ? lines.join("\n") : "(none)", ""];

const lessonReviewSection = (a: ReportCore): string[] =>
  ["### per-lesson review (human-readable)",
   ...(a.signalDetail.length > 0 ? a.signalDetail.flatMap(d => renderLessonDetail(d)) : ["(none)"]),
   ""];

const similaritySection = (a: ReportCore): string[] => {
  const sorted = [...a.pooled].sort((x, y) => x - y);
  const n = sorted.length;
  const above = sorted.filter(x => x >= a.threshold).length;
  return [
    `### similarity distribution (pooled n=${n})`,
    `min=${pctile(sorted, 0)} p25=${pctile(sorted, 0.25)} p50=${pctile(sorted, 0.5)} p75=${pctile(sorted, 0.75)} max=${pctile(sorted, 1)}`,
    `above_threshold=${above} below_threshold=${n - above} threshold=${sim4(a.threshold)}`,
  ];
};

const integritySection = (a: ReportCore): string[] => {
  const mainStatus = a.integrity.afterMain === a.integrity.beforeMain ? "IDENTICAL" : "CHANGED";
  const walStatus = (a.integrity.afterWal ?? "ABSENT") === (a.integrity.beforeWal ?? "ABSENT") ? "IDENTICAL" : "CHANGED";
  const pb = a.integrity.prodBefore;
  const pa = a.integrity.prodAfter;
  return [
    "### production integrity",
    `sha256 main before=${a.integrity.beforeMain} after=${a.integrity.afterMain} status=${mainStatus}`,
    `sha256 -wal before=${a.integrity.beforeWal ?? "ABSENT"} after=${a.integrity.afterWal ?? "ABSENT"} status=${walStatus}`,
    `blob byte-identical=${a.integrity.blobAfter === a.integrity.blobBefore ? "yes" : "no"}`,
    `rowstore_state: rows=${pa.count === pb.count ? "IDENTICAL" : "CHANGED"} sentinels=${pa.sentinelHash === pb.sentinelHash ? "IDENTICAL" : "CHANGED"} unmerged=${pa.unmergedCount >= pb.unmergedCount ? "NOT-REDUCED" : "REDUCED"}`,
  ];
};

/** §9.1 — the DRY report byte layout (section order pinned; every list
 *  section renders (none) when empty). */
const buildDryReport = (a: DryAgg): string => {
  const eh = enrichHistogram(a.decisionTranscript);
  const le = latencyStat(a.latency.extract);
  const lc = latencyStat(a.latency.compare);
  const lm = latencyStat(a.latency.merge);
  const p15 = a.perSession.filter(s => s.lessons.length >= 15).length;
  const decisions = a.decisionHist.match + a.decisionHist.new + a.decisionHist.contradict;
  const perSessionBlocks = a.perSession.length === 0
    ? ["(none)"]
    : [a.perSession.map(s => [
        `session=${s.label} chars=${s.chars} latency_ms=${s.latencyMs} empty=${s.empty ? "yes" : "no"}`,
        `  opening: ${s.opening}`,
        ...s.lessons.map(l => `  lesson: ${l}`),
      ].join("\n")).join("\n\n")]; // design §9.1 template: one blank line between blocks
  return [
    "## ROWSTORE LESSONS DRY REPORT",
    "",
    "mode=DRY",
    `drain runs=${a.runs} sessions=${a.sessionsStarted} lessons=${a.lessons} marked=${a.marked} failed=${a.failed} quarantined=${a.quarantined} incomplete=${a.drained ? "no" : "yes"}`,
    `extract_calls=${a.extractCalls} chunked_sessions=${a.chunkedSessions}`,
    `decision_histogram: match=${a.decisionHist.match} new=${a.decisionHist.new} contradict=${a.decisionHist.contradict}`,
    `skip_histogram: embed-null=${a.skipHist["embed-null"]} timeout=${a.skipHist.timeout} parse-fail=${a.skipHist["parse-fail"]}`,
    `enrich_histogram: rewrite=${eh.rewrite} none=${eh.none} rejected=${eh.rejected}`,
    `empty_sessions=${a.emptySessions.length}/${a.sessionsStarted}`,
    `rowstore_delta: before=${a.rowstoreBefore} after=${a.rowstoreAfter}`,
    "",
    ...transcriptSection("### LESSONS transcript", a.lessonsTranscript),
    ...transcriptSection("### MERGE-DECISION transcript", a.decisionTranscript),
    ...transcriptSection("### CANDIDATES transcript", a.candidatesTranscript),
    ...transcriptSection("### MERGE-ENRICH transcript", a.enrichTranscript),
    ...transcriptSection("### MERGE-SKIP transcript", a.skipTranscript),
    ...lessonReviewSection(a),
    "### lessons extracted (per session)",
    ...perSessionBlocks,
    "",
    "### empty sessions",
    ...(a.emptySessions.length === 0 ? ["(none)"] : a.emptySessions.map(s => `session=${s.label} chars=${s.chars}`)),
    "",
    "### contamination flags",
    ...(a.contamination.length === 0 ? ["(none)"] : a.contamination.map(c => `session=${c.label} lesson=\"${c.lesson}\" hit=${c.hit}`)),
    "",
    "### rescue section",
    `source=<long_term blob> chars=${a.rescue.sourceChars} extract_calls=${a.rescue.extractCalls} survivors=${a.rescue.survivors.length}`,
    ...(a.rescue.survivors.length === 0 ? ["(none)"] : a.rescue.survivors.map(s => `  [score=${s.score ?? "-"}] ${s.lesson}`)),
    RESCUE_LABEL,
    "",
    "### calibration evidence",
    `empty_rate=${a.emptySessions.length}/${a.sessionsStarted}`,
    `padding_signature=${p15 > 0 ? "yes" : "no"} sessions_with_15plus_lessons=${p15}`,
    `match_rate=${a.decisionHist.match}/${decisions} (run-4 reference: 26/118)`,
    `latency_ms extract: n=${le.n} p50=${le.p50} p90=${le.p90} max=${le.max}`,
    `latency_ms compare: n=${lc.n} p50=${lc.p50} p90=${lc.p90} max=${lc.max}`,
    `latency_ms merge: n=${lm.n} p50=${lm.p50} p90=${lm.p90} max=${lm.max}`,
    "",
    ...similaritySection(a),
    "",
    ...integritySection(a),
    "cleared_sidecar=-",
    `sidecar=${a.sidecarPath}`,
    `report_file=${a.reportPath}`,
  ].join("\n");
};

/** §9.2 — the LIVE report byte layout (section order pinned; the
 *  rescue-replace rows_cleared line + cleared_sidecar path are conditional). */
const buildLiveReport = (a: LiveAgg): string => {
  const eh = enrichHistogram(a.decisionTranscript);
  return [
    "## ROWSTORE LESSONS LIVE REPORT",
    "",
    `mode=LIVE live_mode=${a.liveMode}`,
    `drain runs=${a.runs} sessions=${a.sessionsStarted} lessons=${a.lessons} marked=${a.marked} failed=${a.failed} quarantined=${a.quarantined} incomplete=${a.drained ? "no" : "yes"}`,
    `extract_calls=${a.extractCalls} chunked_sessions=${a.chunkedSessions}`,
    `decision_histogram: match=${a.decisionHist.match} new=${a.decisionHist.new} contradict=${a.decisionHist.contradict}`,
    `skip_histogram: embed-null=${a.skipHist["embed-null"]} timeout=${a.skipHist.timeout} parse-fail=${a.skipHist["parse-fail"]}`,
    `enrich_histogram: rewrite=${eh.rewrite} none=${eh.none} rejected=${eh.rejected}`,
    `empty_sessions=${a.emptySessions.length}/${a.sessionsStarted}`,
    `second_run_drained=${a.secondRunDrained}`,
    `rowstore_delta: before=${a.rowstoreBefore} after=${a.rowstoreAfter}`,
    ...(a.liveMode === "rescue-replace" ? [`rows_cleared=${a.rowsCleared} rescued_inserted=${a.rescuedInserted}`] : []),
    "",
    ...transcriptSection("### LESSONS transcript", a.lessonsTranscript),
    ...transcriptSection("### MERGE-DECISION transcript", a.decisionTranscript),
    ...transcriptSection("### CANDIDATES transcript", a.candidatesTranscript),
    ...transcriptSection("### MERGE-ENRICH transcript", a.enrichTranscript),
    ...transcriptSection("### MERGE-SKIP transcript", a.skipTranscript),
    ...lessonReviewSection(a),
    ...similaritySection(a),
    "",
    ...integritySection(a),
    `cleared_sidecar=${a.clearedSidecarPath ?? "-"}`,
    `sidecar=${a.sidecarPath}`,
    `report_file=${a.reportPath}`,
  ].join("\n");
};

// ---------------------------------------------------------------------------
// C3.5 unit describe fixtures (non-gated, default suite) — the agg shapes the
// report builders consume; the byte-pinned expectations live in the describe.
// ---------------------------------------------------------------------------

const h64ZeroFixture = "0".repeat(64);
const h64aFixture = "9c1f3a7d4b2e8f6a0c5d7e9b3a1f8c4e6d2b9a7f5c3e1d8b4a6f0c9e2d7b5a38";
const h64bFixture = "b3a1f8c4e6d2b9a7f5c3e1d8b4a6f0c9e2d7b5a389c1f3a7d4b2e8f6a0c5d7e9b";

function emptyDryAgg() {
  return {
    runs: 0, sessionsStarted: 0, lessons: 0, marked: 0, failed: 0, quarantined: 0, drained: false,
    extractCalls: 0, chunkedSessions: 0,
    decisionHist: { match: 0, new: 0, contradict: 0 },
    skipHist: { "embed-null": 0, timeout: 0, "parse-fail": 0 },
    lessonsTranscript: [] as string[],
    decisionTranscript: [] as string[],
    candidatesTranscript: [] as string[],
    enrichTranscript: [] as string[],
    skipTranscript: [] as string[],
    signalDetail: [] as import("../rowstore.js").RowStoreSignalDetail[],
    perSession: [] as Array<{ label: string; chars: number; latencyMs: number; empty: boolean; opening: string; lessons: string[] }>,
    emptySessions: [] as Array<{ label: string; chars: number }>,
    contamination: [] as Array<{ label: string; lesson: string; hit: "raw" | "normalized" }>,
    rescue: { sourceChars: 0, extractCalls: 1, survivors: [] as Array<{ score: number | null; lesson: string }> },
    latency: { extract: [] as number[], compare: [] as number[], merge: [] as number[] },
    pooled: [] as number[],
    threshold: 0.5,
    rowstoreBefore: 0, rowstoreAfter: 0,
    integrity: {
      beforeMain: "0".repeat(64), afterMain: "0".repeat(64),
      beforeWal: null, afterWal: null,
      blobBefore: "", blobAfter: "",
      prodBefore: { count: 0, itemsHash: "0".repeat(64), sentinelHash: "0".repeat(64), unmergedCount: 0 },
      prodAfter: { count: 0, itemsHash: "0".repeat(64), sentinelHash: "0".repeat(64), unmergedCount: 0 },
    },
    sidecarPath: "/tmp/rowstore-lessons-x/production.sha256",
    reportPath: "/tmp/rowstore-lessons-x/rowstore-lessons-dry-report.md",
  };
}

function filledDryAgg() {
  const tmp = "C:\\Users\\test\\AppData\\Local\\Temp\\rowstore-lessons-x7k2";
  const h64a = "9c1f3a7d4b2e8f6a0c5d7e9b3a1f8c4e6d2b9a7f5c3e1d8b4a6f0c9e2d7b5a38";
  return {
    runs: 1, sessionsStarted: 2, lessons: 5, marked: 2, failed: 0, quarantined: 0, drained: true,
    extractCalls: 3, chunkedSessions: 1,
    decisionHist: { match: 2, new: 2, contradict: 1 },
    skipHist: { "embed-null": 0, timeout: 0, "parse-fail": 0 },
    lessonsTranscript: [
      "LTROW LESSONS n=3 session=2026-08-28T09-00-00Z_a1b2c3d4.jsonl",
      "LTROW LESSONS n=2 session=2026-08-29T14-30-00Z_e5f6a7b8.jsonl",
    ],
    decisionTranscript: [
      "LTROW MERGE-DECISION action=match rowId=14 top=0.7311 by=llm enrich=none",
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
      "LTROW MERGE-DECISION action=match rowId=31 top=0.6920 by=llm enrich=rewrite",
      "LTROW MERGE-DECISION action=contradict rowId=7 top=0.6988 by=llm enrich=none",
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
    ],
    candidatesTranscript: [
      "LTROW CANDIDATES n=1 pairs=14:0.7311",
      "LTROW CANDIDATES n=0 pairs=-",
      "LTROW CANDIDATES n=1 pairs=31:0.6920",
      "LTROW CANDIDATES n=1 pairs=7:0.6988",
      "LTROW CANDIDATES n=0 pairs=-",
    ],
    enrichTranscript: [
      "LTROW MERGE-ENRICH rowId=31 enrich=rewrite why=pass s=On Windows bash, discard output to /dev/null, never nul i=Prefer /dev/null over nul when discarding output on Windows bash m=On Windows bash, prefer /dev/null over nul when discarding output — nul is a no-op",
    ],
    skipTranscript: [],
    signalDetail: [
      {
        sessionPath: "/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl", signalIndex: 0,
        signal: "Use the search_query: prefix for query-kind embeddings, not document",
        candidates: [{ id: 14, item: "Embeddings use the search_query: prefix for queries, document for rows", similarity: 0.7311 }],
        outcome: { kind: "decision", action: "match", rowId: 14, by: "llm", enrich: "none" },
      },
      {
        sessionPath: "/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl", signalIndex: 1,
        signal: "Row store dedupe keeps the higher-scored row and bumps it; ties keep the lower id",
        candidates: [],
        outcome: { kind: "decision", action: "new", by: "engine", enrich: "none" },
      },
      {
        sessionPath: "/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl", signalIndex: 2,
        signal: "Prefer /dev/null over nul when discarding output on Windows bash",
        candidates: [{ id: 31, item: "On Windows bash, discard output to /dev/null, never nul", similarity: 0.692 }],
        outcome: { kind: "decision", action: "match", rowId: 31, by: "llm", enrich: "rewrite" },
      },
      {
        sessionPath: "/x/2026-08-29T14-30-00Z_e5f6a7b8.jsonl", signalIndex: 0,
        signal: "npx is acceptable for one-off patch regeneration; the local-CLI rule is for committed patches",
        candidates: [{ id: 7, item: "Only use npx for packages absent from node_modules", similarity: 0.6988 }],
        outcome: { kind: "decision", action: "contradict", rowId: 7, by: "llm", enrich: "none" },
      },
      {
        sessionPath: "/x/2026-08-29T14-30-00Z_e5f6a7b8.jsonl", signalIndex: 1,
        signal: "Use /dev/null, not nul, to discard output in Windows bash",
        candidates: [],
        outcome: { kind: "decision", action: "new", by: "engine", enrich: "none" },
      },
    ] as RowStoreSignalDetail[],
    perSession: [
      {
        label: "2026-08-28T09-00-00Z_a1b2c3d4", chars: 48211, latencyMs: 66100, empty: false,
        opening: "goal: port the rowstore merge engine to the new embed API",
        lessons: [
          "Use the search_query: prefix for query-kind embeddings, not document",
          "Row store dedupe keeps the higher-scored row and bumps it; ties keep the lower id",
          "Prefer /dev/null over nul when discarding output on Windows bash",
        ],
      },
      {
        label: "2026-08-29T14-30-00Z_e5f6a7b8", chars: 12034, latencyMs: 47280, empty: false,
        opening: "topic: triage the patch-package failures on the pi update",
        lessons: [
          "npx is acceptable for one-off patch regeneration; the local-CLI rule is for committed patches",
          "Use /dev/null, not nul, to discard output in Windows bash",
        ],
      },
    ],
    emptySessions: [],
    contamination: [
      { label: "2026-08-29T14-30-00Z_e5f6a7b8", lesson: "Use /dev/null, not nul, to discard output in Windows bash", hit: "raw" },
    ],
    rescue: {
      sourceChars: 19776, extractCalls: 1,
      survivors: [
        { score: 45, lesson: "The 5002 embed server is spawned detached; extension code must never kill it" },
        { score: 21, lesson: "Use `node node_modules/patch-package/index.js <pkg>` (local CLI) for patch regeneration" },
        { score: null, lesson: "Prefer /dev/null over nul for output discard on Windows; the nul device is a no-op" },
      ],
    },
    latency: {
      extract: [28000, 31200, 41180],
      compare: [7200, 8900, 12400],
      merge: [5400],
    },
    pooled: [0.692, 0.6988, 0.7311],
    threshold: 0.5,
    rowstoreBefore: 146, rowstoreAfter: 147,
    integrity: {
      beforeMain: h64a, afterMain: h64a,
      beforeWal: null, afterWal: null,
      blobBefore: "blob-bytes", blobAfter: "blob-bytes",
      prodBefore: { count: 146, itemsHash: "a".repeat(64), sentinelHash: "b".repeat(64), unmergedCount: 98 },
      prodAfter: { count: 146, itemsHash: "a".repeat(64), sentinelHash: "b".repeat(64), unmergedCount: 98 },
    },
    sidecarPath: `${tmp}\\production.sha256`,
    reportPath: `${tmp}\\rowstore-lessons-dry-report.md`,
  };
}

function filledLiveAgg() {
  const tmp = "C:\\Users\\test\\AppData\\Local\\Temp\\rowstore-lessons-x7k2";
  const h64a = "9c1f3a7d4b2e8f6a0c5d7e9b3a1f8c4e6d2b9a7f5c3e1d8b4a6f0c9e2d7b5a38";
  const h64b = "b3a1f8c4e6d2b9a7f5c3e1d8b4a6f0c9e2d7b5a389c1f3a7d4b2e8f6a0c5d7e9b";
  return {
    ...filledDryAgg(),
    extractCalls: 4,
    liveMode: "rescue-replace" as const,
    secondRunDrained: 0,
    rowsCleared: 146, rescuedInserted: 12,
    clearedSidecarPath: `${tmp}\\rescue-replace-cleared-rows.json`,
    rowstoreBefore: 146, rowstoreAfter: 14,
    integrity: {
      beforeMain: h64a, afterMain: h64b,
      beforeWal: null, afterWal: null,
      blobBefore: "blob-bytes", blobAfter: "blob-bytes",
      prodBefore: { count: 146, itemsHash: "a".repeat(64), sentinelHash: "b".repeat(64), unmergedCount: 98 },
      prodAfter: { count: 14, itemsHash: "c".repeat(64), sentinelHash: "b".repeat(64), unmergedCount: 0 },
    },
    sidecarPath: `${tmp}\\production.sha256`,
    reportPath: `${tmp}\\rowstore-lessons-live-report.md`,
  };
}

// ---------------------------------------------------------------------------
// C3.5 unit describe (non-gated, default suite) — the pure helpers + constants
// of the DRY/LIVE vehicle (task 5.1). RED: these reference helpers/constants
// that do not exist yet → seen failing → GREEN when the module helpers land.
// ---------------------------------------------------------------------------

describe("rowstore-lessons vehicle — pure helpers (unit, non-gated)", () => {
  it("EXAMPLE_LESSON_1/_2 are the pinned EXTRACT prompt's two example lessons byte-for-byte", () => {
    expect(EXAMPLE_LESSON_1).toBe("Use /dev/null, not nul, to discard output in Windows bash");
    expect(EXAMPLE_LESSON_2).toBe("The 5002 embed server is spawned detached; extension code must never kill it");
    // the vehicle's frozen prompt copy carries both example lines verbatim
    // (the 1.1 prompt-shape fixture cross-checks the same against rowstore.ts)
    expect(RESCUE_EXTRACT_PROMPT_LINES).toContain(`- ${EXAMPLE_LESSON_1}`);
    expect(RESCUE_EXTRACT_PROMPT_LINES).toContain(`- ${EXAMPLE_LESSON_2}`);
  });

  it("contaminationHit — raw byte-identical to an example lesson → 'raw'", () => {
    expect(contaminationHit(EXAMPLE_LESSON_1)).toBe("raw");
    expect(contaminationHit(EXAMPLE_LESSON_2)).toBe("raw");
  });

  it("contaminationHit — identical only after normalizeLesson → 'normalized'", () => {
    expect(contaminationHit("  use /dev/null, not nul, to discard output in windows bash. ")).toBe("normalized");
    expect(contaminationHit("THE 5002 EMBED SERVER IS SPAWNED DETACHED; EXTENSION CODE MUST NEVER KILL IT")).toBe("normalized");
  });

  it("contaminationHit — otherwise unflagged", () => {
    expect(contaminationHit("an unrelated durable lesson")).toBe(null);
  });

  it("rescueRowScoreAnnotation — normalized-identical → the source row's score", () => {
    const legacy = [
      { id: 1, item: "Use /dev/null, not nul, to discard output in Windows bash", score: 3, last_seen: 10 },
      { id: 2, item: "The 5002 embed server is spawned detached; extension code must never kill it", score: 21, last_seen: 11 },
      { id: 3, item: "Unrelated row", score: 5, last_seen: 12 },
    ];
    expect(rescueRowScoreAnnotation("use /dev/null, not nul, to discard output in windows bash", legacy)).toBe(3);
  });

  it("rescueRowScoreAnnotation — raw containment either way → the score; no single source row → null (score=-)", () => {
    const legacy = [
      { id: 1, item: "Use /dev/null, not nul, to discard output in Windows bash", score: 3, last_seen: 10 },
      { id: 2, item: "The 5002 embed server is spawned detached; extension code must never kill it", score: 21, last_seen: 11 },
    ];
    // lesson contains the row's item (raw)
    expect(rescueRowScoreAnnotation("The 5002 embed server is spawned detached; extension code must never kill it; port 5002 is fixed", legacy)).toBe(21);
    // row's item contains the lesson (raw)
    expect(rescueRowScoreAnnotation("5002 embed server is spawned detached; extension code must", legacy)).toBe(21);
    // no normalized identity, no raw containment
    expect(rescueRowScoreAnnotation("a merged lesson with no source row", legacy)).toBe(null);
  });

  it("pctile — the C3 pooled formula reused (N=0 → '-'; S[floor(q*(N-1))] to 4 decimals)", () => {
    expect(pctile([], 0.5)).toBe("-");
    const s = [0.692, 0.6988, 0.7311];
    expect(pctile(s, 0)).toBe("0.6920");
    expect(pctile(s, 0.25)).toBe("0.6920");
    expect(pctile(s, 0.5)).toBe("0.6988");
    expect(pctile(s, 0.75)).toBe("0.6988");
    expect(pctile(s, 1)).toBe("0.7311");
    expect(pctile([0.7], 0.9)).toBe("0.7000");
  });

  it("serializeSidecar — §2.6 schema, stable key order, DB column names verbatim (2-row fixture, bytes pinned)", () => {
    const rows = [
      { id: 1, item: "First cleared lesson", score: 3, last_seen: 1084 },
      { id: 2, item: "Second cleared lesson", score: 1, last_seen: 1084 },
    ];
    const expected =
      '{"change":"rowstore-lessons","vehicle":"rowstore-merge-live (C3.5 LIVE, rescue-replace)",' +
      '"writtenAt":"2026-08-30T00:00:00.000Z","productionDb":"C:\\\\prod\\\\session-recall.db",' +
      '"blobBeforeSha256":"abababababababababababababababababababababababababababababababab",' +
      '"rows":[{"id":1,"item":"First cleared lesson","score":3,"last_seen":1084},' +
      '{"id":2,"item":"Second cleared lesson","score":1,"last_seen":1084}],"rowCount":2}';
    expect(
      serializeSidecar(rows, { writtenAt: "2026-08-30T00:00:00.000Z", productionDb: "C:\\prod\\session-recall.db", blobBeforeSha256: "ab".repeat(32) }),
    ).toBe(expected);
  });

  it("renderLessonDetail — the re-keyed byte shape (lessonIndex=/lesson:/enrich=; SKIP outcomes unchanged)", () => {
    expect(renderLessonDetail({
      sessionPath: "/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl", signalIndex: 0,
      signal: "Use the search_query: prefix for query-kind embeddings, not document",
      candidates: [{ id: 14, item: "Embeddings use the search_query: prefix for queries, document for rows", similarity: 0.7311 }],
      outcome: { kind: "decision", action: "match", rowId: 14, by: "llm", enrich: "none" },
    })).toEqual([
      "session=2026-08-28T09-00-00Z_a1b2c3d4 lessonIndex=0",
      "  lesson:      Use the search_query: prefix for query-kind embeddings, not document",
      "  candidates:  [14] 0.7311  Embeddings use the search_query: prefix for queries, document for rows",
      "  decision:    MATCH row=14 (by llm) enrich=none",
      "",
    ]);
    expect(renderLessonDetail({
      sessionPath: "/x/2026-08-29T14-30-00Z_e5f6a7b8.jsonl", signalIndex: 1,
      signal: "Row store dedupe keeps the higher-scored row and bumps it; ties keep the lower id",
      candidates: [],
      outcome: { kind: "decision", action: "new", by: "engine", enrich: "none" },
    })).toEqual([
      "session=2026-08-29T14-30-00Z_e5f6a7b8 lessonIndex=1",
      "  lesson:      Row store dedupe keeps the higher-scored row and bumps it; ties keep the lower id",
      "  candidates:  (none — retrieval empty or never ran)",
      "  decision:    NEW (by engine) enrich=none",
      "",
    ]);
    expect(renderLessonDetail({
      sessionPath: "/x/2026-08-29T14-30-00Z_e5f6a7b8.jsonl", signalIndex: -1,
      signal: "extract-failed", candidates: [], outcome: { kind: "skipped", reason: "timeout" },
    })).toEqual([
      "session=2026-08-29T14-30-00Z_e5f6a7b8 lessonIndex=-1",
      "  lesson:      extract-failed",
      "  candidates:  (none — retrieval empty or never ran)",
      "  decision:    SKIP reason=timeout",
      "",
    ]);
  });

  it("renderLessonDetail — the lesson-text cap (task 7.3): 400 chars on rewrite/rejected decisions, 220 otherwise (the candidate list stays 110)", () => {
    const long300 = "L".repeat(300);
    // rewrite decision → 400 cap: the 300-char lesson survives untruncated
    expect(renderLessonDetail({
      sessionPath: "/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl", signalIndex: 0,
      signal: long300,
      candidates: [{ id: 31, item: "On Windows bash, discard output to /dev/null, never nul", similarity: 0.692 }],
      outcome: { kind: "decision", action: "match", rowId: 31, by: "llm", enrich: "rewrite" },
    })[1]).toBe(`  lesson:      ${long300}`);
    const long500 = "M".repeat(500);
    // rewrite decision → 400 cap: 500 chars truncate at 399 + …
    expect(renderLessonDetail({
      sessionPath: "/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl", signalIndex: 0,
      signal: long500,
      candidates: [],
      outcome: { kind: "decision", action: "match", rowId: 31, by: "llm", enrich: "rewrite" },
    })[1]).toBe(`  lesson:      ${"M".repeat(399)}…`);
    // rejected decision → 400 cap
    expect(renderLessonDetail({
      sessionPath: "/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl", signalIndex: 0,
      signal: long500,
      candidates: [],
      outcome: { kind: "decision", action: "match", rowId: 31, by: "llm", enrich: "rejected" },
    })[1]).toBe(`  lesson:      ${"M".repeat(399)}…`);
    // a none decision → 220 cap
    expect(renderLessonDetail({
      sessionPath: "/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl", signalIndex: 0,
      signal: "N".repeat(300),
      candidates: [],
      outcome: { kind: "decision", action: "match", rowId: 14, by: "llm", enrich: "none" },
    })[1]).toBe(`  lesson:      ${"N".repeat(219)}…`);
    // the candidate list stays 110 (the full stored text is one section away in the ENRICH transcript)
    const longCand = "C".repeat(200);
    expect(renderLessonDetail({
      sessionPath: "/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl", signalIndex: 0,
      signal: "short lesson",
      candidates: [{ id: 14, item: longCand, similarity: 0.7311 }],
      outcome: { kind: "decision", action: "match", rowId: 14, by: "llm", enrich: "none" },
    })[2]).toBe(`  candidates:  [14] 0.7311  ${"C".repeat(109)}…`);
  });

  it("buildDryReport — the empty case (every list section (none); N=0 stats '-'; the §9.1 byte layout)", () => {
    expect(buildDryReport(emptyDryAgg())).toBe([
      "## ROWSTORE LESSONS DRY REPORT",
      "",
      "mode=DRY",
      "drain runs=0 sessions=0 lessons=0 marked=0 failed=0 quarantined=0 incomplete=yes",
      "extract_calls=0 chunked_sessions=0",
      "decision_histogram: match=0 new=0 contradict=0",
      "skip_histogram: embed-null=0 timeout=0 parse-fail=0",
      "enrich_histogram: rewrite=0 none=0 rejected=0",
      "empty_sessions=0/0",
      "rowstore_delta: before=0 after=0",
      "",
      "### LESSONS transcript",
      "(none)",
      "",
      "### MERGE-DECISION transcript",
      "(none)",
      "",
      "### CANDIDATES transcript",
      "(none)",
      "",
      "### MERGE-ENRICH transcript",
      "(none)",
      "",
      "### MERGE-SKIP transcript",
      "(none)",
      "",
      "### per-lesson review (human-readable)",
      "(none)",
      "",
      "### lessons extracted (per session)",
      "(none)",
      "",
      "### empty sessions",
      "(none)",
      "",
      "### contamination flags",
      "(none)",
      "",
      "### rescue section",
      "source=<long_term blob> chars=0 extract_calls=1 survivors=0",
      "(none)",
      "label: candidate lessons from the legacy KB (off-distribution gate data — not session-extraction evidence)",
      "",
      "### calibration evidence",
      "empty_rate=0/0",
      "padding_signature=no sessions_with_15plus_lessons=0",
      "match_rate=0/0 (run-4 reference: 26/118)",
      "latency_ms extract: n=0 p50=- p90=- max=-",
      "latency_ms compare: n=0 p50=- p90=- max=-",
      "latency_ms merge: n=0 p50=- p90=- max=-",
      "",
      "### similarity distribution (pooled n=0)",
      "min=- p25=- p50=- p75=- max=-",
      "above_threshold=0 below_threshold=0 threshold=0.5000",
      "",
      "### production integrity",
      `sha256 main before=${h64ZeroFixture} after=${h64ZeroFixture} status=IDENTICAL`,
      "sha256 -wal before=ABSENT after=ABSENT status=IDENTICAL",
      "blob byte-identical=yes",
      "rowstore_state: rows=IDENTICAL sentinels=IDENTICAL unmerged=NOT-REDUCED",
      "cleared_sidecar=-",
      "sidecar=/tmp/rowstore-lessons-x/production.sha256",
      "report_file=/tmp/rowstore-lessons-x/rowstore-lessons-dry-report.md",
    ].join("\n"));
  });

  it("buildDryReport — the filled case (the design §9.1 example values; per-session blocks blank-line separated)", () => {
    expect(buildDryReport(filledDryAgg())).toBe([
      "## ROWSTORE LESSONS DRY REPORT",
      "",
      "mode=DRY",
      "drain runs=1 sessions=2 lessons=5 marked=2 failed=0 quarantined=0 incomplete=no",
      "extract_calls=3 chunked_sessions=1",
      "decision_histogram: match=2 new=2 contradict=1",
      "skip_histogram: embed-null=0 timeout=0 parse-fail=0",
      "enrich_histogram: rewrite=1 none=4 rejected=0",
      "empty_sessions=0/2",
      "rowstore_delta: before=146 after=147",
      "",
      "### LESSONS transcript",
      "LTROW LESSONS n=3 session=2026-08-28T09-00-00Z_a1b2c3d4.jsonl",
      "LTROW LESSONS n=2 session=2026-08-29T14-30-00Z_e5f6a7b8.jsonl",
      "",
      "### MERGE-DECISION transcript",
      "LTROW MERGE-DECISION action=match rowId=14 top=0.7311 by=llm enrich=none",
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
      "LTROW MERGE-DECISION action=match rowId=31 top=0.6920 by=llm enrich=rewrite",
      "LTROW MERGE-DECISION action=contradict rowId=7 top=0.6988 by=llm enrich=none",
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
      "",
      "### CANDIDATES transcript",
      "LTROW CANDIDATES n=1 pairs=14:0.7311",
      "LTROW CANDIDATES n=0 pairs=-",
      "LTROW CANDIDATES n=1 pairs=31:0.6920",
      "LTROW CANDIDATES n=1 pairs=7:0.6988",
      "LTROW CANDIDATES n=0 pairs=-",
      "",
      "### MERGE-ENRICH transcript",
      "LTROW MERGE-ENRICH rowId=31 enrich=rewrite why=pass s=On Windows bash, discard output to /dev/null, never nul i=Prefer /dev/null over nul when discarding output on Windows bash m=On Windows bash, prefer /dev/null over nul when discarding output — nul is a no-op",
      "",
      "### MERGE-SKIP transcript",
      "(none)",
      "",
      "### per-lesson review (human-readable)",
      "session=2026-08-28T09-00-00Z_a1b2c3d4 lessonIndex=0",
      "  lesson:      Use the search_query: prefix for query-kind embeddings, not document",
      "  candidates:  [14] 0.7311  Embeddings use the search_query: prefix for queries, document for rows",
      "  decision:    MATCH row=14 (by llm) enrich=none",
      "",
      "session=2026-08-28T09-00-00Z_a1b2c3d4 lessonIndex=1",
      "  lesson:      Row store dedupe keeps the higher-scored row and bumps it; ties keep the lower id",
      "  candidates:  (none — retrieval empty or never ran)",
      "  decision:    NEW (by engine) enrich=none",
      "",
      "session=2026-08-28T09-00-00Z_a1b2c3d4 lessonIndex=2",
      "  lesson:      Prefer /dev/null over nul when discarding output on Windows bash",
      "  candidates:  [31] 0.6920  On Windows bash, discard output to /dev/null, never nul",
      "  decision:    MATCH row=31 (by llm) enrich=rewrite",
      "",
      "session=2026-08-29T14-30-00Z_e5f6a7b8 lessonIndex=0",
      "  lesson:      npx is acceptable for one-off patch regeneration; the local-CLI rule is for committed patches",
      "  candidates:  [7] 0.6988  Only use npx for packages absent from node_modules",
      "  decision:    CONTRADICT row=7 (by llm) enrich=none",
      "",
      "session=2026-08-29T14-30-00Z_e5f6a7b8 lessonIndex=1",
      "  lesson:      Use /dev/null, not nul, to discard output in Windows bash",
      "  candidates:  (none — retrieval empty or never ran)",
      "  decision:    NEW (by engine) enrich=none",
      "",
      "",
      "### lessons extracted (per session)",
      "session=2026-08-28T09-00-00Z_a1b2c3d4 chars=48211 latency_ms=66100 empty=no",
      "  opening: goal: port the rowstore merge engine to the new embed API",
      "  lesson: Use the search_query: prefix for query-kind embeddings, not document",
      "  lesson: Row store dedupe keeps the higher-scored row and bumps it; ties keep the lower id",
      "  lesson: Prefer /dev/null over nul when discarding output on Windows bash",
      "",
      "session=2026-08-29T14-30-00Z_e5f6a7b8 chars=12034 latency_ms=47280 empty=no",
      "  opening: topic: triage the patch-package failures on the pi update",
      "  lesson: npx is acceptable for one-off patch regeneration; the local-CLI rule is for committed patches",
      "  lesson: Use /dev/null, not nul, to discard output in Windows bash",
      "",
      "### empty sessions",
      "(none)",
      "",
      "### contamination flags",
      'session=2026-08-29T14-30-00Z_e5f6a7b8 lesson="Use /dev/null, not nul, to discard output in Windows bash" hit=raw',
      "",
      "### rescue section",
      "source=<long_term blob> chars=19776 extract_calls=1 survivors=3",
      "  [score=45] The 5002 embed server is spawned detached; extension code must never kill it",
      "  [score=21] Use `node node_modules/patch-package/index.js <pkg>` (local CLI) for patch regeneration",
      "  [score=-] Prefer /dev/null over nul for output discard on Windows; the nul device is a no-op",
      "label: candidate lessons from the legacy KB (off-distribution gate data — not session-extraction evidence)",
      "",
      "### calibration evidence",
      "empty_rate=0/2",
      "padding_signature=no sessions_with_15plus_lessons=0",
      "match_rate=2/5 (run-4 reference: 26/118)",
      "latency_ms extract: n=3 p50=31200 p90=31200 max=41180",
      "latency_ms compare: n=3 p50=8900 p90=8900 max=12400",
      "latency_ms merge: n=1 p50=5400 p90=5400 max=5400",
      "",
      "### similarity distribution (pooled n=3)",
      "min=0.6920 p25=0.6920 p50=0.6988 p75=0.6988 max=0.7311",
      "above_threshold=3 below_threshold=0 threshold=0.5000",
      "",
      "### production integrity",
      `sha256 main before=${h64aFixture} after=${h64aFixture} status=IDENTICAL`,
      "sha256 -wal before=ABSENT after=ABSENT status=IDENTICAL",
      "blob byte-identical=yes",
      "rowstore_state: rows=IDENTICAL sentinels=IDENTICAL unmerged=NOT-REDUCED",
      "cleared_sidecar=-",
      "sidecar=C:\\Users\\test\\AppData\\Local\\Temp\\rowstore-lessons-x7k2\\production.sha256",
      "report_file=C:\\Users\\test\\AppData\\Local\\Temp\\rowstore-lessons-x7k2\\rowstore-lessons-dry-report.md",
    ].join("\n"));
  });

  it("buildLiveReport — the rescue-replace filled case (rows_cleared line; the sidecar path; the §9.2 byte layout)", () => {
    expect(buildLiveReport(filledLiveAgg())).toBe([
      "## ROWSTORE LESSONS LIVE REPORT",
      "",
      "mode=LIVE live_mode=rescue-replace",
      "drain runs=1 sessions=2 lessons=5 marked=2 failed=0 quarantined=0 incomplete=no",
      "extract_calls=4 chunked_sessions=1",
      "decision_histogram: match=2 new=2 contradict=1",
      "skip_histogram: embed-null=0 timeout=0 parse-fail=0",
      "enrich_histogram: rewrite=1 none=4 rejected=0",
      "empty_sessions=0/2",
      "second_run_drained=0",
      "rowstore_delta: before=146 after=14",
      "rows_cleared=146 rescued_inserted=12",
      "",
      "### LESSONS transcript",
      "LTROW LESSONS n=3 session=2026-08-28T09-00-00Z_a1b2c3d4.jsonl",
      "LTROW LESSONS n=2 session=2026-08-29T14-30-00Z_e5f6a7b8.jsonl",
      "",
      "### MERGE-DECISION transcript",
      "LTROW MERGE-DECISION action=match rowId=14 top=0.7311 by=llm enrich=none",
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
      "LTROW MERGE-DECISION action=match rowId=31 top=0.6920 by=llm enrich=rewrite",
      "LTROW MERGE-DECISION action=contradict rowId=7 top=0.6988 by=llm enrich=none",
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
      "",
      "### CANDIDATES transcript",
      "LTROW CANDIDATES n=1 pairs=14:0.7311",
      "LTROW CANDIDATES n=0 pairs=-",
      "LTROW CANDIDATES n=1 pairs=31:0.6920",
      "LTROW CANDIDATES n=1 pairs=7:0.6988",
      "LTROW CANDIDATES n=0 pairs=-",
      "",
      "### MERGE-ENRICH transcript",
      "LTROW MERGE-ENRICH rowId=31 enrich=rewrite why=pass s=On Windows bash, discard output to /dev/null, never nul i=Prefer /dev/null over nul when discarding output on Windows bash m=On Windows bash, prefer /dev/null over nul when discarding output — nul is a no-op",
      "",
      "### MERGE-SKIP transcript",
      "(none)",
      "",
      "### per-lesson review (human-readable)",
      "session=2026-08-28T09-00-00Z_a1b2c3d4 lessonIndex=0",
      "  lesson:      Use the search_query: prefix for query-kind embeddings, not document",
      "  candidates:  [14] 0.7311  Embeddings use the search_query: prefix for queries, document for rows",
      "  decision:    MATCH row=14 (by llm) enrich=none",
      "",
      "session=2026-08-28T09-00-00Z_a1b2c3d4 lessonIndex=1",
      "  lesson:      Row store dedupe keeps the higher-scored row and bumps it; ties keep the lower id",
      "  candidates:  (none — retrieval empty or never ran)",
      "  decision:    NEW (by engine) enrich=none",
      "",
      "session=2026-08-28T09-00-00Z_a1b2c3d4 lessonIndex=2",
      "  lesson:      Prefer /dev/null over nul when discarding output on Windows bash",
      "  candidates:  [31] 0.6920  On Windows bash, discard output to /dev/null, never nul",
      "  decision:    MATCH row=31 (by llm) enrich=rewrite",
      "",
      "session=2026-08-29T14-30-00Z_e5f6a7b8 lessonIndex=0",
      "  lesson:      npx is acceptable for one-off patch regeneration; the local-CLI rule is for committed patches",
      "  candidates:  [7] 0.6988  Only use npx for packages absent from node_modules",
      "  decision:    CONTRADICT row=7 (by llm) enrich=none",
      "",
      "session=2026-08-29T14-30-00Z_e5f6a7b8 lessonIndex=1",
      "  lesson:      Use /dev/null, not nul, to discard output in Windows bash",
      "  candidates:  (none — retrieval empty or never ran)",
      "  decision:    NEW (by engine) enrich=none",
      "",
      "",
      "### similarity distribution (pooled n=3)",
      "min=0.6920 p25=0.6920 p50=0.6988 p75=0.6988 max=0.7311",
      "above_threshold=3 below_threshold=0 threshold=0.5000",
      "",
      "### production integrity",
      `sha256 main before=${h64aFixture} after=${h64bFixture} status=CHANGED`,
      "sha256 -wal before=ABSENT after=ABSENT status=IDENTICAL",
      "blob byte-identical=yes",
      "rowstore_state: rows=CHANGED sentinels=IDENTICAL unmerged=REDUCED",
      "cleared_sidecar=C:\\Users\\test\\AppData\\Local\\Temp\\rowstore-lessons-x7k2\\rescue-replace-cleared-rows.json",
      "sidecar=C:\\Users\\test\\AppData\\Local\\Temp\\rowstore-lessons-x7k2\\production.sha256",
      "report_file=C:\\Users\\test\\AppData\\Local\\Temp\\rowstore-lessons-x7k2\\rowstore-lessons-live-report.md",
    ].join("\n"));
  });

  it("buildLiveReport — the additive case (no rows_cleared line; cleared_sidecar=-)", () => {
    const report = buildLiveReport({ ...filledLiveAgg(), liveMode: "additive", rowsCleared: 0, rescuedInserted: 0, clearedSidecarPath: null });
    expect(report.startsWith("## ROWSTORE LESSONS LIVE REPORT\n\nmode=LIVE live_mode=additive\n")).toBe(true);
    expect(report).not.toContain("rows_cleared=");
    expect(report).toContain("cleared_sidecar=-");
    expect(report).toContain("second_run_drained=0");
  });

  it("parseRescueLessons — the spec §Procedure pin (Form A (none) → []; Form B '- ' lines verbatim, trailing ws trimmed; garbage → null)", () => {
    expect(parseRescueLessons("(none)")).toEqual([]);
    expect(parseRescueLessons("  (none)  \n")).toEqual([]);
    expect(parseRescueLessons("- Use /dev/null, not nul, to discard output in Windows bash   \n- Keep patch files in sync\n")).toEqual([
      "Use /dev/null, not nul, to discard output in Windows bash",
      "Keep patch files in sync",
    ]);
    expect(parseRescueLessons("Sure, here are the lessons:\n- one")).toBe(null);
    expect(parseRescueLessons("")).toBe(null);
    expect(parseRescueLessons(null)).toBe(null);
  });

  // task 7.2 — the unique per-session label (the 2026-08-30 DRY ambiguity fix).
  it("sessionLabel — main session files keep their own token (the flat <token>.jsonl shape + the <token>/session.jsonl directory shape)", () => {
    expect(sessionLabel("/x/2026-08-28T09-00-00Z_a1b2c3d4.jsonl")).toBe("2026-08-28T09-00-00Z_a1b2c3d4");
    expect(sessionLabel("C:\\Users\\test\\.pi\\agent\\sessions\\2026-08-28T09-00-00Z_a1b2c3d4\\session.jsonl")).toBe("2026-08-28T09-00-00Z_a1b2c3d4");
  });

  it("sessionLabel — subagent run sessions are disambiguated by the run segment (<parent-token>/<runUUID>/run-N) — the DRY ambiguity (102 of 106 sessions were run-0; the old first-token label gave them all the parent's)", () => {
    expect(sessionLabel("C:\\s\\2026-08-28T09-00-00Z_a1b2c3d4\\run-11111111-2222-3333-4444-555555555555\\run-0\\session.jsonl")).toBe("2026-08-28T09-00-00Z_a1b2c3d4/run-11111111-2222-3333-4444-555555555555/run-0");
    expect(sessionLabel("C:\\s\\2026-08-28T09-00-00Z_a1b2c3d4\\run-11111111-2222-3333-4444-555555555555\\run-2\\session.jsonl")).toBe("2026-08-28T09-00-00Z_a1b2c3d4/run-11111111-2222-3333-4444-555555555555/run-2");
    // the parent main session and its run session now carry DIFFERENT labels (the old derivation gave them the same one)
    const parent = sessionLabel("C:\\s\\2026-08-28T09-00-00Z_a1b2c3d4\\session.jsonl");
    const run0 = sessionLabel("C:\\s\\2026-08-28T09-00-00Z_a1b2c3d4\\run-11111111-2222-3333-4444-555555555555\\run-0\\session.jsonl");
    expect(parent).not.toBe(run0);
  });

  it("sessionLabel — no token anywhere in the path → the whole path (the old fallback)", () => {
    expect(sessionLabel("/x/named-session.jsonl")).toBe("/x/named-session.jsonl");
  });

  it("renderLessonDetail — a run-session per-lesson entry carries the unique label (correlates to exactly one session path — the per-lesson ↔ per-session-block correlation the DRY review lost)", () => {
    const lines = renderLessonDetail({
      sessionPath: "C:\\s\\2026-08-28T09-00-00Z_a1b2c3d4\\run-11111111-2222-3333-4444-555555555555\\run-0\\session.jsonl",
      signalIndex: 0,
      signal: "a lesson from a subagent run",
      candidates: [],
      outcome: { kind: "decision", action: "new", by: "engine", enrich: "none" },
    });
    expect(lines[0]).toBe("session=2026-08-28T09-00-00Z_a1b2c3d4/run-11111111-2222-3333-4444-555555555555/run-0 lessonIndex=0");
  });
});

describe.runIf(process.env.ROWSTORE_MERGE_LIVE === "1")("rowstore-merge-live — full drain against the VACUUM INTO copy", () => {
  // User-gated live gate (not CI): the timeout is a safety net above the
  // engine's own bounds (5-min per-attempt LLM watchdog × ≤2 attempts × the
  // ~60-signal backlog; MAX_RUNS = 50). A broken model surfaces in the first
  // runs — Ctrl-C is always safe: production is untouched, the copy is throwaway.
  it("engine runs against the copy only; production byte-untouched; the P7 report is printed", { timeout: 14_400_000 }, async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(logger, "log").mockImplementation(m => lines.push(m));
    const consoleSpy = vi.spyOn(console, "log"); // spy (passes through) — the user SEES the report; the test verifies it was printed
    let copyDb: any;
    try {
      // (1) Pre-reads on a read-only production handle (structurally cannot write).
      const ro = new Database(SQLITE_PATH, { readonly: true });
      const longTerm = sqliteReadLongTerm(ro);
      expect(longTerm, "long_term id=1 must exist").toBeTruthy();
      const blobBefore = longTerm!.summary;
      const before = prodFileSnapshot();
      expect(before.main, "production main file must exist").toBeTruthy();
      const prodBefore = prodRowState(ro); // rowstore-state fingerprint BEFORE (read-only handle)
      ro.close();
      const config = loadConfigOnce(REPO_ROOT);
      expect(config.useRowStore, "the vehicle writes no config — useRowStore stays false").toBe(false);

      // (2) Embed server — real embeddings (C1 semantics: probe → detached
      //     spawn on ECONNREFUSED → readiness poll; never throws).
      const status = await ensureEmbedServer(config);
      expect(status.status, `embed server not ready: ${status.reason ?? "no reason"}`).toBe("ready");

      // (3) WAL-consistent standalone snapshot from the read-only handle
      //     (the C2 mechanism verbatim — a naive file copy can miss
      //     uncommitted WAL frames).
      const tmp = mkdtempSync(join(tmpdir(), "rowstore-merge-live-"));
      const copyPath = join(tmp, "copy.db");
      const roSnap = new Database(SQLITE_PATH, { readonly: true });
      roSnap.exec(`VACUUM INTO '${copyPath}'`);
      roSnap.close();
      copyDb = new Database(copyPath); // read-write — the ONLY drain target

      const rowCount = (): number => (copyDb.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
      const rowstoreBefore = rowCount();

      // (4) Full-drain loop (design §7.3): per-iteration run-start quarantine
      //     pass (the engine is quarantine-pure — it receives excludedPaths);
      //     terminate on (a) backlog drained / (b) no progress; safety cap
      //     MAX_RUNS = 50 (≫ 60/20 = 3 expected runs).
      const MAX_RUNS = 50;
      let runs = 0;
      let drained = false;
      let signals = 0;
      let marked = 0;
      let failed = 0;
      const decisionHist: Record<"match" | "new" | "contradict", number> = { match: 0, new: 0, contradict: 0 };
      const skipHist: Record<"embed-null" | "timeout" | "parse-fail", number> = { "embed-null": 0, timeout: 0, "parse-fail": 0 };
      const decisionTranscript: string[] = [];
      const candidatesTranscript: string[] = [];
      const enrichTranscript: string[] = [];
      const skipTranscript: string[] = [];
      const pooled: number[] = [];
      const signalDetail: RowStoreSignalDetail[] = [];

      // (4a) LLM-stage forwarding (lt-conversion-live pattern): the engine's
      //      default seam resolves complete() through the vitest alias to the
      //      recording mock — forward every call to the REAL SDK so the live
      //      gate exercises the production seam end-to-end (without this, the
      //      mock's empty default fails every signal `timeout` in ~0ms).
      mockCompleteReset();
      mockCompleteSetDefault(async (call) =>
        realPiAi.complete(call.model, { messages: call.messages }, call.options as never),
      );
      while (runs < MAX_RUNS) {
        runs++;
        lines.length = 0;
        const unmerged = sqliteReadUnmergedSessionSummaries(copyDb);
        const { excludedPaths } = pruneMergeQuarantine(copyDb, unmerged, Date.now());
        const excluded = new Set(excludedPaths);
        if (unmerged.filter(s => !excluded.has(s.session_path)).length === 0) {
          drained = true;
          break; // (a) backlog drained
        }
        const res = await mergeSignalsIntoRowStore(copyDb, config, { excludedPaths });
        signals += res.signalsProcessed;
        marked += res.sessionsMarkedMerged;
        failed += res.sessionsFailed.length;
        for (const d of res.decisions) decisionHist[d.action]++;
        for (const s of res.skipped) skipHist[s.reason]++;
        signalDetail.push(...res.signalDetail);
        for (const m of lines) {
          if (m.startsWith("LTROW MERGE-DECISION ")) {
            decisionTranscript.push(m);
          } else if (m.startsWith("LTROW CANDIDATES ")) {
            candidatesTranscript.push(m);
            const pairs = m.slice(m.indexOf("pairs=") + 6);
            if (pairs !== "-") {
              const parts = pairs.split(":"); // id:sim4 pairs — sims at the odd indices
              for (let i = 1; i < parts.length; i += 2) pooled.push(Number(parts[i]));
            }
          } else if (m.startsWith("LTROW MERGE-ENRICH ")) {
            enrichTranscript.push(m);
          } else if (m.startsWith("LTROW MERGE-SKIP ")) {
            skipTranscript.push(m); // task 7.3 — closes the skip-line drop gap: skips reach the report
          }
        }
        if (res.signalsProcessed === 0 && res.sessionsMarkedMerged === 0) break; // (b) no progress
      }
      // exited via (b) or the safety cap → drained stays false → incomplete=yes

      // quarantined = sessions whose sentinel reached 3 strikes in the copy
      // (the sentinel store — the engine itself never reads it).
      const quarantined = (copyDb.prepare("SELECT value FROM meta WHERE key LIKE 'merge_quarantine:%'").all() as Array<{ value: string }>)
        .map(r => JSON.parse(r.value) as { failures: number })
        .filter(r => r.failures >= 3).length;

      const rowstoreAfter = rowCount();
      copyDb.close();

      // (5) Post-reads on a fresh read-only handle + the sidecar.
      const ro2 = new Database(SQLITE_PATH, { readonly: true });
      const longTermAfter = sqliteReadLongTerm(ro2);
      const prodAfter = prodRowState(ro2); // rowstore-state fingerprint AFTER (fresh read-only handle)
      ro2.close();
      const blobAfter = longTermAfter!.summary;
      const after = prodFileSnapshot();

      const sidecarPath = join(tmp, "production.sha256");
      const walOrAbsent = (h: string | null): string => h ?? "ABSENT";
      writeFileSync(sidecarPath, [
        `main before=${before.main}`,
        `wal before=${walOrAbsent(before.wal)}`,
        `main after=${after.main}`,
        `wal after=${walOrAbsent(after.wal)}`,
      ].join("\n") + "\n");

      // (6) Mechanical asserts — the containment guarantees (lock rule 4):
      //     the test FAILS if the vehicle wrote any rowstore state to
      //     production or if the report went unprinted. WAL bytes/presence are
      //     REPORTED, not asserted: an active Pi session legitimately writes
      //     the production DB during a run (agent_end → VCC merge); the
      //     rowstore-state fingerprints below read through the WAL, so a
      //     vehicle write — checkpointed or not — fails the test. (2026-08-31
      //     8.1 re-run #2: the old WAL byte-identity assert fired on the live
      //     session's own writes and suppressed the P7 report.)
      expect(after.main, "production main must be byte-identical before/after (or both absent)").toBe(before.main);
      expect(blobAfter, "the long_term blob must be byte-identical (C3 is copy-targeted — no production write)").toBe(blobBefore);
      expect(prodAfter.count, "production long_term_rows count must not change (the vehicle never writes production rows)").toBe(prodBefore.count);
      expect(prodAfter.itemsHash, "production long_term_rows item set must not change").toBe(prodBefore.itemsHash);
      expect(prodAfter.sentinelHash, "production merge_quarantine:* sentinel set must not change").toBe(prodBefore.sentinelHash);
      expect(prodAfter.unmergedCount, "production unmerged count must not DECREASE (the vehicle's only session_summaries write is mark-merged; the live session only adds fresh content)").toBeGreaterThanOrEqual(prodBefore.unmergedCount);

      // (7) The P7 report — exact bytes (section order; zero-rendered
      //     histograms; (none) for empty transcripts; pooled percentile
      //     formulas incl. the N = 0 case; per-lesson human-readable review;
      //     production-integrity block).
      const sorted = [...pooled].sort((a, b) => a - b);
      const N = sorted.length;
      const stat = (q: number): string => (N === 0 ? "-" : sim4(sorted[Math.floor(q * (N - 1))]));
      const threshold = config.embedRetrievalThreshold;
      const above = sorted.filter(x => x >= threshold).length; // inclusive cutoff (findCandidates parity)
      const below = N - above;
      const mainStatus = after.main === before.main ? "IDENTICAL" : "CHANGED";
      const walStatus = after.wal === before.wal ? "IDENTICAL" : "CHANGED";

      const report = [
        "## ROWSTORE MERGE LIVE REPORT",
        "",
        `drain runs=${runs} lessons=${signals} marked=${marked} failed=${failed} quarantined=${quarantined} incomplete=${drained ? "no" : "yes"}`,
        `decision_histogram: match=${decisionHist.match} new=${decisionHist.new} contradict=${decisionHist.contradict}`,
        `skip_histogram: embed-null=${skipHist["embed-null"]} timeout=${skipHist.timeout} parse-fail=${skipHist["parse-fail"]}`,
        `rowstore_delta: before=${rowstoreBefore} after=${rowstoreAfter}`,
        "",
        "### MERGE-DECISION transcript",
        decisionTranscript.length > 0 ? decisionTranscript.join("\n") : "(none)",
        "",
        "### CANDIDATES transcript",
        candidatesTranscript.length > 0 ? candidatesTranscript.join("\n") : "(none)",
        "",
        "### MERGE-ENRICH transcript",
        enrichTranscript.length > 0 ? enrichTranscript.join("\n") : "(none)",
        "",
        "### MERGE-SKIP transcript",
        skipTranscript.length > 0 ? skipTranscript.join("\n") : "(none)",
        "### per-lesson review (human-readable)",
        ...(signalDetail.length > 0 ? signalDetail.reduce((acc: string[], d) => acc.concat(renderLessonDetail(d)), []) : ["(none)"]),
        "",
        `### similarity distribution (pooled n=${N})`,
        `min=${stat(0)} p25=${stat(0.25)} p50=${stat(0.5)} p75=${stat(0.75)} max=${stat(1)}`,
        `above_threshold=${above} below_threshold=${below} threshold=${sim4(threshold)}`,
        "",
        "### production integrity",
        `sha256 main before=${before.main} after=${after.main} status=${mainStatus}`,
        `sha256 -wal before=${walOrAbsent(before.wal)} after=${walOrAbsent(after.wal)} status=${walStatus}`,
        `blob byte-identical=${blobAfter === blobBefore ? "yes" : "no"}`,
        `rowstore_state: rows=${prodAfter.count === prodBefore.count ? "IDENTICAL" : "CHANGED"} sentinels=${prodAfter.sentinelHash === prodBefore.sentinelHash ? "IDENTICAL" : "CHANGED"} unmerged=${prodAfter.unmergedCount >= prodBefore.unmergedCount ? "NOT-REDUCED" : "REDUCED"}`,
        `sidecar=${sidecarPath}`,
      ].join("\n");
      console.log(report);
      expect(consoleSpy.mock.calls.map(c => String(c[0])).join("\n"), "the P7 report must be printed (structural)").toContain("## ROWSTORE MERGE LIVE REPORT");

      // LLM-stage tripwire (2026-08-29 8.1 incident): signals processed but
      // zero MERGE-DECISION lines means the LLM stage never returned text —
      // the classic signature of the mock's empty default reaching the engine
      // (forwarding disabled). Evidence (the report above) is printed FIRST;
      // the mechanical fail comes after.
      if (signals > 0) {
        expect(
          decisionTranscript.length,
          "the LLM stage must produce >=1 MERGE-DECISION when signals were processed (all-empty LLM output — verify the real-complete() forwarding at (4a))",
        ).toBeGreaterThan(0);
      }

      // (8) Q4-confirmed PASS semantics: a non-zero quarantine count does NOT
      //     fail mechanically — full drain, all evidence, no additional
      //     rubric. The REVIEW line is the user's adjudication marker.
      if (quarantined > 0) {
        console.log(`REVIEW: ${quarantined} session(s) reached 3 consecutive failures and were quarantined in the copy — the full evidence is in the transcripts above; the user adjudicates (no mechanical fail)`);
      }
    } finally {
      logSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});
// ---------------------------------------------------------------------------
// C3.5 DRY describe (task 5.2) — ROWSTORE_LESSONS_DRY=1 (design §2.3, §9.1).
//
// The rehearsal: the FULL unmerged backlog drains through the production
// engine (the EXTRACT stage included) against a VACUUM INTO copy, then the
// rescue section runs exactly ONE EXTRACT over the production long_term blob
// (the frozen pinned prompt — off-distribution gate data). Production
// containment is ASSERTED (main sha256, blob bytes, rowstore-state
// fingerprint); the -wal line is REPORTED, not asserted (C3's incident
// rule). The §9.1 report is PRINTED (the user SEES it — the §7.1 review
// input) and written next to the copy. Re-run semantics: fresh copy per
// invocation; production is never written.
// ---------------------------------------------------------------------------
describe.runIf(process.env.ROWSTORE_LESSONS_DRY === "1")("rowstore-lessons vehicle — DRY rehearsal against the VACUUM INTO copy (ROWSTORE_LESSONS_DRY=1)", () => {
  // User-gated live gate (not CI): the timeout is a safety net above the
  // engine's own bounds (5-min DRY-calibrated EXTRACT watchdog × the per-run cap × the
  // backlog; MAX_RUNS = 100). A broken model surfaces in the first runs —
  // Ctrl-C is always safe: production is untouched, the copy is throwaway.
  it("the FULL unmerged backlog drains on the copy (run-time measured — nothing hardcodes the count); the rescue section runs ONE EXTRACT over the production blob; production byte-untouched; the §9.1 DRY report is printed + written", { timeout: 14_400_000 }, async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(logger, "log").mockImplementation(m => lines.push(m));
    const consoleSpy = vi.spyOn(console, "log"); // spy (passes through) — the user SEES the report; the test verifies it was printed
    let copyDb: any;
    try {
      // (1) Pre-reads on a read-only production handle (structurally cannot write).
      const ro = new Database(SQLITE_PATH, { readonly: true });
      const longTerm = sqliteReadLongTerm(ro);
      expect(longTerm, "long_term id=1 must exist").toBeTruthy();
      const blobBefore = longTerm!.summary;
      const before = prodFileSnapshot();
      expect(before.main, "production main file must exist").toBeTruthy();
      const prodRowsBefore = ro.prepare("SELECT id, item, score, last_seen FROM long_term_rows ORDER BY id").all() as LegacyRow[];
      const prodBefore = prodRowState(ro); // rowstore-state fingerprint BEFORE (read-only handle)
      ro.close();
      const config = loadConfigOnce(REPO_ROOT);
      expect(config.useRowStore, "the vehicle writes no config — useRowStore stays false").toBe(false);

      // (2) Embed server — real embeddings (C1 semantics: probe → detached
      //     spawn on ECONNREFUSED → readiness poll; never throws).
      const status = await ensureEmbedServer(config);
      expect(status.status, `embed server not ready: ${status.reason ?? "no reason"}`).toBe("ready");

      // (3) WAL-consistent standalone snapshot from a fresh read-only handle
      //     (the C3 mechanism — a naive file copy can miss uncommitted WAL
      //     frames).
      const tmp = mkdtempSync(join(tmpdir(), "rowstore-lessons-"));
      const copyPath = join(tmp, "copy.db");
      const roSnap = new Database(SQLITE_PATH, { readonly: true });
      roSnap.exec(`VACUUM INTO '${copyPath}'`);
      roSnap.close();
      copyDb = new Database(copyPath); // read-write — the ONLY drain target
      const rowCount = (): number => (copyDb.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
      const rowstoreBefore = rowCount();

      // (4) The drain — C3's loop re-keyed to lesson-unit (per-iteration
      //     run-start quarantine pass; the engine is quarantine-pure and
      //     receives excludedPaths; terminate on (a) backlog drained /
      //     (b) no progress; safety cap MAX_RUNS = 100). The backlog is
      //     run-time measured per iteration — NOTHING hardcodes the count
      //     (98 at writing).
      const MAX_RUNS = 100;
      let runs = 0;
      let drained = false;
      let lessons = 0;
      let marked = 0;
      let failed = 0;
      const decisionHist: Record<"match" | "new" | "contradict", number> = { match: 0, new: 0, contradict: 0 };
      const skipHist: Record<"embed-null" | "timeout" | "parse-fail", number> = { "embed-null": 0, timeout: 0, "parse-fail": 0 };
      const lessonsTranscript: string[] = [];
      const decisionTranscript: string[] = [];
      const candidatesTranscript: string[] = [];
      const enrichTranscript: string[] = [];
      const skipTranscript: string[] = [];
      const signalDetail: RowStoreSignalDetail[] = [];
      const pooled: number[] = [];
      const latency: { extract: number[]; compare: number[]; merge: number[] } = { extract: [], compare: [], merge: [] };
      let drainExtractCalls = 0;
      const startedSet = new Set<string>();
      const chunkedSet = new Set<string>();
      const perSessionMap = new Map<string, { label: string; chars: number; latencyMs: number; opening: string; lessons: string[] }>();
      const emptySessions: Array<{ label: string; chars: number }> = [];
      const contamination: Array<{ label: string; lesson: string; hit: "raw" | "normalized" }> = [];

      // The §2.3 opening pin: first line matching /goal|topic/i among the
      // first 30 lines of unmerged_fresh_content, else the first ~500 chars;
      // rendered ONE line (embedded newlines → ⏎), trimmed/capped 500 + ….
      const openingOf = (content: string): string => {
        const text = content.replace(/\r\n/g, "\n");
        const raw = text.split("\n").slice(0, 30).find(l => /goal|topic/i.test(l)) ?? text.slice(0, 500);
        const one = raw.replace(/\n/g, "⏎").trim();
        return one.length > 500 ? one.slice(0, 499) + "…" : one;
      };

      // (4a) LLM-stage forwarding (the C3 pattern carried to the new
      //      describes): the engine's default seam resolves complete()
      //      through the vitest alias to the recording mock — forward every
      //      call to the REAL SDK so the gate exercises the production seam
      //      end-to-end (without this, the mock's empty default fails every
      //      extract `timeout` in ~0ms — the 8.1 incident signature).
      mockCompleteReset();
      mockCompleteSetDefault(async (call) =>
        realPiAi.complete(call.model, { messages: call.messages }, call.options as never),
      );
      while (runs < MAX_RUNS) {
        runs++;
        lines.length = 0;
        const unmerged = sqliteReadUnmergedSessionSummaries(copyDb);
        const { excludedPaths } = pruneMergeQuarantine(copyDb, unmerged, Date.now());
        const excluded = new Set(excludedPaths);
        const available = unmerged.filter(s => !excluded.has(s.session_path));
        if (available.length === 0) {
          drained = true;
          break; // (a) backlog drained
        }
        // The engine's session selection, mirrored for per-session tracking
        // (rowstore.ts step 5 — the cap counts EXTRACT CALLS (24K chunk
        // slots), NON-STRICT `<=`, risk R1; zero-lesson sessions emit no
        // lines at all, so the vehicle must know the started set itself).
        const cap = config.lessonExtractMaxPerRun;
        const chunkChars = config.mergeChunkChars;
        let selCount = 0;
        const startedPaths: string[] = [];
        available.forEach((s, i) => {
          const chars = s.unmerged_fresh_content.length;
          const calls = chars <= chunkChars ? 1 : Math.ceil(chars / chunkChars);
          if (i === 0 || selCount + calls <= cap) { startedPaths.push(s.session_path); selCount += calls; }
        });
        const charsByPath = new Map(available.map(s => [s.session_path, s.unmerged_fresh_content]));
        // per-session entries are created BEFORE the engine call so the
        // onLlmCall latency attribution finds them.
        for (const p of startedPaths) {
          startedSet.add(p);
          const content = charsByPath.get(p) ?? "";
          if (content.length > chunkChars) chunkedSet.add(p); // the vehicle's chunk computation (design §2.3)
          if (!perSessionMap.has(p)) perSessionMap.set(p, { label: sessionLabel(p), chars: content.length, latencyMs: 0, opening: openingOf(content), lessons: [] });
        }
        const res = await mergeSignalsIntoRowStore(copyDb, config, {
          excludedPaths,
          onLlmCall: (cls, ms, sp) => { // per-attempt wall time (retries included)
            if (cls === "extract") drainExtractCalls++;
            latency[cls].push(ms);
            const entry = perSessionMap.get(sp);
            if (entry) entry.latencyMs += ms;
          },
        });
        lessons += res.signalsProcessed;
        marked += res.sessionsMarkedMerged;
        failed += res.sessionsFailed.length;
        for (const d of res.decisions) decisionHist[d.action]++;
        for (const s of res.skipped) skipHist[s.reason]++;
        signalDetail.push(...res.signalDetail);
        for (const d of res.signalDetail) {
          if (d.signal === "extract-failed") continue; // the synthetic failure marker — not an extracted lesson
          const entry = perSessionMap.get(d.sessionPath);
          if (entry) entry.lessons.push(d.signal);
          const hit = contaminationHit(d.signal); // EVERY extracted lesson (not only matches); flagged lessons FLOW ON — the user adjudicates at the review gate
          if (hit) contamination.push({ label: sessionLabel(d.sessionPath), lesson: d.signal, hit });
        }
        for (const m of lines) {
          if (m.startsWith("LTROW LESSONS ")) {
            lessonsTranscript.push(m);
          } else if (m.startsWith("LTROW MERGE-DECISION ")) {
            decisionTranscript.push(m);
          } else if (m.startsWith("LTROW CANDIDATES ")) {
            candidatesTranscript.push(m);
            const pairs = m.slice(m.indexOf("pairs=") + 6);
            if (pairs !== "-") {
              const parts = pairs.split(":"); // id:sim4 pairs — sims at the odd indices
              for (let i = 1; i < parts.length; i += 2) pooled.push(Number(parts[i]));
            }
          } else if (m.startsWith("LTROW MERGE-ENRICH ")) {
            enrichTranscript.push(m);
          } else if (m.startsWith("LTROW MERGE-SKIP ")) {
            skipTranscript.push(m); // task 7.3 — closes the skip-line drop gap: skips reach the report
          }
        }
        // Zero-lesson sessions (the decision-10 spot-check list): present in
        // the pre-run unmerged set, absent post-run (marked merged), zero
        // signalDetail entries this run → name + chars.
        const post = new Set(sqliteReadUnmergedSessionSummaries(copyDb).map(s => s.session_path));
        for (const p of startedPaths) {
          if (!post.has(p) && !res.signalDetail.some(d => d.sessionPath === p)) {
            emptySessions.push({ label: sessionLabel(p), chars: charsByPath.get(p)?.length ?? 0 });
          }
        }
        if (res.signalsProcessed === 0 && res.sessionsMarkedMerged === 0) break; // (b) no progress
      }
      // exited via (b) or the safety cap → drained stays false → incomplete=yes

      // quarantined = sessions whose sentinel reached 3 strikes in the copy
      // (the sentinel store — the engine itself never reads it).
      const quarantined = (copyDb.prepare("SELECT value FROM meta WHERE key LIKE 'merge_quarantine:%'").all() as Array<{ value: string }>)
        .map(r => JSON.parse(r.value) as { failures: number })
        .filter(r => r.failures >= 3).length;

      const rowstoreAfter = rowCount();
      copyDb.close();

      // (5) The rescue section (decision 18) — exactly ONE EXTRACT call over
      //     the production before blob: the frozen pinned prompt (the §12
      //     vehicle row's source of truth), the blob ≤ 24K at writing → one
      //     chunk, the SAME production seam as the drain (buildMergeModelPair
      //     + llmCallOnce + EXTRACT_LLM_TIMEOUT_MS, maxRetries 0). The blob is
      //     never written by any engine path.
      const pair = buildMergeModelPair();
      expect(pair, "the merge model pair must be discovered (the rescue EXTRACT runs the production seam)").toBeTruthy();
      const rescuePrompt = RESCUE_EXTRACT_PROMPT_LINES.map(l => (l === "{content}" ? blobBefore : l)).join("\n");
      const rescueText = await llmCallOnce(pair!.modelObj, pair!.apiKey, rescuePrompt, 0, {
        timeoutMs: EXTRACT_LLM_TIMEOUT_MS,
        logContext: " [rowstore]",
        summariesCount: 1,
        maxRetries: 0,
      }).then(r => r.text);
      const rescueLessons = parseRescueLessons(rescueText) ?? [];
      const survivors = rescueLessons.map(l => ({ score: rescueRowScoreAnnotation(l, prodRowsBefore), lesson: l }));

      // (6) Post-reads on a fresh read-only handle + the sidecar (C3's
      //     four-line shape — the record of the containment reading).
      const ro2 = new Database(SQLITE_PATH, { readonly: true });
      const longTermAfter = sqliteReadLongTerm(ro2);
      const prodAfter = prodRowState(ro2); // rowstore-state fingerprint AFTER (fresh read-only handle)
      ro2.close();
      const blobAfter = longTermAfter!.summary;
      const after = prodFileSnapshot();
      const sidecarPath = join(tmp, "production.sha256");
      const walOrAbsent = (h: string | null): string => h ?? "ABSENT";
      writeFileSync(sidecarPath, [
        `main before=${before.main}`,
        `wal before=${walOrAbsent(before.wal)}`,
        `main after=${after.main}`,
        `wal after=${walOrAbsent(after.wal)}`,
      ].join("\n") + "\n");

      // (7) Production containment — HARD (C3's VERIFIED assert set): the
      //     vehicle must write NO rowstore state to production. WAL
      //     bytes/presence are REPORTED, not asserted: an active Pi session
      //     legitimately writes the production DB during a run (agent_end →
      //     VCC merge); the rowstore-state fingerprints read through the WAL,
      //     so a vehicle write — checkpointed or not — fails the test (the
      //     2026-08-31 8.1 re-run #2 incident rule).
      expect(after.main, "production main must be byte-identical before/after (or both absent)").toBe(before.main);
      expect(blobAfter, "the long_term blob must be byte-identical (DRY is copy-targeted — no production write)").toBe(blobBefore);
      expect(prodAfter.count, "production long_term_rows count must not change (the vehicle never writes production rows)").toBe(prodBefore.count);
      expect(prodAfter.itemsHash, "production long_term_rows item set must not change").toBe(prodBefore.itemsHash);
      expect(prodAfter.sentinelHash, "production merge_quarantine:* sentinel set must not change").toBe(prodBefore.sentinelHash);
      expect(prodAfter.unmergedCount, "production unmerged count must not DECREASE (the drain targets the copy only)").toBeGreaterThanOrEqual(prodBefore.unmergedCount);

      // (8) The §9.1 report — the calibration evidence the user reviews
      //     before the flip. PRINTED (the console spy verifies; the user
      //     SEES it) AND written next to the copy (the §2.6 anchor).
      const reportPath = join(tmp, "rowstore-lessons-dry-report.md");
      const report = buildDryReport({
        runs, sessionsStarted: startedSet.size, lessons, marked, failed, quarantined, drained,
        extractCalls: drainExtractCalls, chunkedSessions: chunkedSet.size,
        decisionHist, skipHist,
        lessonsTranscript, decisionTranscript, candidatesTranscript,
        signalDetail,
        emptySessions,
        pooled,
        threshold: config.embedRetrievalThreshold,
        rowstoreBefore, rowstoreAfter,
        integrity: { beforeMain: before.main!, afterMain: after.main!, beforeWal: before.wal, afterWal: after.wal, blobBefore, blobAfter, prodBefore, prodAfter },
        sidecarPath, reportPath,
        perSession: [...perSessionMap.values()].map(s => ({ ...s, empty: s.lessons.length === 0 })),
        contamination,
        rescue: { sourceChars: blobBefore.length, extractCalls: 1, survivors },
        latency,
      });
      writeFileSync(reportPath, report + "\n");
      console.log(report);
      expect(consoleSpy.mock.calls.map(c => String(c[0])).join("\n"), "the §9.1 DRY report must be printed (structural)").toContain("## ROWSTORE LESSONS DRY REPORT");

      // LLM-stage tripwire (the C3 incident rule): lessons processed but zero
      // MERGE-DECISION lines means the LLM stage never returned text — the
      // classic signature of the mock's empty default reaching the engine
      // (forwarding disabled). Evidence (the report above) is printed FIRST;
      // the mechanical fail comes after.
      if (lessons > 0) {
        expect(
          decisionTranscript.length,
          "the LLM stage must produce >=1 MERGE-DECISION when lessons were processed (all-empty LLM output — verify the real-complete() forwarding at (4a))",
        ).toBeGreaterThan(0);
      }

      // Q4-confirmed PASS semantics: a non-zero quarantine count does NOT
      // fail mechanically — full drain, all evidence, no additional rubric.
      // The REVIEW line is the user's adjudication marker.
      if (quarantined > 0) {
        console.log(`REVIEW: ${quarantined} session(s) reached 3 consecutive failures and were quarantined in the copy — the full evidence is in the transcripts above; the user adjudicates (no mechanical fail)`);
      }
    } finally {
      logSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});
// ---------------------------------------------------------------------------
// C3.5 LIVE describe (task 5.3) — ROWSTORE_LESSONS_LIVE=1 +
// ROWSTORE_LESSONS_LIVE_MODE (design §2.4, §9.2).
//
// The production drain — the only production mutation in C3.5. The engine
// runs against the production DB (real writes: the backlog lessons insert;
// `match` decisions bump/enrich the legacy rows; the blob is never touched
// by any engine path). The mode is the user's choice from the DRY report —
// the vehicle FAILS FAST on a missing/invalid ROWSTORE_LESSONS_LIVE_MODE
// (never auto-selects; no default of any kind). rescue-replace is one-shot:
// the sidecar is written BEFORE a single transaction that clears the
// legacy rows and inserts the rescued + backlog lessons. The blob stays
// BYTE-IDENTICAL (hard assert, either mode); sha256 main/-wal + the
// rowstore-state fingerprint after are REPORTED (CHANGED expected — the
// §2.5 interpretation, risk R10). Re-run: a repeated LIVE invocation
// drains 0 (asserted — second_run_drained=0); a second rescue-replace run
// finds no legacy rows (empty snapshot → no sidecar, cleared_sidecar=-).
// ---------------------------------------------------------------------------
describe.runIf(process.env.ROWSTORE_LESSONS_LIVE === "1")("rowstore-lessons vehicle — LIVE production drain (ROWSTORE_LESSONS_LIVE=1 + ROWSTORE_LESSONS_LIVE_MODE)", () => {
  // User-gated live gate (not CI): the timeout is a safety net above the
  // engine's own bounds (5-min DRY-calibrated EXTRACT watchdog × the per-run cap × the
  // backlog; MAX_RUNS = 100). Ctrl-C is always safe: the drain is
  // session-atomic; the blob is never touched by any engine path.
  it("drains the FULL unmerged backlog against PRODUCTION in the user-picked mode (fail-fast on a missing/invalid mode); the blob byte-identical; a second run drains 0; the §9.2 LIVE report is printed + written", { timeout: 14_400_000 }, async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(logger, "log").mockImplementation(m => lines.push(m));
    const consoleSpy = vi.spyOn(console, "log"); // spy (passes through) — the user SEES the report; the test verifies it was printed
    let prodDb: any;
    try {
      // (1) Pre-reads on a read-only production handle + legacyRows — the
      //     full production row snapshot at start. In rescue-replace these
      //     are exactly the rows to be cleared — captured before any drain
      //     write (the drain's new rows carry fresh AUTOINCREMENT ids, never
      //     in this set).
      const ro = new Database(SQLITE_PATH, { readonly: true });
      const longTerm = sqliteReadLongTerm(ro);
      expect(longTerm, "long_term id=1 must exist").toBeTruthy();
      const blobBefore = longTerm!.summary;
      const before = prodFileSnapshot();
      expect(before.main, "production main file must exist").toBeTruthy();
      const legacyRows = ro.prepare("SELECT id, item, score, last_seen FROM long_term_rows ORDER BY id").all() as LegacyRow[];
      const prodBefore = prodRowState(ro); // rowstore-state fingerprint BEFORE (read-only handle)
      ro.close();
      const config = loadConfigOnce(REPO_ROOT);
      expect(config.useRowStore, "the vehicle writes no config — useRowStore stays false").toBe(false);

      // (2) Embed server — real embeddings (C1 semantics; never throws).
      const status = await ensureEmbedServer(config);
      expect(status.status, `embed server not ready: ${status.reason ?? "no reason"}`).toBe("ready");

      // (3) MODE VALIDATION — fail-fast, before any write: present and
      //     exactly 'additive' or 'rescue-replace'. The vehicle never
      //     auto-selects (no default of any kind — the destructive path is
      //     user-gated, the user's pick from the DRY report).
      const mode = process.env.ROWSTORE_LESSONS_LIVE_MODE;
      const validMode = mode === "additive" || mode === "rescue-replace";
      expect(validMode, `ROWSTORE_LESSONS_LIVE_MODE must be exactly 'additive' or 'rescue-replace' (got ${mode === undefined ? "undefined" : JSON.stringify(mode)}) — the vehicle never auto-selects`).toBe(true);
      const liveMode = mode as "additive" | "rescue-replace";

      // (4) The drain — the PRODUCTION engine runs (real writes — the
      //     backlog lessons insert; `match` decisions bump/enrich the legacy
      //     rows; the blob is never touched by any engine path). Same loop
      //     shape as DRY (per-iteration run-start quarantine pass; breaks
      //     (a)/(b); MAX_RUNS = 100; onLlmCall + transcript).
      const tmp = mkdtempSync(join(tmpdir(), "rowstore-lessons-"));
      prodDb = new Database(SQLITE_PATH); // read-write — the C3.5 LIVE drain target (the only production writer in C3.5)
      const rowCount = (): number => (prodDb.prepare("SELECT COUNT(*) AS c FROM long_term_rows").get() as { c: number }).c;
      const rowstoreBefore = rowCount();
      const MAX_RUNS = 100;
      let runs = 0;
      let drained = false;
      let lessons = 0;
      let marked = 0;
      let failed = 0;
      const decisionHist: Record<"match" | "new" | "contradict", number> = { match: 0, new: 0, contradict: 0 };
      const skipHist: Record<"embed-null" | "timeout" | "parse-fail", number> = { "embed-null": 0, timeout: 0, "parse-fail": 0 };
      const lessonsTranscript: string[] = [];
      const decisionTranscript: string[] = [];
      const candidatesTranscript: string[] = [];
      const enrichTranscript: string[] = [];
      const skipTranscript: string[] = [];
      const signalDetail: RowStoreSignalDetail[] = [];
      const pooled: number[] = [];
      let drainExtractCalls = 0;
      const startedSet = new Set<string>();
      const chunkedSet = new Set<string>();
      const emptySessions: Array<{ label: string; chars: number }> = [];

      // LLM-stage forwarding (the C3 pattern carried to the new describes):
      // forward every mock-routed call to the REAL SDK so the gate exercises
      // the production seam end-to-end (the 8.1 incident signature without
      // it: every extract fails `timeout` in ~0ms).
      mockCompleteReset();
      mockCompleteSetDefault(async (call) =>
        realPiAi.complete(call.model, { messages: call.messages }, call.options as never),
      );
      while (runs < MAX_RUNS) {
        runs++;
        lines.length = 0;
        const unmerged = sqliteReadUnmergedSessionSummaries(prodDb);
        const { excludedPaths } = pruneMergeQuarantine(prodDb, unmerged, Date.now());
        const excluded = new Set(excludedPaths);
        const available = unmerged.filter(s => !excluded.has(s.session_path));
        if (available.length === 0) {
          drained = true;
          break; // (a) backlog drained
        }
        // The engine's session selection, mirrored for started/chunked/
        // zero-lesson tracking (rowstore.ts step 5 — the cap counts EXTRACT
        // CALLS (24K chunk slots), NON-STRICT `<=`, risk R1; zero-lesson
        // sessions emit no lines at all).
        const cap = config.lessonExtractMaxPerRun;
        const chunkChars = config.mergeChunkChars;
        let selCount = 0;
        const startedPaths: string[] = [];
        available.forEach((s, i) => {
          const chars = s.unmerged_fresh_content.length;
          const calls = chars <= chunkChars ? 1 : Math.ceil(chars / chunkChars);
          if (i === 0 || selCount + calls <= cap) { startedPaths.push(s.session_path); selCount += calls; }
        });
        const charsByPath = new Map(available.map(s => [s.session_path, s.unmerged_fresh_content]));
        for (const p of startedPaths) {
          startedSet.add(p);
          if ((charsByPath.get(p) ?? "").length > chunkChars) chunkedSet.add(p); // the vehicle's chunk computation (design §2.3)
        }
        const res = await mergeSignalsIntoRowStore(prodDb, config, {
          excludedPaths,
          onLlmCall: (cls) => { if (cls === "extract") drainExtractCalls++; }, // per-attempt (retries included)
        });
        lessons += res.signalsProcessed;
        marked += res.sessionsMarkedMerged;
        failed += res.sessionsFailed.length;
        for (const d of res.decisions) decisionHist[d.action]++;
        for (const s of res.skipped) skipHist[s.reason]++;
        signalDetail.push(...res.signalDetail);
        for (const m of lines) {
          if (m.startsWith("LTROW LESSONS ")) {
            lessonsTranscript.push(m);
          } else if (m.startsWith("LTROW MERGE-DECISION ")) {
            decisionTranscript.push(m);
          } else if (m.startsWith("LTROW CANDIDATES ")) {
            candidatesTranscript.push(m);
            const pairs = m.slice(m.indexOf("pairs=") + 6);
            if (pairs !== "-") {
              const parts = pairs.split(":"); // id:sim4 pairs — sims at the odd indices
              for (let i = 1; i < parts.length; i += 2) pooled.push(Number(parts[i]));
            }
          } else if (m.startsWith("LTROW MERGE-ENRICH ")) {
            enrichTranscript.push(m);
          } else if (m.startsWith("LTROW MERGE-SKIP ")) {
            skipTranscript.push(m); // task 7.3 — closes the skip-line drop gap: skips reach the report
          }
        }
        // Zero-lesson sessions: present in the pre-run unmerged set, absent
        // post-run (marked merged), zero signalDetail entries this run.
        const post = new Set(sqliteReadUnmergedSessionSummaries(prodDb).map(s => s.session_path));
        for (const p of startedPaths) {
          if (!post.has(p) && !res.signalDetail.some(d => d.sessionPath === p)) {
            emptySessions.push({ label: sessionLabel(p), chars: charsByPath.get(p)?.length ?? 0 });
          }
        }
        if (res.signalsProcessed === 0 && res.sessionsMarkedMerged === 0) break; // (b) no progress
      }
      // exited via (b) or the safety cap → drained stays false → incomplete=yes

      // quarantined = sessions whose sentinel reached 3 strikes in production
      // (the sentinel store — the engine itself never reads it).
      const quarantined = (prodDb.prepare("SELECT value FROM meta WHERE key LIKE 'merge_quarantine:%'").all() as Array<{ value: string }>)
        .map(r => JSON.parse(r.value) as { failures: number })
        .filter(r => r.failures >= 3).length;

      // (5) SECOND-RUN-DRAINS-0 (hard when the drain completed) — one
      //     further engine call against production: every session is marked
      //     processed (zero-lesson sessions included) → nothing left to
      //     process.
      lines.length = 0;
      const unmerged2 = sqliteReadUnmergedSessionSummaries(prodDb);
      const { excludedPaths: excluded2 } = pruneMergeQuarantine(prodDb, unmerged2, Date.now());
      const res2 = await mergeSignalsIntoRowStore(prodDb, config, { excludedPaths: excluded2 });
      const secondRunDrained = res2.signalsProcessed;
      if (drained) {
        expect(secondRunDrained, "a repeated LIVE invocation must drain 0 (every session marked processed — zero-lesson sessions included)").toBe(0);
        expect(res2.sessionsMarkedMerged, "a repeated LIVE invocation must mark 0 (the backlog is empty)").toBe(0);
      }

      // (6) rescue-replace ONLY — the clear + rescue insert (one-shot).
      let rowsCleared = 0;
      let rescuedInserted = 0;
      let clearedSidecarPath: string | null = null;
      if (liveMode === "rescue-replace") {
        // (6a) The rescue EXTRACT over the before blob (one call, as DRY
        //      step 5 — the frozen pinned prompt; the SAME production seam).
        const pair = buildMergeModelPair();
        expect(pair, "the merge model pair must be discovered (the rescue EXTRACT runs the production seam)").toBeTruthy();
        const rescuePrompt = RESCUE_EXTRACT_PROMPT_LINES.map(l => (l === "{content}" ? blobBefore : l)).join("\n");
        const rescueText = await llmCallOnce(pair!.modelObj, pair!.apiKey, rescuePrompt, 0, {
          timeoutMs: EXTRACT_LLM_TIMEOUT_MS,
          logContext: " [rowstore]",
          summariesCount: 1,
          maxRetries: 0,
        }).then(r => r.text);
        const rescueLessons = parseRescueLessons(rescueText) ?? [];
        const survivors = rescueLessons.map(l => ({ score: rescueRowScoreAnnotation(l, legacyRows), lesson: l }));
        // Embed every survivor as a document (the engine's `new`-insert
        // pattern) BEFORE the sidecar — a pre-transaction failure leaves
        // production untouched (the engine's "no insert, no partial state"
        // fail-safe, carried).
        const embedded: Array<{ lesson: string; docEmb: number[] }> = [];
        for (const s of survivors) {
          const docEmb = await embedText(s.lesson, "document");
          if (docEmb === null) throw new Error(`rescue-replace: the document embed of a rescued lesson failed (embed server) — no writes were made: ${s.lesson}`);
          embedded.push({ lesson: s.lesson, docEmb });
        }
        // (6b) THE SIDECAR IS WRITTEN BEFORE THE CLEAR — writeFileSync
        //     (synchronous — the clear must not start before the write
        //     completes — risk R7). The sidecar is the rollback artifact;
        //     C3.5 never deletes it (C4's tracked closeout does).
        clearedSidecarPath = join(tmp, "rescue-replace-cleared-rows.json");
        writeFileSync(clearedSidecarPath, serializeSidecar(legacyRows, {
          writtenAt: new Date().toISOString(),
          productionDb: SQLITE_PATH,
          blobBeforeSha256: createHash("sha256").update(blobBefore).digest("hex"),
        }));
        // (6c) A SINGLE TRANSACTION: DELETE every legacyRows id + insertRow
        //     each rescued lesson (score: 1, lastSeen: the run's
        //     sessionCount — the second run's, the last measured value).
        const rescueSessionCount = res2.sessionCount;
        prodDb.transaction(() => {
          for (const r of legacyRows) prodDb.prepare("DELETE FROM long_term_rows WHERE id = ?").run(r.id);
          for (const e of embedded) insertRow(prodDb, { item: e.lesson, score: 1, lastSeen: rescueSessionCount, embedding: e.docEmb });
        })();
        rowsCleared = legacyRows.length;
        rescuedInserted = embedded.length;
      }

      // (7) Post-reads + asserts.
      const ro2 = new Database(SQLITE_PATH, { readonly: true });
      const longTermAfter = sqliteReadLongTerm(ro2);
      const prodAfter = prodRowState(ro2); // rowstore-state fingerprint AFTER (fresh read-only handle)
      const idsAfter = new Set(((ro2.prepare("SELECT id FROM long_term_rows").all()) as Array<{ id: number }>).map(r => r.id));
      ro2.close();
      const blobAfter = longTermAfter!.summary;
      const after = prodFileSnapshot();

      // The production.sha256 sidecar (C3's four-line shape) — the after
      // values legitimately differ after a drain that wrote rows; the
      // sidecar is the record (the §2.5 interpretation, risk R10).
      const sidecarPath = join(tmp, "production.sha256");
      const walOrAbsent = (h: string | null): string => h ?? "ABSENT";
      writeFileSync(sidecarPath, [
        `main before=${before.main}`,
        `wal before=${walOrAbsent(before.wal)}`,
        `main after=${after.main}`,
        `wal after=${walOrAbsent(after.wal)}`,
      ].join("\n") + "\n");

      // HARD, either mode: the blob BYTE-IDENTICAL after the drain.
      expect(blobAfter, "the long_term blob must be BYTE-IDENTICAL after the LIVE drain (hard assert, either mode — the blob is never touched by any engine path)").toBe(blobBefore);

      // rescue-replace MECHANICAL asserts (hard) — the recovery chain.
      if (liveMode === "rescue-replace") {
        expect(existsSync(clearedSidecarPath!), "the rescue-replace sidecar must exist (written BEFORE the clear — risk R7)").toBe(true);
        const sidecar = JSON.parse(readFileSync(clearedSidecarPath!, "utf8")) as { rowCount: number; rows: LegacyRow[] };
        expect(sidecar.rowCount, "the sidecar rowCount must equal the legacyRows count").toBe(legacyRows.length);
        expect(sidecar.rows, "the sidecar rows must be the pre-clear snapshot (the recovery chain)").toEqual(legacyRows);
        expect(legacyRows.filter(r => idsAfter.has(r.id)).map(r => r.id), "every legacy id must be ABSENT from production after the rescue-replace clear").toEqual([]);
      }

      // (8) The §9.2 report — printed + written; the cleared_sidecar= line
      //     records the absolute sidecar path (rescue-replace) or -
      //     (additive).
      const reportPath = join(tmp, "rowstore-lessons-live-report.md");
      const report = buildLiveReport({
        runs, sessionsStarted: startedSet.size, lessons, marked, failed, quarantined, drained,
        extractCalls: drainExtractCalls, chunkedSessions: chunkedSet.size,
        decisionHist, skipHist,
        lessonsTranscript, decisionTranscript, candidatesTranscript,
        signalDetail,
        emptySessions,
        pooled,
        threshold: config.embedRetrievalThreshold,
        rowstoreBefore, rowstoreAfter: rowCount(),
        integrity: { beforeMain: before.main!, afterMain: after.main!, beforeWal: before.wal, afterWal: after.wal, blobBefore, blobAfter, prodBefore, prodAfter },
        sidecarPath, reportPath,
        liveMode,
        secondRunDrained,
        rowsCleared, rescuedInserted,
        clearedSidecarPath,
      });
      writeFileSync(reportPath, report + "\n");
      console.log(report);
      expect(consoleSpy.mock.calls.map(c => String(c[0])).join("\n"), "the §9.2 LIVE report must be printed (structural)").toContain("## ROWSTORE LESSONS LIVE REPORT");

      // The report's rows_cleared / rescued_inserted must match the actual
      // transaction (rescue-replace only — the report renders that line
      // only in that mode).
      if (liveMode === "rescue-replace") {
        expect(report).toContain(`rows_cleared=${rowsCleared} rescued_inserted=${rescuedInserted}`);
      }

      // LLM-stage tripwire (the C3 incident rule carried): lessons
      // processed but zero MERGE-DECISION lines means the LLM stage never
      // returned text (forwarding disabled). Evidence is printed FIRST.
      if (lessons > 0) {
        expect(
          decisionTranscript.length,
          "the LLM stage must produce >=1 MERGE-DECISION when lessons were processed (all-empty LLM output — verify the real-complete() forwarding)",
        ).toBeGreaterThan(0);
      }

      // Q4-confirmed PASS semantics: a non-zero quarantine count does NOT
      // fail mechanically — the REVIEW line is the user's adjudication
      // marker.
      if (quarantined > 0) {
        console.log(`REVIEW: ${quarantined} session(s) reached 3 consecutive failures and were quarantined in PRODUCTION — the full evidence is in the transcripts above; the user adjudicates (no mechanical fail)`);
      }
      prodDb.close();
      prodDb = null;
    } finally {
      if (prodDb) prodDb.close();
      logSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});
