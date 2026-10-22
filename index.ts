import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Database as BetterSqliteDb } from "better-sqlite3";
import { loadConfigOnce, CACHE_DIR, type SessionRecallConfig } from "./config.js";
import { discoverSessions, SQLITE_PATH, matchesIgnorePatterns } from "./discoverer.js";
import { combineContextForInjection, recentCorrectionsSection, getPrimaryModel, readLongTerm, getLlmStats, shouldSkipByTime, openCacheDb, sqliteReadUnmergedSessionSummaries, mergeSessionSummary, sqliteAppendUnmergedFreshContent, sqliteReadUnmergedContentByPaths, packMergeChunks, runMergeFold, runLtTableConversion, pruneMergeQuarantine, sqliteCountUnmergedSessions, effectiveMergeIntervalMs, sqliteGetMeta, sqliteSetMeta, buildMergeModelPair, waitForLlmEndpointReady, captureSessionModel, pathBasename } from "./summarizer.js";
import { ensureEmbedServer } from "./embeddings.js";
import { mergeSignalsIntoRowStore, getRowsForInjection, getRecentCorrections, ROWSTORE_LAST_FOLD_MS_KEY } from "./rowstore.js";
import { extractVccSummary } from "./vcc/index.js";
import { log, getRecentLogLines, rotateLogs } from "./logger.js";
import { G } from "./types.js"; // Typed globalThis accessor

// Extract last turn (last user message + last assistant response) from conversation
export function getLastTurn(entries: any[]): any[] {
  if (!entries || !Array.isArray(entries)) return [];
  // getBranch() returns SessionEntry[] with { type: "message", message: { role, content } }.
  // For backward compat with tests, also handle flat { role, content } objects.
  const msgs = entries.map(e => {
    if (e && e.type === "message" && e.message) return e.message;
    if (e && e.role) return e;
    return null;
  }).filter(Boolean);

  // Find the last user-assistant pair by scanning from the end:
  // find the last assistant, then the last user message that appears before it.
  let lastAssistant: any = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      lastAssistant = msgs[i];
      break;
    }
  }

  // If no assistant, fall back to returning the last user message (if any)
  if (!lastAssistant) {
    const lastUser = [...msgs].reverse().find(m => m.role === "user");
    return lastUser ? [lastUser] : [];
  }

  let lastUser: any = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] === lastAssistant) continue;
    if (msgs[i].role === "user") {
      lastUser = msgs[i];
      break;
    }
  }

  const result: any[] = [];
  if (lastUser) result.push(lastUser);
  result.push(lastAssistant);
  return result;
}

// ─── Correction detection (the ported Hermes two-pass regex classifier) ───────────────
// correction-recency-injection D-7: the detector lives in the capture module (index.ts)
// — detection is capture-time only; no detection in the fold path. Zero LLM / zero
// embed (D-1): pure regex — the per-turn cost is a DB append at most. The strong /
// weak / negative pattern lists are transcribed verbatim from the proposal §2 record
// (pi-hermes-memory src/constants.ts, verified 2026-09-02 against GitHub main).
// Pass order (D-2): negative patterns FIRST — a match suppresses everything (the
// false-positive guard: "no" as social filler vs "no" as correction) — then strong
// (anywhere in the message; "please don't…" / "that's not what I…" only at message
// start), then weak (the opener must START the message AND the remainder must carry a
// directive word — verbs AND plain the/that/this/it, so the weak class is aggressive).
// User-message keying is the capture's concern (D-5); this is text classification only.

// Strong patterns — fire anywhere in the message (case-insensitive).
const CORRECTION_STRONG_ANYWHERE: RegExp[] = [
  /don't do that/i,
  /not like that/i,
  /\bi said\b/i,
  /\bi told you\b/i,
  /\bwe already discussed\b/i,
];
// Strong patterns — message start only (case-insensitive).
const CORRECTION_STRONG_START: RegExp[] = [
  /^please don't/i,
  /^that's not what i\b/i,
];
// Weak openers — must start the message (case-insensitive).
const CORRECTION_WEAK_OPENERS: RegExp[] = [
  /^no\b/i,
  /^wrong\b/i,
  /^actually\b/i,
  /^stop\b/i,
];
// Directive words required after a weak correction opener (the Hermes flat list,
// restored verbatim from pi-hermes-memory src/constants.ts — the port's 9-word
// regex collapsed this, dropping 14 of the 23 words; the full set is the faithful
// extension). Matched as a single word-boundary alternation, exactly as hermes'
// hasDirectiveWord does (a flat string list + one compiled alternation, not a
// hardcoded regex — the list is the data, the alternation is built from it).
const CORRECTION_DIRECTIVE_WORDS: string[] = [
  "use", "don't", "dont", "do", "try", "make", "run", "install", "add",
  "remove", "delete", "change", "fix", "put", "set", "write", "go", "stop",
  "start", "the", "that", "this", "it",
];
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hasDirectiveWord(remainder: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const source = words.map(escapeRegexLiteral).join("|");
  return new RegExp(`\\b(${source})\\b`, "i").test(remainder);
}
// Negative patterns — checked first; suppress strong and weak alike.
const CORRECTION_NEGATIVE: RegExp[] = [
  /\bno\s+(worries|problems?|thanks?|need)\b/i,
  /\bactually\b[^.]*looks (great|perfect|good|correct|right)\b/i,
  /\bstop (there|here|for now)\b/i,
];

// Two-pass classifier over the last user message of the turn. Returns the fire class
// ("strong" / "weak") or null (not a correction). Exported for the test seam and the
// turn-end capture (task 5.1 — the capture is not part of this classifier).
export function detectCorrection(text: string): "strong" | "weak" | null {
  if (!text) return null;
  // Negative first (D-2): suppress everything.
  if (CORRECTION_NEGATIVE.some(re => re.test(text))) return null;
  // Strong — anywhere in the message.
  if (CORRECTION_STRONG_ANYWHERE.some(re => re.test(text))) return "strong";
  // Strong — message start only.
  if (CORRECTION_STRONG_START.some(re => re.test(text))) return "strong";
  // Weak — the opener starts the message AND a directive word in the remainder.
  for (const re of CORRECTION_WEAK_OPENERS) {
    const m = re.exec(text);
    if (m && hasDirectiveWord(text.slice(m[0].length).trim(), CORRECTION_DIRECTIVE_WORDS)) return "weak";
  }
  return null;
}

