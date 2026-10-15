// correction-detector.test.ts — correction-recency-injection unit A, task 1.1 RED: the
// ported Hermes two-pass detector (the strong/weak/negative pattern lists — transcription
// source: proposal §2, verified 2026-09-02 against hermes src/constants.ts on GitHub main)
// + the turn-end correction capture (spec turns-schema R8: a user correction fires →
// exactly one @@CORR marker line; user messages only; subagent sessions excluded; the
// negative class is checked first; at most one save per 3 turns; flag off → no capture).
//
// Strict TDD: this file starts RED — the imports of the not-yet-existing exports
// (detectCorrection / captureTurnEndCorrection from index.js, the D-7 capture-module
// placement) fail at import and every fixture below is red. It goes GREEN across tasks
// 3.1 (the six config keys) + 4.1 (the two-pass detector) + 5.1 (the capture in the
// processLastTurn path).
//
// House mechanics: in-memory better-sqlite3 via createRequire (no temp files);
// vi.spyOn(logger, "log") for log capture (no capture-time log bytes are pinned here —
// the CORROW line is fold-side, task 7.1); the injected embed / llmCall seams must see
// ZERO calls at turn-end (the per-turn cost is regex-only, D-1).
//
// Seam contract (recorded for 8.2):
//   detectCorrection(text) -> "strong" | "weak" | null — the two-pass classifier;
//     negative matches suppress (checked first) -> null.
//   captureTurnEndCorrection({ db, sessionFile, lastTurn, config, summaryAppended?,
//     embed?, llmCall?, nowMs? }) -> Promise<{ appended: boolean }> — the turn-end
//     capture as reached from processLastTurn; summaryAppended=false models the
//     dedup early-return path (the three-hook guard — the turn's summary append did
//     not happen, so the marker is never written and the rate-limit counter is
//     never evaluated).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import * as logger from "../logger.js";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";
import { ensureSchema } from "../summarizer.js";
import { detectCorrection, captureTurnEndCorrection } from "../index.js";

// ─── Shared mechanics (house pattern) ────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const NOW = Date.UTC(2026, 8, 3, 12, 34, 56); // 2026-09-03T12:34:56Z — the D-2 example timestamp
const TS = "2026-09-03T12:34:56Z";
const MARKER_SHAPE = /^@@CORR \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z@@ /; // P1: ISO-8601 UTC, second precision, Z, no fractional seconds

// Unique session file per fixture — the D-5 rate-limit counter is a G.__ map keyed by
// session file, so no fixture shares a file with another (no cross-test state).
const P_FIRE = "2026-01-01T00-00-00Z_aa0001.jsonl";
const P_WEAK = "2026-01-02T00-00-00Z_aa0002.jsonl";
const P_STRONG = "2026-01-03T00-00-00Z_aa0003.jsonl";
const P_ROLES = "2026-01-04T00-00-00Z_aa0004.jsonl";
const P_SUB = "C:/Users/test/.pi/agent/sessions/abcd1234/run-3/session.jsonl";
const P_SUB_BS = "C:\\Users\\test\\.pi\\agent\\sessions\\abcd1234\\run-7\\session.jsonl";
const P_RL = "2026-01-05T00-00-00Z_aa0005.jsonl";
const P_RL2 = "2026-01-06T00-00-00Z_aa0006.jsonl";
const P_GUARD = "2026-01-07T00-00-00Z_aa0007.jsonl";
const P_OFF = "2026-01-08T00-00-00Z_aa0008.jsonl";
const P_CLOCK = "2026-01-09T00-00-00Z_aa0009.jsonl";
const P_MULTI = "2026-01-10T00-00-00Z_aa0010.jsonl"; // multi-line fixture (fresh file — the rate-limit counter is per file)

/** The zero-call seams — assert ZERO LLM / ZERO embed at turn-end (D-1). */
function makeSeams() {
  const embedCalls: Array<{ text: string; kind: string }> = [];
  const llmPrompts: string[] = [];
  const embed = async (text: string, kind: string) => { embedCalls.push({ text, kind }); return null; };
  const llmCall = async (prompt: string) => { llmPrompts.push(prompt); return null; };
  return { embed, llmCall, embedCalls, llmPrompts };
}

const configFor = (over: Partial<SessionRecallConfig> = {}): SessionRecallConfig =>
  ({ ...DEFAULT_CONFIG, ...over });

let db: any;
let logSpy: ReturnType<typeof vi.spyOn>;
const lines: string[] = [];

beforeEach(() => {
  db = new Database(":memory:");
  ensureSchema(db);
  lines.length = 0;
  logSpy = vi.spyOn(logger, "log").mockImplementation(m => lines.push(m));
});

afterEach(() => {
  logSpy.mockRestore();
  db.close();
});

/** Seed the session row the way mergeSessionSummary leaves it (the summary append has
 *  already happened — the capture only ever appends, via sqliteAppendUnmergedFreshContent). */
function seedSession(path: string, vccContent: string | null = null): void {
  db.prepare(
    "INSERT OR REPLACE INTO session_summaries (session_path, version, summary, char_count, merge_count, updated_at) VALUES (?, 1, '', 0, 0, '2026-01-01T00:00:00.000Z')",
  ).run(path);
  if (vccContent !== null) {
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run(vccContent, path);
  }
}

const unmergedOf = (path: string): string | null =>
  (db.prepare("SELECT unmerged_fresh_content FROM session_summaries WHERE session_path = ?").get(path) as any)?.unmerged_fresh_content ?? null;

const markerLines = (path: string): string[] => {
  const c = unmergedOf(path);
  return c ? c.split("\n").filter(l => l.startsWith("@@CORR ")) : [];
};

const userTurn = (user: string, assistant = "OK."): any[] =>
  [{ role: "user", content: user }, { role: "assistant", content: assistant }];

async function capture(
  path: string,
  lastTurn: any[],
  cfg: SessionRecallConfig,
  seams: ReturnType<typeof makeSeams>,
  extra: { summaryAppended?: boolean; nowMs?: () => number } = {},
) {
  return captureTurnEndCorrection({
    db,
    sessionFile: path,
    lastTurn,
    config: cfg,
    embed: seams.embed,
    llmCall: seams.llmCall,
    ...extra,
    nowMs: extra.nowMs ?? (() => NOW),
  });
}

// ─── (a) The ported Hermes pattern lists (spec R8 — the detector) ────────────────────

describe("the ported Hermes two-pass detector (strong/weak/negative, transcription source: proposal §2)", () => {
  it("strong patterns fire anywhere in the message", () => {
    expect(detectCorrection("please don't do that again")).toBe("strong");
    expect(detectCorrection("that's not like that, redo the last step")).toBe("strong");
    expect(detectCorrection("I said to use pwsh, not bash")).toBe("strong");
    expect(detectCorrection("I told you the port was 5002")).toBe("strong");
    expect(detectCorrection("We already discussed using tabs")).toBe("strong"); // case-insensitive
  });

  it("message-start strong patterns: 'please don't…' and 'that's not what I…'", () => {
    expect(detectCorrection("please don't wrap the output")).toBe("strong");
    expect(detectCorrection("that's not what I meant, I meant pwsh")).toBe("strong");
    expect(detectCorrection("so please don't wrap the output")).toBeNull(); // mid-message — not a fire
  });

  it("weak patterns must START the message AND need a directive word in the remainder", () => {
    expect(detectCorrection("no, use pwsh")).toBe("weak");
    expect(detectCorrection("Wrong guess. It should be four, not three.")).toBe("weak"); // the aggressive vector: 'wrong' + 'It'
    expect(detectCorrection("Actually, try bash first")).toBe("weak");
    expect(detectCorrection("Stop, run the tests before pushing")).toBe("weak");
    expect(detectCorrection("no, the tests passed")).toBe("weak"); // plain 'the' is a directive word
    expect(detectCorrection("yes, use pwsh")).toBeNull(); // a directive word without a weak opener
  });

  it("the restored Hermes directive words fire the weak class (the 14 words the port's 9-word regex dropped)", () => {
    expect(detectCorrection("no, install pnpm not npm")).toBe("weak");
    expect(detectCorrection("no, change the port to 5002")).toBe("weak");
    expect(detectCorrection("no, add the missing test")).toBe("weak");
    expect(detectCorrection("no, remove the global")).toBe("weak");
    expect(detectCorrection("no, delete that file")).toBe("weak");
    expect(detectCorrection("no, fix the off-by-one")).toBe("weak");
    expect(detectCorrection("no, set it to false")).toBe("weak");
    expect(detectCorrection("no, write the log first")).toBe("weak");
    expect(detectCorrection("no, go with the other option")).toBe("weak");
    expect(detectCorrection("no, put it in the temp dir")).toBe("weak");
    expect(detectCorrection("stop, start over")).toBe("weak");
    expect(detectCorrection("wrong, dont use bash")).toBe("weak");
  });

  it("negative patterns suppress everything", () => {
    expect(detectCorrection("no problem, carry on")).toBeNull();
    expect(detectCorrection("no worries, it's fine")).toBeNull();
    expect(detectCorrection("no thanks, I'm good")).toBeNull();
    expect(detectCorrection("no need to fix it")).toBeNull();
    expect(detectCorrection("thanks, actually looks great")).toBeNull();
    expect(detectCorrection("let's stop for now")).toBeNull();
    expect(detectCorrection("stop there, we're close")).toBeNull();
    expect(detectCorrection("stop here and review")).toBeNull();
  });

  it("the negative class wins over a weak positive (checked first)", () => {
    expect(detectCorrection("no, actually looks great, keep it")).toBeNull();
  });

  it("plain messages are not corrections", () => {
    expect(detectCorrection("please keep going with the build")).toBeNull();
    expect(detectCorrection("the tests all passed, ship it")).toBeNull();
    expect(detectCorrection("")).toBeNull();
  });
});