// ─── Turn-end correction capture (spec turns-schema R8) ─────────────────────────────
// correction-recency-injection D-5/D-7: the capture lives in the capture module
// (index.ts), keyed off the last user message of the MAIN session only — assistant /
// tool messages never key the detector, and subagent sessions (the run-N/session.jsonl
// shape the session_start skip already uses) never stamp. Zero LLM / zero embed
// (D-1): the embed / llmCall seams are accepted for seam symmetry and never invoked.
//
// Guard order (an early return means the turn was NOT evaluated — the rate-limit
// counter is untouched):
//   1. summaryAppended === false — the three-hook guard (D-5): the turn's summary
//      append did not happen (the mergeSessionSummary dedup early-return path), so
//      no second @@CORR line for an already-stamped turn is ever written and the
//      re-fire never re-evaluates.
//   2. correctionDetectionEnabled off — the D-7 kill-switch (ON by default; off →
//      no detector, no marker).
//   3. subagent session path (both separator shapes) — main-session keying only.
//
// Rate limit (D-5/F8): at most one save per 3 turns. A G.__ map keyed by session
// file (survives module reloads) counts the evaluated turns per file — the 0th and
// every 3rd evaluated turn allow a save (turns 1, 4, 7, …), and a new session file
// starts its own count at 0 (reset on a new session file).

const SUBAGENT_SESSION_PATH_RE = /\/run-\d+\/session\.jsonl/;

/** The last user message of the turn, as plain text (string content or text parts). */
function correctionTurnUserText(lastTurn: any[]): string {
  const msgs = Array.isArray(lastTurn) ? lastTurn : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((p: any) => (p && typeof p.text === "string" ? p.text : "")).join(" ");
    }
    return "";
  }
  return "";
}