// ─── (b) Turn-end correction capture (spec R8 — the @@CORR marker append) ────────────

describe("turn-end correction capture (spec R8 — one @@CORR marker line, zero LLM / zero embed)", () => {
  it("a user correction fires the detector → exactly one marker line (P1 shape, the --- join, VCC byte-unchanged)", async () => {
    seedSession(P_FIRE, "sess line one\nsess line two");
    const seams = makeSeams();
    const res = await capture(P_FIRE, userTurn("don't do that, use pwsh not bash"), configFor(), seams);
    expect(res.appended).toBe(true);
    expect(markerLines(P_FIRE)).toEqual([`@@CORR ${TS}@@ don't do that, use pwsh not bash`]);
    expect(unmergedOf(P_FIRE)).toBe(`sess line one\nsess line two\n---\n@@CORR ${TS}@@ don't do that, use pwsh not bash`);
    expect(seams.embedCalls).toHaveLength(0);
    expect(seams.llmPrompts).toHaveLength(0);
  });

  it("weak fire: the opener strip removes exactly one leading token + comma/whitespace (P1)", async () => {
    seedSession(P_WEAK);
    const seams = makeSeams();
    await capture(P_WEAK, userTurn("no, use pwsh"), configFor(), seams);
    expect(markerLines(P_WEAK)).toEqual([`@@CORR ${TS}@@ use pwsh`]);
  });

  it("strong fire: the line is stored verbatim (no strip)", async () => {
    seedSession(P_STRONG);
    const seams = makeSeams();
    await capture(P_STRONG, userTurn("don't do that"), configFor(), seams);
    expect(markerLines(P_STRONG)).toEqual([`@@CORR ${TS}@@ don't do that`]);
  });

  it("multi-line correction: the marker is ONE line (line breaks flattened, the whole correction captured, no leak to the normal stream)", async () => {
    seedSession(P_MULTI);
    const seams = makeSeams();
    await capture(P_MULTI, userTurn("no,\nthe function should be:\nreturn x * 2"), configFor(), seams);
    // weak opener 'no' stripped; the newlines flattened to single spaces (one line).
    expect(markerLines(P_MULTI)).toEqual([`@@CORR ${TS}@@ the function should be: return x * 2`]);
  });

  it("user messages only — assistant/tool messages never key the detector", async () => {
    seedSession(P_ROLES);
    const seams = makeSeams();
    await capture(P_ROLES, [{ role: "user", content: "keep going" }, { role: "assistant", content: "don't do that" }], configFor(), seams);
    expect(markerLines(P_ROLES)).toEqual([]);
    await capture(P_ROLES, [{ role: "user", content: "what now" }, { role: "toolResult", content: "no, do that instead" }, { role: "assistant", content: "done" }], configFor(), seams);
    expect(markerLines(P_ROLES)).toEqual([]);
    await capture(P_ROLES, [{ role: "assistant", content: "no, do that" }], configFor(), seams); // no user message in the turn
    expect(markerLines(P_ROLES)).toEqual([]);
    await capture(P_ROLES, userTurn("no, use pwsh"), configFor(), seams); // the user message keys, even with a correcting assistant
    expect(markerLines(P_ROLES)).toEqual([`@@CORR ${TS}@@ use pwsh`]);
    expect(seams.embedCalls).toHaveLength(0);
    expect(seams.llmPrompts).toHaveLength(0);
  });

  it("subagent sessions are excluded (run-N/session.jsonl, both path shapes)", async () => {
    seedSession(P_SUB);
    seedSession(P_SUB_BS);
    const seams = makeSeams();
    await capture(P_SUB, userTurn("no, use pwsh"), configFor(), seams);
    expect(markerLines(P_SUB)).toEqual([]);
    await capture(P_SUB_BS, userTurn("no, use pwsh"), configFor(), seams);
    expect(markerLines(P_SUB_BS)).toEqual([]);
    expect(seams.llmPrompts).toHaveLength(0);
  });

  it("rate limit: at most one save per 3 turns (the counter is per session file)", async () => {
    seedSession(P_RL);
    seedSession(P_RL2);
    const seams = makeSeams();
    await capture(P_RL, userTurn("no, use pwsh"), configFor(), seams);
    expect(markerLines(P_RL)).toHaveLength(1); // the first save
    await capture(P_RL, userTurn("stop, run the tests"), configFor(), seams);
    expect(markerLines(P_RL)).toHaveLength(1); // evaluated turn 1 since the save → no save
    await capture(P_RL, userTurn("actually, try bash first"), configFor(), seams);
    expect(markerLines(P_RL)).toHaveLength(1); // evaluated turn 2 since the save → no save
    await capture(P_RL, userTurn("don't do that, it's broken"), configFor(), seams);
    expect(markerLines(P_RL)).toHaveLength(2); // the third evaluated turn since the last save allows the next
    expect(markerLines(P_RL)).toEqual([`@@CORR ${TS}@@ use pwsh`, `@@CORR ${TS}@@ don't do that, it's broken`]);
    // a new session file has its own counter — its first turn saves
    await capture(P_RL2, userTurn("no, use bash"), configFor(), seams);
    expect(markerLines(P_RL2)).toEqual([`@@CORR ${TS}@@ use bash`]);
  });

  it("the three-hook guard: re-fires of an already-stamped turn never re-stamp and never re-evaluate", async () => {
    seedSession(P_GUARD);
    const seams = makeSeams();
    await capture(P_GUARD, userTurn("no, use pwsh"), configFor(), seams, { summaryAppended: true });
    expect(markerLines(P_GUARD)).toHaveLength(1);
    // the session_before_compact / session_shutdown re-fires: the turn's summary append
    // did NOT happen (the dedup early-return path) → no second marker, no re-evaluation
    for (let i = 0; i < 3; i++) {
      await capture(P_GUARD, userTurn("no, use pwsh"), configFor(), seams, { summaryAppended: false });
    }
    expect(markerLines(P_GUARD)).toHaveLength(1);
    // the re-fires did not consume rate-limit allowance either:
    await capture(P_GUARD, userTurn("stop, run the tests"), configFor(), seams, { summaryAppended: true });
    expect(markerLines(P_GUARD)).toHaveLength(1); // evaluated turn 1 since the save
    await capture(P_GUARD, userTurn("actually, try bash first"), configFor(), seams, { summaryAppended: true });
    expect(markerLines(P_GUARD)).toHaveLength(1); // evaluated turn 2
    await capture(P_GUARD, userTurn("don't do that, it's broken"), configFor(), seams, { summaryAppended: true });
    expect(markerLines(P_GUARD)).toHaveLength(2); // evaluated turn 3 → the next save is allowed
  });

  it("flag off: no detector runs and no marker line is appended", async () => {
    seedSession(P_OFF);
    const seams = makeSeams();
    const cfgOff = { ...DEFAULT_CONFIG, correctionDetectionEnabled: false } as SessionRecallConfig;
    await capture(P_OFF, userTurn("no, use pwsh"), cfgOff, seams);
    expect(markerLines(P_OFF)).toEqual([]);
    expect(seams.embedCalls).toHaveLength(0);
    expect(seams.llmPrompts).toHaveLength(0);
    // the flag-off turn was not evaluated — the counter is untouched, so the next
    // flag-on turn saves like a first turn
    await capture(P_OFF, userTurn("don't do that, it's broken"), configFor(), seams);
    expect(markerLines(P_OFF)).toEqual([`@@CORR ${TS}@@ don't do that, it's broken`]);
  });

  it("the timestamp is ISO-8601 UTC, second precision, Z suffix, no fractional seconds (real clock)", async () => {
    seedSession(P_CLOCK);
    const seams = makeSeams();
    const res = await captureTurnEndCorrection({
      db,
      sessionFile: P_CLOCK,
      lastTurn: userTurn("no, use pwsh"),
      config: configFor(),
      embed: seams.embed,
      llmCall: seams.llmCall,
    });
    expect(res.appended).toBe(true);
    expect(markerLines(P_CLOCK)).toHaveLength(1);
    expect(markerLines(P_CLOCK)[0]).toMatch(MARKER_SHAPE);
  });
});