export async function captureTurnEndCorrection(args: {
  db: BetterSqliteDb;
  sessionFile: string;
  lastTurn: any[];
  config: SessionRecallConfig;
  /** The three-hook guard (D-5): false = the turn's summary append did not happen
   *  (the dedup early-return path) → no marker, no re-evaluation. Absent/true = it did. */
  summaryAppended?: boolean;
  /** Seam symmetry only (D-1): never invoked at turn-end (zero LLM / zero embed). */
  embed?: (text: string, kind: string) => Promise<unknown>;
  llmCall?: (prompt: string) => Promise<unknown>;
  nowMs?: () => number;
}): Promise<{ appended: boolean }> {
  const { db, sessionFile, lastTurn, config } = args;
  // Guard 1 — the three-hook guard: an already-stamped turn is never re-stamped.
  if (args.summaryAppended === false) return { appended: false };
  // Guard 2 — the kill-switch (D-7): off → no detector, no marker, counter untouched.
  if (!config.correctionDetectionEnabled) return { appended: false };
  // Guard 3 — subagent sessions never stamp (the run-N/session.jsonl path check the
  // session_start skip already uses; both separator shapes).
  if (SUBAGENT_SESSION_PATH_RE.test(sessionFile.replace(/\\/g, "/"))) return { appended: false };

  // Rate limit (D-5/F8): evaluated turns since the file's count started, per
  // file — every evaluated turn (firing or not) consumes one count; the closure
  // is the single increment site.
  const counter = G.__sessionRecallCorrectionRateLimit__ || {};
  const n = counter[sessionFile] ?? 0;
  const saveAllowed = n % 3 === 0;
  const recordEvaluated = () => {
    counter[sessionFile] = n + 1;
    G.__sessionRecallCorrectionRateLimit__ = counter;
  };

  // User-only keying: the detector runs on the last user message of the turn.
  const userText = correctionTurnUserText(lastTurn);
  const fire = detectCorrection(userText);
  if (!fire || !saveAllowed) {
    recordEvaluated();
    return { appended: false };
  }

  // P1 / D-3 marker shape: the configured format with ${timestamp} = the capture
  // moment (ISO-8601 UTC, second precision, Z, no fractional seconds — the same
  // clock/format corrected_at stores) + the opener-stripped text (weak: exactly
  // one leading token + comma/whitespace; strong: verbatim — the stripped line is
  // what the marker — and thus the prompt — receives).
  const ts = new Date(args.nowMs ? args.nowMs() : Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const rawStripped = fire === "weak" ? userText.replace(/^\S+[,\s]+/, "") : userText;
  // Multi-line fix: the last user message routinely spans several lines (a lead line
  // + the replacement code). The marker is ONE line (the fold sweep is line-based),
  // so flatten the line breaks to single spaces + collapse runs of whitespace —
  // otherwise the correction is truncated at the first break and the continuation
  // leaks into the normal lesson stream.
  const stripped = rawStripped.replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const markerLine = config.correctionMarkerFormat.replace("${timestamp}", ts) + " " + stripped;
  sqliteAppendUnmergedFreshContent(db, sessionFile, markerLine);
  recordEvaluated();
  log(`correction-capture: session=${pathBasename(sessionFile)} stamped (${fire})`);
  return { appended: true };
}

// Last shutdown result tracking — globalThis survives module reloads
export function getLastShutdownResult() { return G.__sessionRecallLastShutdownResult__ || "Not yet run"; }
function setLastShutdownResult(result: string) { G.__sessionRecallLastShutdownResult__ = result; }

// ─── /recall-flush — user-invoked full drain of the unmerged backlog ─────────
// recall-flush-plan.md §2.2/§3.2: a thin loop that re-calls the EXISTING engine
// (mergeSignalsIntoRowStore) in bounded batches (FLUSH_EXTRACT_BATCH below)
// until the unmerged backlog is drained — no fold logic is duplicated
// anywhere. The session-start path is untouched (its call site passes no
// extractCapOverride → the config default of 4; the g9 suite pins it). NO RUN
// CAP (user decision): termination = drain to 0 / all-quarantined break / the
// no-progress defensive backstop / the busy-skip abort (10 allowed, the 11th
// aborts) / the engine-error rethrow. The 5-batch (decided 2026-09-04, user)
// exists so the FLUSH RUN line fires DURING long runs — the 2026-09-04
// 46-session flush ran 30 min with zero mid-run output under the former
// uncapped single run.
// Log lines (greppable FLUSH token, §5.2):
// FLUSH START / FLUSH RUN / FLUSH DONE / FLUSH REJECTED / FLUSH ABORT.
// The flush's per-run EXTRACT-call batch (decided 2026-09-04, user): bounded
// so FLUSH RUN is mid-run progress, not just the end. Small sessions = 1
// EXTRACT call each → ~5 sessions per batch; the engine's i===0 rule still
// starts ≥1 session per run (monotonic progress preserved).
const FLUSH_EXTRACT_BATCH = 5;
export async function runRecallFlush(opts: {
  // seams for hermetic tests — defaults are the production values
  db?: BetterSqliteDb;                 // default: openCacheDb()
  llmBusy?: <T>(fn: () => Promise<T>) => Promise<T | null>;
  sleepMs?: (ms: number) => Promise<void>;
}): Promise<string> {
  const config = loadConfigOnce(__dirname);
  if (!config.useRowStore) {
    // The flush is a row-store feature; the legacy leg is out of scope.
    log("FLUSH REJECTED reason=rowstore-off");
    return "recall-flush rejected: row-store mode is off (useRowStore: false) — the flush is a row-store feature";
  }
  // Re-entrancy — check + set SYNCHRONOUSLY before any await (the session_start
  // guard discipline): a reject path must NOT clear a flag it did not set, so the
  // set happens only after the check passes.
  if (G.__sessionRecallMergeInProgress__) {
    log("FLUSH REJECTED reason=merge-in-progress");
    return "recall-flush rejected: a merge is already in progress — try again after it completes";
  }
  G.__sessionRecallMergeInProgress__ = true;
  const sleep = opts.sleepMs ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const startedAt = Date.now();
  let remaining = 0; // last-known unmerged count (updated at every count read; the engine-error line's value)
  try {
    const db = opts.db ?? await openCacheDb();
    if (!db) {
      log("FLUSH REJECTED reason=sqlite-unavailable");
      return "recall-flush rejected: SQLite unavailable";
    }
    const embedStatus = await ensureEmbedServer(config); // session-start row-store posture: not ready → reject, no strike, monotonic
    if (embedStatus.status !== "ready") {
      log("FLUSH REJECTED reason=embed-unavailable");
      return "recall-flush rejected: the embed server is not ready (no strike — re-run once it is up)";
    }
    // Bounded LLM readiness wait (2026-10-07): the pi 1.0.x zero-retry client +
    // this box's llama-server wobble history make a fold-start TCP blip fatal —
    // wait (bounded) for the LLM endpoint to answer before the drain loop.
    const flushPair = buildMergeModelPair();
    if (flushPair) {
      const ready = await waitForLlmEndpointReady(flushPair.modelObj.baseUrl);
      // Fix 2 (2026-10-22): the endpoint never answered — refuse the flush instead
      // of draining into a run whose every LLM call fails. No strike is recorded
      // and nothing is marked, so re-running once the server is up works.
      if (ready === false) {
        log(`FLUSH REJECTED reason=llm-endpoint-unready endpoint=${flushPair.modelObj.baseUrl}`);
        return 'recall-flush rejected: the model endpoint is not answering - nothing was folded, re-run once the server is up';
      }
    }
    let totalMarked = 0;
    let totalLessons = 0;
    let quarantined = 0;
    remaining = sqliteCountUnmergedSessions(db);
    if (remaining === 0) {
      log(`FLUSH DONE remaining=0 quarantined=0 runs=0 elapsed_ms=${Date.now() - startedAt}`);
      return "recall-flush: nothing to do (0 unmerged sessions)";
    }
    log(`FLUSH START unmerged=${remaining}`);
    let run = 0;
    let busySkips = 0;
    for (;;) {
      run++; // NO run cap — runs until fully drained (user decision 2026-09-06)
      const unmerged = sqliteReadUnmergedSessionSummaries(db);
      if (unmerged.length === 0) break; // full drain
      const { excludedPaths } = pruneMergeQuarantine(db, unmerged, Date.now());
      const packable = excludedPaths.length > 0
        ? unmerged.filter(r => !excludedPaths.includes(r.session_path))
        : unmerged;
      quarantined = unmerged.length - packable.length;
      if (packable.length === 0) break; // all remaining quarantined — report REVIEW, never strike further
      const fold = await mergeSignalsIntoRowStore(db, config, {
        excludedPaths,
        extractCapOverride: FLUSH_EXTRACT_BATCH, // batched — one FLUSH RUN line per batch = mid-run progress (decided 2026-09-04)
        llmBusy: opts.llmBusy,
      });
      if (fold.llmBusySkipped) {
        busySkips++;
        if (busySkips > 10) { // 10 allowed, the 11th aborts
          remaining = sqliteCountUnmergedSessions(db);
          log(`FLUSH ABORT reason=llm-busy remaining=${remaining}`);
          return `recall-flush aborted: the LLM slot was busy ${busySkips} consecutive runs (10 allowed) — nothing was written; re-run later (remaining ${remaining})`;
        }
        await sleep(2000);
        continue;
      }
      remaining = sqliteCountUnmergedSessions(db);
      log(`FLUSH RUN ${run} marked=${fold.sessionsMarkedMerged} failed=${fold.sessionsFailed.length} deferred=${fold.deferredSessions} remaining=${remaining}`);
      totalMarked += fold.sessionsMarkedMerged;
      totalLessons += fold.signalsProcessed;
      if (fold.sessionsMarkedMerged === 0 && fold.sessionsFailed.length === 0 && fold.deferredSessions === 0) {
        // Defensive backstop (plan §4.5 — should be unreachable): an engine run
        // that started no session, struck nothing, deferred nothing makes no
        // monotonic progress — abort rather than spin.
        log(`FLUSH ABORT reason=no-progress remaining=${remaining}`);
        return `recall-flush aborted: no progress in an engine run (remaining ${remaining}) — investigate the log`;
      }
    }
    const elapsed = Date.now() - startedAt;
    log(`FLUSH DONE remaining=${remaining} quarantined=${quarantined} runs=${run} elapsed_ms=${elapsed}`);
    const review = quarantined > 0
      ? `\nREVIEW: ${quarantined} session(s) are quarantined — inspect the merge_quarantine:* sentinels (retiring-lessons.md safety gear)`
      : "";
    return `recall-flush complete: ${totalMarked} session(s) drained, ${totalLessons} lesson(s), ${quarantined} quarantined, ${remaining} remaining, ${run} run(s), ${elapsed} ms${review}`;
  } catch (err) {
    // Engine-level throw (e.g. cross-process SQLITE_BUSY, plan §4.6) — record the
    // abort with the last-known count, then rethrow: the command handler's catch
    // does the user-facing error notify. Monotonic + resumable: unprocessed
    // sessions stay unmerged; a re-invocation continues from the current count.
    log(`FLUSH ABORT reason=engine-error remaining=${remaining}`);
    throw err;
  } finally {
    G.__sessionRecallMergeInProgress__ = false;
  }
}
// One memory block per session file: the record of which session files already got
// one lives on globalThis so it survives /reload (module scope does not). It is
// bounded — past MAX_INJECTED_SESSION_RECORDS the oldest inserted session files are
// dropped, and a dropped session gets a fresh block on its next turn. That is the
// trade-off for a record that can never grow without limit; 500 short file names
// cost nothing, so the cap only guards against an unbounded process lifetime.
const MAX_INJECTED_SESSION_RECORDS = 500;

function rememberInjectedSession(sessionKey: string): void {
  const record = (G.__sessionRecallContextInjectedSessions__ ??= new Set<string>());
  record.add(sessionKey);
  while (record.size > MAX_INJECTED_SESSION_RECORDS) {
    const oldest = record.values().next().value as string;
    record.delete(oldest);
  }
}

// R4: Global singleton guard — survives module reloads (module-level vars don't)

export default function (pi: ExtensionAPI) {
  if (G.__sessionRecallLoaded__) {
    log("Extension already loaded (global guard), skipping");
    return;
  }
  G.__sessionRecallLoaded__ = true;
  log("Extension loaded");
  // Self-test on load
  (async () => {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
    try {
      const modelInfo = getPrimaryModel();
      checks.push({ name: "Model config", ok: !!modelInfo, detail: modelInfo ? `${modelInfo.provider}/${modelInfo.modelId}` : "not found" });
    } catch (e) {
      checks.push({ name: "Model config", ok: false, detail: String(e) });
    }
    try {
      const db = await openCacheDb();
      if (db) {
        const count = db.prepare("SELECT COUNT(DISTINCT session_path) as c FROM session_summaries").get() as { c: number };
        checks.push({ name: "SQLite", ok: true, detail: `${count.c} sessions indexed` });
      } else {
        checks.push({ name: "SQLite", ok: false, detail: "openCacheDb returned null" });
      }

      // Fire-and-forget migration from hash files to SQLite
      try {

      } catch { /* Migration optional — hash files still work */ }
    } catch (e) {
      checks.push({ name: "SQLite", ok: false, detail: String(e) });
    }
    try {
      const config = loadConfigOnce(__dirname);
      checks.push({ name: "Config", ok: true, detail: `scope=${config.sessionScope}` });
    } catch (e) {
      checks.push({ name: "Config", ok: false, detail: String(e) });
    }
    const failed = checks.filter(c => !c.ok);
    if (failed.length > 0) {
      log(`WARN: ${failed.map(c => `${c.name}: ${c.detail}`).join(", ")}`);
    } else {
      log(`Loaded OK (${checks.map(c => c.detail).join(", ")})`);
    }
  })();

  // Shared helper: extract last turn, run VCC pipeline, merge into session_summaries.
  // Used by agent_end, session_before_compact, and session_shutdown.
  // mergeSessionSummary dedup prevents duplicate entries.
  async function processLastTurn(ctx: any, label: string) {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) { log(`${label}: no session file`); return; }
    const sessionName = sessionFile.split(/[\\/]/).pop() || sessionFile;
    const messages = ctx.sessionManager.getBranch();
    const lastTurn = getLastTurn(messages);

    if (lastTurn.length === 0) {
      log(`${label}: session=${sessionName} no messages in last turn`);
      return;
    }

    const config = loadConfigOnce(__dirname);
    // Lesson-exclusion writer guard (2026-09-02): sessions matching
    // lessonExcludePatterns never enter the unmerged pile — no lesson
    // extraction from those projects. All three queue triggers (agent_end,
    // session_before_compact, session_shutdown) funnel through here.
    // Reporting (/recall) is unaffected — that is ignorePatterns' job.
    if (matchesIgnorePatterns(sessionFile, config.lessonExcludePatterns)) {
      log(`${label}: session=${sessionName} excluded by lessonExcludePatterns — not queued for lesson extraction`);
      return;
    }

    try {
      const freshSummary = extractVccSummary(lastTurn, {
        briefTranscriptCap: config.briefTranscriptCap,
      });

      if (!freshSummary) {
        log(`${label}: session=${sessionName} VCC extraction produced empty summary`);
        return;
      }

      // D-5 three-hook guard: predict whether mergeSessionSummary's append will
      // happen, using the SAME per-turn fingerprint its last_fresh_hash dedup
      // checks (the md5 of the fresh summary) — plus the concurrency flag, whose
      // early-return also skips the append. A re-fire that would dedup never
      // re-stamps: a second @@CORR line for an already-stamped turn is never
      // written (the hooks fire seconds-to-minutes apart with different
      // timestamps, so an exact-line dedup cannot catch the repeats — D-5).
      const freshHash = createHash("md5").update(freshSummary).digest("hex");
      const captureDb = await openCacheDb();
      const mergeInFlight = !!(G.__sessionRecallVccMerge__ || {})[sessionFile];
      const prevHashRow = captureDb
        ? (captureDb.prepare(
            "SELECT last_fresh_hash FROM session_summaries WHERE session_path = ?",
          ).get(sessionFile) as { last_fresh_hash: string | null } | undefined)
        : undefined;
      const summaryAppended = !mergeInFlight && !(prevHashRow && prevHashRow.last_fresh_hash === freshHash);

      await mergeSessionSummary(sessionFile, freshSummary, {
        briefTranscriptCap: config.briefTranscriptCap,
      });
      log(`${label}: session=${sessionName} merged VCC summary (${freshSummary.length} chars)`);

      // D-5/D-7: the turn-end correction capture — only when this turn's summary
      // append actually happened. Zero LLM / zero embed (D-1): regex + a DB append
      // at most.
      if (summaryAppended && captureDb) {
        const corr = await captureTurnEndCorrection({
          db: captureDb,
          sessionFile,
          lastTurn,
          config,
          summaryAppended,
        });
        if (corr.appended) {
          log(`${label}: session=${sessionName} correction stamped (@@CORR marker appended)`);
        }
      }
    } catch (err) {
      log(`${label}: session=${sessionName} VCC extraction/merge error (non-fatal): ${err}`);
    }
  }

  // agent_end — fires once per turn (one turn = one user prompt → agent response).
  // Extract last turn and merge into session_summaries. Hash dedup prevents duplicates.
  //
  // IMPORTANT: Use setTimeout(..., 0) (macro-task), NOT Promise.resolve().then() (micro-task).
  // agent_end fires while isStreaming=true — the streaming response may not yet be
  // flushed to the session file. A microtask runs before the next macro-task, so
  // getBranch() could return an incomplete response. setTimeout defers to the next
  // event loop turn, giving the streaming flush time to complete.
  pi.on("agent_end", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionName = sessionFile ? (sessionFile.split(/[\\/]/).pop() || sessionFile) : "unknown";
    log(`agent_end fired: session=${sessionName}`);
    setTimeout(async () => {
      try {
        await processLastTurn(ctx, "agent_end");
        setLastShutdownResult("agent_end processed");
      } catch (err) {
        log(`agent_end ERROR: ${err}`);
      }
    }, 0);
  });

  // model_select (fix 1, 2026-10-22) — the session switched models (set, cycle
  // or restore). Move the memory fold onto the new model immediately.
  pi.on("model_select", async (event, ctx) => {
    await captureSessionModel({ model: event.model ?? ctx.model, modelRegistry: ctx.modelRegistry });
  });

  // session_before_compact — safety net: same as agent_end.
  // Fires when conversation is about to be compacted (truncated for context window).
  // Hash dedup prevents storing the same summary twice.
  pi.on("session_before_compact", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionName = sessionFile ? (sessionFile.split(/[\\/]/).pop() || sessionFile) : "unknown";
    log(`session_before_compact fired: session=${sessionName}`);
    try {
      await processLastTurn(ctx, "session_before_compact");
    } catch (err) {
      log(`session_before_compact ERROR: ${err}`);
    }
  });

  // R3: before_agent_start — inject the memory block once per session (first turn).
  // The record of which session files already have a block lives on globalThis (it has
  // to survive /reload) and holds one entry per session file, so two live sessions
  // each get exactly one block instead of overwriting one shared marker.
  pi.on("before_agent_start", async (_event, ctx) => {
    // Guard: the record of session files that already got a block. The entry for the
    // current session is never dropped at shutdown, so a reloaded session gets no
    // second block. A session file that is absent from the record injects on its turn.
    const sessionFile = ctx.sessionManager.getSessionFile();
    const injectKey = sessionFile ?? "";
    const alreadyInjected = G.__sessionRecallContextInjectedSessions__;
    if (alreadyInjected && alreadyInjected.has(injectKey)) return;

    try {

      const config = loadConfigOnce(__dirname);
      const cwd = ctx.cwd;
      const sessions = await discoverSessions(config, cwd);
      if (sessions.length === 0) return;

      // R8: Dual-cache injection: long-term + short-term
      const brief = await combineContextForInjection(sessions, config, {
        readLongTerm: () => readLongTerm(),
        readUnmergedContent: async (paths) => {
          const db = await openCacheDb();
          return db ? sqliteReadUnmergedContentByPaths(db, paths) : [];
        },
        // C4 row-store leg: ONE SQL statement over long_term_rows (rank + sort +
        // byte-exact chop — getRowsForInjection). Open failure or read failure
        // degrades to [] (no LT section) and is logged — mirrors readLongTerm's
        // never-throw posture (:512-523 catches and degrades); never crashes the
        // session start; never called while useRowStore is false. The openCacheDb
        // handle is the one shared connection for the process (summarizer.ts, openCacheDb) —
        // NOT closed here, exactly as the default io's readUnmergedContent (house
        // pattern; closeCacheDb is the shutdown path).
        readLtRows: async () => {
          const db = await openCacheDb();
          if (!db) return [];
          try {
            return getRowsForInjection(db, config.longTermMaxChars);
          } catch (err) {
            log(`readLtRows: row-store read failed, no LT section: ${err}`);
            return [];
          }
        },
        // unit B (correction-recency-injection 12.1(c) / D-8): the RECENT
        // CORRECTIONS leg — mirrors the readLtRows thunk (same open-degrade +
        // never-throw posture; the degrade is SILENT — the 13.2(c) single-
        // emitter gate forbids a new log literal in unit B). Never called while
        // useRowStore is false (the composer's flag branch is its only caller).
        readRecentCorrections: async () => {
          const db = await openCacheDb();
          if (!db) return { items: [], windowDays: config.correctionWindowDays };
          try {
            return getRecentCorrections(db, config);
          } catch {
            return { items: [], windowDays: config.correctionWindowDays };
          }
        },
      });
      if (brief) {
        const sessionName = sessionFile ? (sessionFile.split(/[\\/]/).pop() || sessionFile) : "unknown";
        log(`before_agent_start: session=${sessionName} injecting brief (${brief.length} chars, ${sessions.length} sessions discovered)`);

        // Return message — set flag AFTER successful injection
        const result = {
          message: {
            customType: "session-recall-context",
            content: brief,
            display: false,
          },
        };
        rememberInjectedSession(injectKey);
        return result;
      }
    } catch (err) {
      log(`before_agent_start error: ${err}`);
    }
  });

  // session_start: kick off async LLM merge for next session's long-term context.
  // Discovers unmerged sessions, packs them into chunks, and runs the chunked merge fold,
  // and writes the updated long-term summary for the NEXT session to use.
  //
  // Subagent sessions (path contains /run-*/session.jsonl) skip the merge entirely.
  // Only the parent session is responsible for long-term memory consolidation.
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionName = sessionFile ? (sessionFile.split(/[\\/]/).pop() || sessionFile) : "unknown";
    log(`session_start fired: session=${sessionName}`);
    // Rotate logs once per session start, not per log write (per-write rotation is too expensive).
    rotateLogs();
    // Fix 1 (2026-10-22): the merge must run against the model this session is
    // using. models.json order used to decide, so a session on another provider
    // folded against a server nobody was running (90 s LLM-WAIT per attempt,
    // every lesson failed). Refresh the capture from the live context BEFORE
    // any merge work; a /model switch updates it through model_select.
    await captureSessionModel(ctx);
    // A reload re-enters this handler for a session that is already running, so the
    // merge would only duplicate work the normal gates already pace. Skip it for the
    // exact reason "reload"; every other reason (startup / new / resume / fork) keeps
    // today's path untouched.
    if (_event.reason === "reload") {
      log(`session_start: session=${sessionName} skipping merge (reason=reload)`);
      return;
    }

    // R14: Skip merge for subagent sessions.
    // Subagent sessions live at <parent-session>/<hash>/run-N/session.jsonl.
    // Only the parent session should trigger long-term memory consolidation.
    if (sessionFile && /\/run-\d+\/session\.jsonl/.test(sessionFile.replace(/\\/g, "/"))) {
      log(`session_start: session=${sessionName} subagent session, skipping merge`);
      return;
    }

    // Set the merge-in-progress flag SYNCHRONOUSLY before the microtask.
    // This prevents two rapid session_start events from both passing the guard
    // and launching concurrent merges. The flag is reset in the finally block.
    if (G.__sessionRecallMergeInProgress__) {
      log(`session_start: session=${sessionName} merge already in progress, skipping (data safe — will be merged next session_start)`);
      return;
    }
    G.__sessionRecallMergeInProgress__ = true;

    // Async merge trigger — fire-and-forget (design §3 sequence)
    Promise.resolve().then(async () => {
      try {
        // (1) Config load (once per process).
        const config = loadConfigOnce(__dirname);

        // (2) DB open moved BEFORE the throttle — the drain gate needs the unmerged count.
        const db = await openCacheDb();
        if (!db) {
          log(`session_start: session=${sessionName} SQLite unavailable, skipping merge`);
          return;
        }

        // (3) Cheap unmerged count for the drain-aware throttle gate (no row materialization —
        // the ~900KB of unmerged strings are NOT loaded when throttled).
        const unmergedCount = sqliteCountUnmergedSessions(db);

        // (4) Time throttle. LEGACY: drain-aware gate — min(drain, normal) while unmerged
        //     rows remain, normal interval after full drain; reads the long_term blob
        //     timestamp via readLongTerm(). ROWSTORE: reads the row-store-owned last-fold
        //     sentinel — the row-store leg never writes the blob, so the blob timestamp is
        //     frozen and the legacy gate never skips in row-store mode. Sentinel absent →
        //     allow the run (it stamps after the fold). No mergeDrainIntervalMs on this leg.
        if (config.useRowStore) {
          const lastFoldRaw = sqliteGetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY);
          const lastFoldMs = lastFoldRaw === null ? null : Number.parseInt(lastFoldRaw, 10);
          const intervalMs = config.longTermMinIntervalMs;
          if (lastFoldMs !== null && !Number.isNaN(lastFoldMs) && Date.now() - lastFoldMs < intervalMs) {
            const unit = intervalMs >= 3600000 ? `${(intervalMs / 3600000).toFixed(1)}h` : `${Math.round(intervalMs / 60000)}min`;
            log(`session_start: session=${sessionName} skipping row-store fold (last fold was < ${unit} ago)`);
            return;
          }
        } else if (await shouldSkipByTime(config, unmergedCount)) {
          const intervalMs = effectiveMergeIntervalMs(config, unmergedCount);
          const unit = intervalMs >= 3600000 ? `${(intervalMs / 3600000).toFixed(1)}h` : `${Math.round(intervalMs / 60000)}min`;
          log(`session_start: session=${sessionName} skipping merge (last merge was < ${unit} ago)`);
          return;
        }

        // (5) Discovery stays AFTER the throttle (expensive filesystem scan).
        const cwd = ctx.cwd;
        const sessions = await discoverSessions(config, cwd);
        if (sessions.length === 0) {
          log(`session_start: session=${sessionName} no sessions discovered`);
          return;
        }

        // (6) Unmerged rows + threshold over the TOTAL set (pre-exclusion — unchanged semantics).
        const unmergedSessions = sqliteReadUnmergedSessionSummaries(db);
        if (unmergedSessions.length === 0) {
          log(`session_start: session=${sessionName} no unmerged sessions`);
          return;
        }
        const mergeCountSum = unmergedSessions.reduce((sum, s) => sum + s.merge_count, 0);
        log(`session_start: session=${sessionName} ${unmergedSessions.length} unmerged sessions (merge_count sum=${mergeCountSum})`);
        if (mergeCountSum < config.longTermMinTurns) {
          log(`session_start: session=${sessionName} skipping merge (merge_count sum=${mergeCountSum} < ${config.longTermMinTurns} minimum, will accumulate)`);
          return;
        }

        // (7) Quarantine run-start pass (before packing): prune expired/cleared/merged
        // sentinels, exclude active ones. Threshold above intentionally uses the total.
        const { excludedPaths } = pruneMergeQuarantine(db, unmergedSessions, Date.now());
        const packable = excludedPaths.length > 0
          ? unmergedSessions.filter(r => !excludedPaths.includes(r.session_path))
          : unmergedSessions;

        // (8) Pack + fold — REPLACES the single-call path (no separate fast path; a 1-chunk
        // fold is the common steady-state case). readLongTerm() keeps the hash-file fallback
        // for the baseline (only consulted when the run actually reaches the fold).
        const longTerm = await readLongTerm();
        if (packable.length === 0) {
          log(`session_start: session=${sessionName} all unmerged sessions quarantined, nothing to merge`);
          return;
        }
        // (8.1) C3 row-store leg (rowstore-merge design §8.1 — pinned shape): replaces the
        // conversion + pack + runMergeFold block below when the flag is on. The row-store
        // path never modifies the blob: the conversion pre-step (which writes blob + meta)
        // is NOT called on this leg. Gates 1–7 (incl. the time throttle) precede this
        // branch in both modes; the flag stays false until C4's flip (lock rule 4).
        if (config.useRowStore) {
          const embedStatus = await ensureEmbedServer(config); // the legacy-leg call's status, now WIRED (was discarded)
          if (embedStatus.status !== "ready") {
            // The LTROW-SRV UNAVAILABLE line was already emitted by ensureEmbedServer itself
            // (C1 — §4.6: no second SRV line). Sessions stay unmerged — monotonic, no loss;
            // no sentinel strike (server unavailability is not a signal failure).
            // NO last-fold stamp here — the fold never ran.
            log(`session_start: session=${sessionName} row-store merge skipped (embed server unavailable)`);
            return;
          }
          // Bounded LLM readiness wait (2026-10-07): the pi 1.0.x zero-retry client +
          // this box's llama-server (5001) wobble history make a fold-start TCP blip
          // fatal (the Oct 3 / Oct 7 failed folds) — wait up to 90s for the endpoint
          // to answer before any fold work. Steady state = one fast probe, no delay.
          const mergePair = buildMergeModelPair();
          if (mergePair) {
            const ready = await waitForLlmEndpointReady(mergePair.modelObj.baseUrl);
            // Fix 2 (2026-10-22): false now means NOTHING answered at all. The old
            // behaviour ran anyway and logged 4 lessons / 0 marked / 4 failed
            // against a dead address. Skipping leaves the last-fold sentinel
            // unstamped, so the next session start retries.
            if (ready === false) {
              log(`session_start: session=${sessionName} row-store fold SKIPPED reason=llm-endpoint-unready endpoint=${mergePair.modelObj.baseUrl}`);
              return;
            }
          }
          const fold = await mergeSignalsIntoRowStore(db, config, { excludedPaths });
          if (!fold.llmBusySkipped) {
            // Stamp the row-store last-fold sentinel AFTER a real fold run. An llm-busy skip
            // did no work (no writes, nothing marked, no prune — RowStoreMergeResult.llmBusySkipped
            // is true) → do not pace a future fold on a no-op. A fold THROW above rejects the
            // await → the catch below — the stamp is never reached.
            // 2026-10-07: a fold that failed EVERY session it started (0 marked, >0 failed)
            // also does NOT stamp — stamping a no-progress failure paced the next fold out by
            // the full interval on a single transient blip. The gate treats an absent/stale
            // sentinel as allowed, so the next session start retries immediately.
            const failedWithNoProgress = fold.sessionsMarkedMerged === 0 && fold.sessionsFailed.length > 0;
            if (failedWithNoProgress) {
              log(`session_start: session=${sessionName} row-store fold no progress (${fold.sessionsFailed.length} failed, 0 marked) — last-fold sentinel NOT stamped (next session start retries)`);
            } else {
              try {
                sqliteSetMeta(db, ROWSTORE_LAST_FOLD_MS_KEY, String(Date.now()));
              } catch (stampErr) {
                log(`session_start: session=${sessionName} WARN: row-store last-fold sentinel write failed: ${stampErr} (fold unaffected)`);
              }
            }
          }
          log(`session_start: session=${sessionName} row-store fold complete: ${fold.signalsProcessed} lesson(s), ${fold.sessionsMarkedMerged} session(s) marked, ${fold.sessionsFailed.length} failed, ${fold.deferredSessions} deferred, ${fold.pruned} pruned`);
          return;
        }
        // (8.2) NEW conversion pre-step (pin P6): after the packable check, before packing.
        // Gate: !flagSet && summary non-empty && !parseScoreTables(summary).parseable.
        const conversion = await runLtTableConversion(db, longTerm, config);
        const baseline = conversion.converted ?? longTerm?.summary ?? "";
        const chunks = packMergeChunks(packable, config.mergeChunkChars);      // (8.3) unchanged call, new baseline below
        if (chunks.length === 0) {
          log(`session_start: session=${sessionName} zero chunks packed (nothing to merge)`);
          return;
        }
        // (design §7) Rowstore-embeddings C1: make sure the local embed server is up before the
        // fold. Unbound on this legacy leg (the (8.1) row-store leg above binds the status — C3); failures are
        // logged inside ensureEmbedServer and never throw, so the legacy fold path is
        // unaffected either way. Downstream of every gate incl. the subagent early-return.
        await ensureEmbedServer(config);
        // Bounded LLM readiness wait (2026-10-07) — the legacy (rollback) leg shares the
        // 5001 endpoint and the zero-retry client; same wobble protection as the row-store leg.
        const legacyPair = buildMergeModelPair();
        if (legacyPair) {
          const ready = await waitForLlmEndpointReady(legacyPair.modelObj.baseUrl);
          // Fix 2 (2026-10-22): false now means NOTHING answered at all (an
          // unreachable address gives up at once, a refused port after the short
          // window). Folding anyway only produced LLM calls that all failed. No
          // sentinel is stamped here, so the next session start retries.
          if (ready === false) {
            log(`session_start: session=${sessionName} legacy fold SKIPPED reason=llm-endpoint-unready endpoint=${legacyPair.modelObj.baseUrl}`);
            return;
          }
        }
        const fold = await runMergeFold(db, chunks, baseline, longTerm?.mergedSessions ?? [], config);
        log(`session_start: session=${sessionName} fold complete: ${fold.processedChunks}/${chunks.length} chunks, ${fold.quarantinedPaths.length} quarantined, last summary ${fold.lastSummary?.length ?? 0} chars${conversion.converted ? " (post-conversion baseline)" : ""}`);
      } catch (err) {
        log(`session_start: session=${sessionName} async merge error: ${err}`);
      } finally {
        G.__sessionRecallMergeInProgress__ = false;
      }
    });
  });

  // session_shutdown — safety net: same as agent_end.
  // Catches turns missed when shutdown race prevents agent_end from reaching the session.
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionName = sessionFile ? (sessionFile.split(/[\\/]/).pop() || sessionFile) : "unknown";
    log(`session_shutdown fired: session=${sessionName} reason=${_event.reason || 'unknown'}`);
    // pi re-reads this module and calls the factory again for the new instance
    // (/reload, or any in-process session replacement). Clearing the loaded guard
    // here — synchronously, before any await, because pi calls the factory while
    // this event is still being delivered — is what lets that next factory call
    // register its tools, commands and handlers instead of returning at the guard.
    G.__sessionRecallLoaded__ = false;
    try {
      await processLastTurn(ctx, "session_shutdown");
      setLastShutdownResult("session_shutdown processed");
    } catch (err) {
      log(`session_shutdown ERROR: session=${sessionName} ${err}`);
      setLastShutdownResult(`Error: ${err}`);
    }
    // NOTE: Do NOT call closeCacheDb() here. agent_end fires before session_shutdown
    // and schedules its cache append as a macrotask (setTimeout(..., 0)). Closing
    // the DB here would race with the pending agent_end macrotask,
    // causing silent data loss on every shutdown. The connection is shared by the whole
    // process (it lives on globalThis), so the next extension instance reuses it instead
    // of opening another one; process exit cleans up the file handle.
  });

  // Shared functions for tools and commands
  async function buildHealthOutput(): Promise<string> {
    const config = loadConfigOnce(__dirname);
    let output = "## session-recall Health\n\n";
    output += `**Config:** sessionScope=${config.sessionScope}, maxSessions=${config.maxSessions}, maxTokens=${config.maxTokens}\n`;
    output += `**LLM Config:** timeout=${config.summarizeTimeoutMs}ms (long-term merge only)\n`;
    let sqliteAvailable = false;
    try {
      const mod = await import("better-sqlite3");
      const Database = mod.default || mod;
      const db = new Database(SQLITE_PATH);
      try {
        const count = db.prepare("SELECT COUNT(DISTINCT session_path) as c FROM session_summaries").get() as { c: number };
        output += `**SQLite:** OK (${count.c} sessions indexed)\n`;

        // SQLite cache metrics (reuse same connection)
        const summariesCount = db.prepare("SELECT COUNT(*) as c FROM session_summaries").get() as { c: number };
        const totalChars = db.prepare("SELECT COALESCE(SUM(char_count), 0) as total FROM session_summaries").get() as { total: number };
        const unmergedCount = sqliteCountUnmergedSessions(db);
        const ltRow = db.prepare("SELECT id FROM long_term WHERE id = 1").get();
        const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'recall_migration_complete'").get() as { value: string } | undefined;
        const vccMetaRow = db.prepare("SELECT value FROM meta WHERE key = 'vcc_migration_complete'").get() as { value: string } | undefined;
        output += `**SQLite Cache:** summaries=${summariesCount.c}, unmerged=${unmergedCount}, total_chars=${totalChars.total}, long_term=${ltRow ? 'OK' : 'empty'}, migration=${metaRow?.value === '1' ? 'complete' : 'pending'}, vcc=${vccMetaRow?.value === '1' ? 'complete' : 'pending'}\n`;
        sqliteAvailable = true;
      } finally {
        db.close();
      }
    } catch (e) {
      output += `**SQLite:** ❌ ${e}\n`;
    }
    const modelInfo = getPrimaryModel();
    if (modelInfo) {
      output += `**Model:** ${modelInfo.provider}/${modelInfo.modelId} (${modelInfo.baseUrl})\n`;
    } else {
      output += "**Model:** ❌ No model config found\n";
    }
    const llmStats = getLlmStats();
    output += `**LLM Stats:** calls=${llmStats.calls}, ok=${llmStats.successes}, fail=${llmStats.failures}, last=${llmStats.lastResult}`;
    if (llmStats.lastLatencyMs > 0) output += ` (${llmStats.lastLatencyMs}ms)`;
    output += "\n";
    if (sqliteAvailable) {
      output += "**Cache:** SQLite\n";
    } else {
      output += "**Cache:** SQLite unavailable\n";
    }
    output += `**Last shutdown:** ${getLastShutdownResult()}\n`;
    try {
      const lines = getRecentLogLines(5);
      if (lines.length > 0) {
        output += "**Recent log:**\n" + lines.map(l => "```" + l + "```").join("\n") + "\n";
      } else {
        output += "**Recent log:** No log entries yet\n";
      }
    } catch {
      output += "**Recent log:** No log entries yet\n";
    }
    return output;
  }

  async function buildRecallOutput(cwd: string): Promise<string> {
    const config = loadConfigOnce(__dirname);
    const sessions = await discoverSessions(config, cwd);

    if (sessions.length === 0) {
      return "No recent sessions found";
    }

    // ONE row-store table read, shared by both consumers below (D-5): the
    // brief renders its score table from these rows AND the top section's
    // score-table dedup set is exactly these rows — one read, one source of
    // truth. Never read while useRowStore is false (house discipline — the
    // composer's flag branch is its only caller). Open/read failure degrades
    // to [] with the existing log literal (moved from the old thunk, not
    // renamed); the openCacheDb handle is the process-lifetime cached
    // singleton — NOT closed here (house pattern; closeCacheDb is the
    // shutdown path).
    let ltRows: Array<{ item: string; score: number; lastSeen: number }> = [];
    if (config.useRowStore) {
      const db = await openCacheDb();
      if (db) {
        try {
          ltRows = getRowsForInjection(db, config.longTermMaxChars);
        } catch (err) {
          log(`readLtRows: row-store read failed, no LT section: ${err}`);
        }
      }
    }

    // Reuse injection logic — show exactly what gets injected as context.
    // readRecentCorrections is deliberately ABSENT from this io (D-4): the
    // seam-absent D-8 degrade makes the brief's RECENT CORRECTIONS block
    // absent, so the lessons appear exactly once — at the top (no
    // double-render).
    const brief = await combineContextForInjection(sessions, config, {
      readLongTerm: () => readLongTerm(),
      readUnmergedContent: async (paths) => {
        const db = await openCacheDb();
        return db ? sqliteReadUnmergedContentByPaths(db, paths) : [];
      },
      readLtRows: async () => ltRows,
    });

    // The top section (D-1): the EXISTING RECENT CORRECTIONS render — same
    // header, safety note, bullets as the session-start injection's block —
    // fed by a DIRECT getRecentCorrections read (D-4; the thunk body is the
    // former brief-io thunk, relocated byte-identically; silent degrade).
    // One session behind by design (D-8): the fold is async at session_start.
    let lessonSection = "";
    if (config.useRowStore) {
      lessonSection = await recentCorrectionsSection(
        {
          readRecentCorrections: async () => {
            const db = await openCacheDb();
            if (!db) return { items: [], windowDays: config.correctionWindowDays };
            try {
              return getRecentCorrections(db, config);
            } catch {
              return { items: [], windowDays: config.correctionWindowDays };
            }
          },
        },
        config,
        ltRows,
      );
    }

    // The appended brief: the injection's flag-gated short-term (signal)
    // section is never shown in /recall (existing strip line, unchanged).
    let longTermOnly = "";
    if (brief) {
      longTermOnly = brief.split(/\n### (Recent Sessions|Recent Signals \(not yet merged\)|Short-term)/)[0].trim();
    }

    // Composition (D-3): top section (if any) → --- → brief (if any) →
    // pinned fallback (D-2). The render ends in "\n", so the separator case
    // is topSection + "\n---\n\n" + briefTail (one blank line before ---).
    let output = "";
    if (lessonSection) output += lessonSection;
    if (longTermOnly) output += output ? `\n---\n\n${longTermOnly}` : longTermOnly;
    if (!output) output = "No contradiction lessons or long-term context available.";

    return output;
  }

  // Tool: recall-health — programmable version of /recall-health
  pi.registerTool({
    name: "recall-health",
    label: "Recall Health",
    description:
      "Check session-recall extension health: config, SQLite, model, LLM stats, cache, and recent logs. Use for diagnostics.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const output = await buildHealthOutput();
      return { content: [{ type: "text", text: output.trim() }], details: {} as Record<string, never> };
    },
  });

  // Tool: recall — programmable version of /recall
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Show summaries of recent Pi sessions. Returns cached summaries or generates algorithmic summaries on the fly.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const output = await buildRecallOutput(ctx.cwd);
        return { content: [{ type: "text", text: output.trim() }], details: {} as Record<string, never> };
      } catch (err) {
        log(`recall tool error: ${err}`);
        return { content: [{ type: "text", text: `Error: ${err}` }], details: {} as Record<string, never> };
      }
    },
  });

  // Tool: recall_sessions — search sessions by query
  pi.registerTool({
    name: "recall_sessions",
    label: "Recall Sessions",
    description:
      "Search recent Pi sessions for context about a specific topic. Returns matching excerpts with session metadata.",
    parameters: Type.Object({
      query: Type.String({
        description: "Search term or topic to find in recent sessions",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max results to return (default: 5)",
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const config = loadConfigOnce(__dirname);
        const cwd = _ctx.cwd;
        const sessions = await discoverSessions(config, cwd);
        const query = params.query.toLowerCase();
        const limit = params.limit || 5;

        const results: Array<{ session: string; cwd: string; text: string; type: string }> = [];
        const db = await openCacheDb();

        for (const session of sessions.slice(0, 10)) {
          let summaries: string[] = [];

          // Read from session_summaries
          if (db) {
            try {
              const row = db.prepare(
                "SELECT summary FROM session_summaries WHERE session_path = ?",
              ).get(session.path) as { summary: string } | undefined;
              if (row?.summary) summaries = [row.summary];
            } catch { /* ignore */ }
          }

          // Fallback: extract from JSONL
          if (summaries.length === 0) {
            try {
              const { readFileSync } = await import("node:fs");
              const content = readFileSync(session.path, "utf-8");
              const messages: any[] = [];
              for (const line of content.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                  const obj = JSON.parse(trimmed);
                  const msg = obj.type === "message" && obj.message ? obj.message : obj;
                  if (msg && msg.role && msg.content !== undefined) messages.push(msg);
                } catch { /* skip */ }
              }
              if (messages.length > 0) {
                const summary = extractVccSummary(messages, { briefTranscriptCap: config.briefTranscriptCap });
                if (summary) summaries = [summary];
              }
            } catch { /* skip */ }
          }

          for (const text of summaries) {
            if (text.toLowerCase().includes(query)) {
              results.push({ session: pathBasename(session.path), cwd: session.cwd, text, type: "summary" });
              if (results.length >= limit) break;
            }
          }
          if (results.length >= limit) break;
        }

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No matching sessions found for query: "${params.query}"` }], details: {} as Record<string, never> };
        }

        let output = `Found ${results.length} matching result(s) for "${params.query}":\n\n`;
        for (const r of results) {
          output += `**[${r.type}]** ${r.text}\n`;
          output += `  Session: ${r.session} | CWD: ${r.cwd}\n\n`;
        }

        return { content: [{ type: "text", text: output.trim() }], details: {} as Record<string, never> };
      } catch (err) {
        log(`recall_sessions error: ${err}`);
        return { content: [{ type: "text", text: `Error searching sessions: ${err}` }], details: {} as Record<string, never> };
      }
    },
  });

  pi.registerCommand("recall", {
    description: "Show the session-start injection (long-term summary) + recent contradiction lessons (display only, not injected)",
    handler: async (_args, ctx) => {
      try {
        const output = await buildRecallOutput(ctx.cwd);
        ctx.ui.notify(output.trim());
      } catch (err) {
        log(`/recall error: ${err}`);
        ctx.ui.notify(`Error: ${err}`, "error");
      }
    },
  });

  pi.registerCommand("recall-health", {
    description: "Show session-recall health status",
    handler: async (_args, ctx) => {
      const output = await buildHealthOutput();
      ctx.ui.notify(output.trim());
    },
  });

  // Command: recall-flush — user-invoked full drain (recall-flush-plan.md §2.2).
  // USER-ONLY surface (OQ-2, decided 2026-09-06): no LLM tool twin — the LLM must
  // not be able to autonomously start a 30–90-minute full backlog drain.
  pi.registerCommand("recall-flush", {
    description:
      "Drain ALL pending unmerged sessions into the row store now (in batches of 5, bypassing the time throttle)",
    handler: async (_args, ctx) => {
      try {
        const output = await runRecallFlush({});
        ctx.ui.notify(output.trim());
      } catch (err) {
        log(`/recall-flush error: ${err}`);
        ctx.ui.notify(`Error: ${err}`, "error");
      }
    },
  });
}
