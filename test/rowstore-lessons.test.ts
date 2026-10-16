// rowstore-lessons.test.ts — rowstore-lessons C3.5: the C3.5 surface (design §6 boundary
// rule — the C3 file keeps the spec-pinned engine/selection/log lines; everything NEW lives
// here): the EXTRACT prompt (pinned wording), the all-or-nothing parser, the engine re-order
// (per-session EXTRACT + per-lesson pipeline), the decision-17 match-time enrichment, and the
// C3.5 log bytes (LTROW LESSONS, the enrich= token, the EXTRACT-failure skip, ordering).
//
// Strict TDD: this file starts RED — the imports of the not-yet-existing exports
// (EXTRACT_LLM_TIMEOUT_MS / updateRowItemEmbeddingScoreAndLastSeen / normalizeLesson from
// rowstore.js) fail at import and every behavior fixture is red; every EXISTING file stays
// green (no collateral damage). It goes GREEN across design §13 steps 3–4 (config, then the
// rowstore engine in dependency order).
//
// House mechanics (design §12): in-memory better-sqlite3 via createRequire (no temp files);
// vi.spyOn(logger, "log") for ALL log byte-asserts (the logger no-ops in a vitest context);
// no HTTP in the unit suite — every seam is injected (embed / llmCall / nowMs /
// sessionCountOverride). The frozen EXTRACT prompt fixture below is transcribed VERBATIM
// from the delta spec (specs/rowstore/spec.md :329-398) — the SPEC is the transcription
// source (risk R2); the two example lessons are the byte source for the vehicle's
// EXAMPLE_LESSON_1/_2 constants (design §2.2; the cross-check gate is design §12/12.2).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { basename } from "node:path";
import * as logger from "../logger.js";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";
import { ensureSchema, md5Content, mergeQuarantineKey, readMergeQuarantine } from "../summarizer.js";
import {
  ensureRowStoreSchema,
  insertRow,
  getRows,
  mergeSignalsIntoRowStore,
  ROWSTORE_MERGE_LLM_TIMEOUT_MS,
  EXTRACT_LLM_TIMEOUT_MS,
  updateRowItemEmbeddingScoreAndLastSeen,
  normalizeLesson,
  type RowStoreMergeOptions,
  type RowStoreMergeResult,
} from "../rowstore.js";

// ─── The frozen EXTRACT prompt (spec :329-398, VERBATIM — risk R2) ──────────────────
// The 70-line pinned block; line 5 is the ${content} slot (chunk-agnostic — the prompt is
// byte-identical for any input, only the slot content varies).

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
  '- intentions or plans ("we will do X next")',
  '- progress updates with no durable takeaway ("ran the tests, passed")',
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
  'Form A — one bullet per lesson, each on its own line, each line',
  'starting with "- " (hyphen, space). Nothing before, after, or between:',
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
  '  never "*", "•", or numbers. No headers, no sections, no grouping,',
  "  no sub-bullets, no numbering, no prose, no preamble.",
  "- Short and self-contained: the reader is a future agent session that",
  "  never saw this one; each lesson must make sense alone.",
];

/** The assembled prompt for `content` — the slot substitution is the ONLY variation. */
const expectedExtractPrompt = (content: string): string =>
  EXTRACT_PROMPT_LINES.map(l => (l === "{content}" ? content : l)).join("\n");

/** The two worked example lessons (design §2.2 — MUST match the vehicle's
 *  EXAMPLE_LESSON_1/_2 byte-for-byte; the cross-check gate is the 12.2 apply leg). */
const EXAMPLE_LESSON_1 = "Use /dev/null, not nul, to discard output in Windows bash";
const EXAMPLE_LESSON_2 = "The 5002 embed server is spawned detached; extension code must never kill it";

// ─── Shared mechanics (design §12 seams) ────────────────────────────────────────────

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const DIM = 768;
const SC = 1084; // pinned run sessionCount (the test pin for last_seen / prune age)
const NOW = 1_700_000_000_000; // the injected run timestamp (sentinel keying / quarantine)

/** 768-dim unit vector with 1.0 at dimension idx — cosine 1 against itself, 0 against any
 *  other unit vector (deterministic match/no-match control under the 0.5 default threshold). */
const unitVec = (idx: number): number[] => {
  const v = new Array<number>(DIM).fill(0);
  v[((idx % DIM) + DIM) % DIM] = 1;
  return v;
};

const hashText = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

/** The embed seam — records {text, kind} per call (the re-embed-only-on-rewrite spy);
 *  vectors come from a `${kind}:${text}` map, else a deterministic per-text unit vector
 *  (same text → same vector → cosine 1; different text → cosine 0 < the 0.5 threshold). */
function makeEmbed(map: Record<string, number[]> = {}) {
  const calls: Array<{ text: string; kind: string }> = [];
  const fn = async (text: string, kind: string) => {
    calls.push({ text, kind });
    return map[`${kind}:${text}`] ?? unitVec(hashText(text));
  };
  return { fn, calls };
}

/** The llmCall seam — a scripted text/null sequence in call order (null = no text, the
 *  seam's real failure mode); repeats the last entry if the engine over-calls (a bug). */
function scriptLlmCall(...texts: Array<string | null>) {
  const prompts: string[] = [];
  let i = 0;
  const fn = async (prompt: string): Promise<string | null> => {
    prompts.push(prompt);
    const t = texts[Math.min(i, texts.length - 1)];
    i++;
    return t;
  };
  return { fn, prompts, count: () => i };
}

const PA = "2026-01-01T00-00-00Z_aa0001.jsonl";
const PB = "2026-01-02T00-00-00Z_aa0002.jsonl";
const PC = "2026-01-03T00-00-00Z_aa0003.jsonl";

/** Deterministic session content of EXACTLY `chars` chars (the engine's char meter —
 *  JS UTF-16 .length; 32-char units + a tail). */
function contentOfChars(chars: number, tag = "aaa"): string {
  const unit = 32;
  let s = "";
  for (let i = 0; s.length + unit <= chars; i++) s += `sess-${tag} line ${String(i).padStart(4, "0")} ${"x".repeat(12)}\n`;
  s += "y".repeat(chars - s.length);
  return s;
}

const configFor = (over: Partial<SessionRecallConfig> = {}): SessionRecallConfig =>
  ({ ...DEFAULT_CONFIG, ...over });

let db: any;
let logSpy: ReturnType<typeof vi.spyOn>;
const lines: string[] = [];

beforeEach(() => {
  db = new Database(":memory:");
  ensureSchema(db);
  ensureRowStoreSchema(db);
  lines.length = 0;
  logSpy = vi.spyOn(logger, "log").mockImplementation(m => lines.push(m));
});

afterEach(() => {
  logSpy.mockRestore();
  db.close();
});

function seedUnmerged(path: string, content: string, updatedAt = "2026-01-01T00:00:00.000Z"): void {
  db.prepare(
    "INSERT OR REPLACE INTO session_summaries (session_path, version, summary, char_count, merge_count, updated_at) VALUES (?, 1, '', 0, 0, ?)",
  ).run(path, updatedAt);
  db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run(content, path);
}

/** The engine run — the default test pins (sessionCountOverride + nowMs) are applied
 *  everywhere: the pins are about engine behavior (last_seen / sentinel keying), not config. */
async function runMerge(
  cfg: SessionRecallConfig,
  embed: (text: string, kind: string) => Promise<number[] | null>,
  llm: (prompt: string) => Promise<string | null>,
  extra: RowStoreMergeOptions = {},
): Promise<RowStoreMergeResult> {
  return mergeSignalsIntoRowStore(db, cfg, {
    embed,
    llmCall: llm,
    sessionCountOverride: SC,
    nowMs: () => NOW,
    ...extra,
  });
}

const rows = (): any[] => getRows(db);
const items = (): string[] => rows().map(r => r.item);
const unmerged = (path: string): string | null =>
  (db.prepare("SELECT unmerged_fresh_content FROM session_summaries WHERE session_path = ?").get(path) as any)?.unmerged_fresh_content ?? null;

const MATCH_JSON = '{"action":"match","rowId":1}';

/** EXTRACT-failure session-level policy asserts (design §1.4-1): the skip line with the
 *  extract-failed constant, the sentinel strike on (session, content-md5), unmarked, no rows. */
function assertExtractFailure(res: RowStoreMergeResult, path: string, reason: "timeout" | "parse-fail", content: string, expectedCalls: number, llmCount: number): void {
  expect(lines).toContain(`LTROW MERGE-SKIP reason=${reason} session=${basename(path)} signal="extract-failed"`);
  expect(lines.filter(l => l.startsWith("LTROW LESSONS "))).toHaveLength(0);
  expect(res.sessionsMarkedMerged).toBe(0);
  expect(res.sessionsFailed).toEqual([path]);
  expect(res.skipped).toEqual([{ sessionPath: path, signalIndex: -1, reason }]);
  expect(rows()).toHaveLength(0);
  const sent = readMergeQuarantine(db, path)!;
  expect(sent).not.toBeNull();
  expect(sent.contentHash).toBe(md5Content(content));
  expect(sent.failures).toBeGreaterThanOrEqual(1);
  expect(llmCount).toBe(expectedCalls);
}

// ─── (a) EXTRACT prompt (pinned wording) ─────────────────────────────────────────────

describe("EXTRACT prompt (pinned wording)", () => {
  async function capturePrompt(content: string) {
    seedUnmerged(PA, content); // the engine EXTRACTs the session's content — seed it first
    const llm = scriptLlmCall("- a lesson");
    await runMerge(configFor(), makeEmbed().fn, llm.fn);
    return llm.prompts[0];
  }

  it("names the exact `- ` marker and prohibits `*` / `•` / numbering", async () => {
    const p = await capturePrompt(contentOfChars(400));
    expect(p).toContain('starting with "- " (hyphen, space). Nothing before, after, or between:');
    expect(p).toContain('never "*", "•", or numbers. No headers, no sections, no grouping,');
    expect(p).toContain("no sub-bullets, no numbering, no prose, no preamble.");
  });

  it("both output forms present — Form A bullets + Form B `(none)`", async () => {
    const p = await capturePrompt(contentOfChars(400));
    const pl = p.split("\n");
    expect(pl).toContain("OUTPUT — your entire response must be exactly one of these two forms,");
    expect(pl).toContain("Form A — one bullet per lesson, each on its own line, each line");
    expect(pl).toContain("Form B — if there are no actionable lessons, exactly this one line:");
    expect(pl).toContain("(none)");
  });

  it("the two worked example lessons appear byte-for-byte (P2 — the vehicle EXAMPLE_LESSON_* source)", async () => {
    const p = await capturePrompt(contentOfChars(400));
    const pl = p.split("\n");
    expect(pl).toContain(`- ${EXAMPLE_LESSON_1}`);
    expect(pl).toContain(`- ${EXAMPLE_LESSON_2}`);
  });

  it("=== SESSION CONTENT START/END === markers + content placement + chunk-agnostic assembly (two runs, byte-identical outside the slot)", async () => {
    const A = contentOfChars(900, "aaa");
    const B = contentOfChars(1300, "bbb");
    const pA = await capturePrompt(A);
    const pB = await capturePrompt(B);
    expect(pA).toBe(expectedExtractPrompt(A));
    expect(pB).toBe(expectedExtractPrompt(B));
    const headEnd = "=== SESSION CONTENT START ===".length;
    const headOf = (p: string) => p.slice(0, p.indexOf("=== SESSION CONTENT START ===") + headEnd);
    const tailOf = (p: string) => p.slice(p.indexOf("=== SESSION CONTENT END ==="));
    expect(headOf(pA)).toBe(headOf(pB)); // byte-identical outside the slot
    expect(tailOf(pA)).toBe(tailOf(pB));
  });

  it("the pinned wording assembles verbatim — every line of the frozen spec block present (P2, risk R2)", async () => {
    const content = contentOfChars(600);
    const p = await capturePrompt(content);
    expect(EXTRACT_PROMPT_LINES).toHaveLength(70); // the spec :329-398 block
    expect(p).toBe(expectedExtractPrompt(content));
  });

  it("no legacy-KB structure in the output contract — the OUTPUT section names no sections/types/grouping", async () => {
    const p = await capturePrompt(contentOfChars(400));
    // The output-contract region: the two form definitions between the OUTPUT
    // header and the Rules subsection. The Rules text carries the pinned
    // PROHIBITION line ("No headers, no sections, no grouping,") — the named
    // words there are the ban, not a named structure — so the assertion scopes
    // to the contract region (the pin itself is byte-untouched; spec is the source).
    const outStart = p.indexOf("OUTPUT —");
    const outSection = p.slice(outStart, p.indexOf("\nRules:", outStart));
    expect(outSection).not.toMatch(/section|type|group|categor/i);
  });
});

// ─── (b) EXTRACT parser (all-or-nothing) ─────────────────────────────────────────────

describe("EXTRACT parser (all-or-nothing)", () => {
  const C = contentOfChars(500);

  it("valid bullets parse verbatim (3 bullets, empty lines between, trailing ws trimmed)", async () => {
    seedUnmerged(PA, C);
    const llm = scriptLlmCall("- First lesson\n\n- Second lesson   \n- Third lesson");
    const res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
    expect(llm.count()).toBe(1); // one chunk, one EXTRACT call, no retry
    expect(res.signalsProcessed).toBe(3);
    expect(res.decisions.map(d => d.action)).toEqual(["new", "new", "new"]);
    expect(items()).toEqual(["First lesson", "Second lesson", "Third lesson"]);
    expect(lines).toContain(`LTROW LESSONS n=3 session=${basename(PA)}`);
    expect(unmerged(PA)).toBeNull(); // marked merged
  });

  it("` (none) ` exactness — the 5-case family (only the exact single line yields zero lessons)", async () => {
    const cases: Array<{ name: string; text: string; valid: boolean }> = [
      { name: "exact (none)", text: "(none)", valid: true },
      { name: "(None)", text: "(None)", valid: false },
      { name: "(none).", text: "(none).", valid: false },
      { name: "prefix line", text: "lessons:\n(none)", valid: false },
      { name: "(none) + bullet", text: "(none)\n- A lesson", valid: false },
    ];
    for (const c of cases) {
      db.exec("DELETE FROM session_summaries");
      seedUnmerged(PA, C, "2026-01-01T00:00:00.000Z");
      const llm = scriptLlmCall(c.text, c.text); // 2nd entry = the retry (valid case never reaches it)
      const res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
      if (c.valid) {
        // zero lessons: quiet — marked merged, no LESSONS line, no skip line, no rows
        expect(res.sessionsMarkedMerged).toBe(1);
        expect(res.signalsProcessed).toBe(0);
        expect(res.decisions).toHaveLength(0);
        expect(res.skipped).toHaveLength(0);
        expect(rows()).toHaveLength(0);
        expect(lines.filter(l => l.startsWith("LTROW LESSONS "))).toHaveLength(0);
        expect(lines.filter(l => l.startsWith("LTROW MERGE-SKIP "))).toHaveLength(0);
        expect(llm.count()).toBe(1);
        expect(unmerged(PA)).toBeNull();
      } else {
        expect(c.name, `case "${c.name}" must be garbage`).not.toBe("exact (none)");
        assertExtractFailure(res, PA, "parse-fail", C, 2, llm.count());
      }
    }
  });

  it("any non-`- ` line invalidates the WHOLE output — the 8 garbage fixtures, zero lessons salvaged", async () => {
    const garbage = [
      "LESSONS:\n- A",        // header
      "I learned this: - A",  // prose
      "* A",                  // star bullet
      "• A",                  // middle-dot bullet
      "1. A",                 // numbered
      "- A\n  B",             // wrapped continuation (indented)
      "(None)",               // case-sensitive (none)
      "  - A",                // indented bullet (column 0 required)
    ];
    for (const g of garbage) {
      db.exec("DELETE FROM session_summaries");
      seedUnmerged(PA, C, "2026-01-01T00:00:00.000Z");
      const llm = scriptLlmCall(g, g); // garbage twice → the retry fires once, then the failure policy
      const res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
      assertExtractFailure(res, PA, "parse-fail", C, 2, llm.count()); // zero rows salvaged
    }
  });

  it("an empty bullet is garbage (alone and mid-list)", async () => {
    for (const g of ["- ", "- A\n- "]) {
      db.exec("DELETE FROM session_summaries");
      seedUnmerged(PA, C, "2026-01-01T00:00:00.000Z");
      const llm = scriptLlmCall(g, g);
      const res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
      assertExtractFailure(res, PA, "parse-fail", C, 2, llm.count());
    }
  });

  it("the retry ladder: garbage→valid = exactly 2 calls, same prompt, no backoff, lessons from the 2nd", async () => {
    seedUnmerged(PA, C);
    const llm = scriptLlmCall("garbage header\n- A", "- A lesson\n- B lesson");
    const res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
    expect(llm.count()).toBe(2);
    expect(llm.prompts[0]).toBe(llm.prompts[1]); // the SAME prompt (same content), no backoff
    expect(items()).toEqual(["A lesson", "B lesson"]); // lessons from the 2nd call
    expect(res.sessionsMarkedMerged).toBe(1);
  });

  it("garbage→garbage = exactly 2 calls → the session-level failure policy (strike (session, content-md5), unmarked, continue); a 3rd failing run quarantines", async () => {
    seedUnmerged(PA, C);
    for (let run = 1; run <= 3; run++) {
      const llm = scriptLlmCall("bad", "bad");
      const res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
      expect(llm.count()).toBe(2);
      assertExtractFailure(res, PA, "parse-fail", C, 2, llm.count());
      const sent = readMergeQuarantine(db, PA)!;
      expect(sent.contentHash).toBe(md5Content(C));
      expect(sent.failures).toBe(run);
      expect(sent.quarantinedAt).toBe(run >= 3 ? NOW : null);
      expect(unmerged(PA)).not.toBeNull(); // NOT marked — monotonic, no loss
    }
    expect(lines).toContain(`rowstore merge: quarantined ${basename(PA)} (3 consecutive failures)`);
  });

  it("LLM endpoint down → the extract failure SKIPS the quarantine strike (2026-10-16 incident: the 2026-10-13 5001 outage struck 4 unrelated sessions in one second and parked 3 of them for 7 days)", async () => {
    const C = contentOfChars(300, "aaa");
    seedUnmerged(PA, C);
    const llm = scriptLlmCall(null); // no text → immediate extract timeout, one per run
    await runMerge(configFor(), makeEmbed().fn, llm.fn, { probeLlmDown: async () => true });
    await runMerge(configFor(), makeEmbed().fn, llm.fn, { probeLlmDown: async () => true });
    const res = await runMerge(configFor(), makeEmbed().fn, llm.fn, { probeLlmDown: async () => true });
    expect(res.sessionsFailed).toContain(PA); // still a failure — just not a fault of the record
    expect(res.sessionsMarkedMerged).toBe(0);
    expect(res.skipped.find(sk => sk.sessionPath === PA)?.reason).toBe("llm-down");
    expect(readMergeQuarantine(db, PA)).toBeFalsy(); // NO strike, ever — no sentinel at all
    expect(unmerged(PA)).not.toBeNull(); // still in the backlog — retried next run, never parked
    expect(lines).toContain(`LTROW MERGE-SKIP reason=llm-down session=${PA} signal="extract-failed"`);
    expect(lines).not.toContain("rowstore merge: quarantined");
  });

  it("embed endpoint down → the per-lesson embed-null SKIPS the quarantine strike (2026-10-15 22:10: the probe said ready, the embed call died — 'fetch failed')", async () => {
    const C = contentOfChars(300, "bbb");
    seedUnmerged(PA, C);
    const llm = scriptLlmCall("- a lesson"); // extract succeeds → the per-lesson pipeline
    const badEmbed = async () => null; // stage 1 (the query embed) fails
    const res = await runMerge(configFor(), badEmbed, llm.fn, { probeEmbedDown: async () => true });
    expect(res.sessionsFailed).toContain(PA);
    expect(res.skipped.find(sk => sk.sessionPath === PA)?.reason).toBe("embed-down");
    expect(readMergeQuarantine(db, PA)).toBeFalsy();
    expect(unmerged(PA)).not.toBeNull();
    expect(lines).toContain(`LTROW MERGE-SKIP reason=embed-down session=${PA} signal="a lesson"`);
    expect(lines).not.toContain("rowstore merge: quarantined");
  });

  it("LTROW session identifiers are FULL paths, not basenames (nested subagent files are all named session.jsonl — 2026-09-04 quarantine post-mortem: the basename made the failed session unidentifiable in the logs)", async () => {
    // production shape: sessions/<project-dir>/<ts>_<id>/<child-id>/run-0/session.jsonl
    const PN = "C:\\sessions\\--proj--\\2026-09-01T19-11-01-375Z_01a05e61\\run-0\\session.jsonl";
    seedUnmerged(PN, C);
    for (let run = 1; run <= 3; run++) {
      const llm = scriptLlmCall(null); // no text → immediate extract timeout, one strike per run
      await runMerge(configFor(), makeEmbed().fn, llm.fn);
    }
    expect(lines).toContain(`LTROW MERGE-SKIP reason=timeout session=${PN} signal="extract-failed"`);
    expect(lines).toContain(`rowstore merge: quarantined ${PN} (3 consecutive failures)`);
    // the bare basename ("session.jsonl") must never be the identifier on these lines
    for (const l of lines.filter(l => l.startsWith("LTROW MERGE-SKIP ") || l.startsWith("rowstore merge: quarantined "))) {
      expect(l).toContain(PN);
      expect(l).not.toContain("session=session.jsonl");
      expect(l).not.toContain("quarantined session.jsonl");
    }
    // success path: the LESSONS line carries the full path too
    const PN2 = "C:\\sessions\\--proj--\\2026-09-01T20-00-00-000Z_01a05e77\\run-0\\session.jsonl";
    seedUnmerged(PN2, contentOfChars(300, "zzz"));
    const llm2 = scriptLlmCall("- a nested lesson");
    await runMerge(configFor(), makeEmbed().fn, llm2.fn);
    expect(lines).toContain(`LTROW LESSONS n=1 session=${PN2}`);
  });

  it("lesson text = everything after the marker, byte-verbatim (apostrophe / quotes / em-dash / internal spaces)", async () => {
    const lesson = "Don't panic — \"quoted\"  double  space — em-dash stays.";
    seedUnmerged(PA, C);
    const llm = scriptLlmCall(`- ${lesson}`);
    await runMerge(configFor(), makeEmbed().fn, llm.fn);
    expect(items()).toEqual([lesson]);
  });
});

// ─── (c) engine — per-session EXTRACT + per-lesson pipeline ─────────────────────────

describe("engine — per-session EXTRACT + per-lesson pipeline", () => {
  it("per-lesson stage order (≤24K session → EXTRACT → parse → LESSONS n=1 → query embed → CANDIDATES → short-circuit → write → MERGE-DECISION; the new document embed happens before the insert)", async () => {
    const C = contentOfChars(400);
    seedUnmerged(PA, C);
    const lesson = "L1";
    const embed = makeEmbed();
    const llm = scriptLlmCall(`- ${lesson}`);
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    // one EXTRACT call; zero candidates → the engine short-circuit (no COMPARE call)
    expect(llm.count()).toBe(1);
    expect(llm.prompts[0]).toBe(expectedExtractPrompt(C));
    // the query embed before the document embed; the insert carries the document vector
    expect(embed.calls).toEqual([
      { text: lesson, kind: "query" },
      { text: lesson, kind: "document" },
    ]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ item: lesson, score: 1, lastSeen: SC });
    expect(rows()[0].embedding).toEqual(unitVec(hashText(lesson))); // the document vector was written
    // the byte-pinned line order: MODE first, LESSONS n=1, CANDIDATES, DECISION, PRUNED last
    const iMode = lines.indexOf("LTROW MODE ROWSTORE");
    const iLess = lines.findIndex(l => l === `LTROW LESSONS n=1 session=${basename(PA)}`);
    const iCand = lines.findIndex(l => l.startsWith("LTROW CANDIDATES "));
    const iDec = lines.findIndex(l => l.startsWith("LTROW MERGE-DECISION "));
    const iPrune = lines.findIndex(l => l.startsWith("LTROW PRUNED "));
    expect([iMode, iLess, iCand, iDec, iPrune].every(i => i >= 0)).toBe(true);
    expect(iMode).toBeLessThan(iLess);
    expect(iLess).toBeLessThan(iCand);
    expect(iCand).toBeLessThan(iDec);
    expect(iDec).toBeLessThan(iPrune);
    expect(lines[iCand]).toBe("LTROW CANDIDATES n=0 pairs=-");
    expect(lines[iDec]).toBe("LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none");
    expect(res.decisions[0]).toMatchObject({ action: "new", by: "engine", topSimilarity: null });
  });

  it("per-lesson stage order on a match (query embed → CANDIDATES → COMPARE → enrichment → write → MERGE-DECISION after the write)", async () => {
    const C = contentOfChars(400);
    const v = unitVec(9);
    const stored = "Existing stored fact";
    insertRow(db, { item: stored, score: 1, lastSeen: SC - 10, embedding: v });
    seedUnmerged(PA, C);
    const lesson = "Existing stored fact"; // query vector == the stored row's vector → sim 1.0
    const embed = makeEmbed({ [`query:${lesson}`]: v });
    const llm = scriptLlmCall(`- ${lesson}`, MATCH_JSON);
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(2); // EXTRACT + COMPARE (normalized-identical → no MERGE call)
    const iLess = lines.findIndex(l => l.startsWith("LTROW LESSONS "));
    const iCand = lines.findIndex(l => l.startsWith("LTROW CANDIDATES "));
    const iDec = lines.findIndex(l => l.startsWith("LTROW MERGE-DECISION "));
    expect(iLess).toBeLessThan(iCand);
    expect(iCand).toBeLessThan(iDec);
    expect(lines[iCand]).toBe("LTROW CANDIDATES n=1 pairs=1:1.0000");
    expect(lines[iDec]).toBe("LTROW MERGE-DECISION action=match rowId=1 top=1.0000 by=llm enrich=none");
    expect(rows()).toHaveLength(1); // no new row — the match bumped the existing one
    expect(rows()[0]).toMatchObject({ item: stored, score: 2, lastSeen: SC });
    expect(embed.calls).toEqual([{ text: lesson, kind: "query" }]); // score-only: no re-embed
    expect(res.sessionsMarkedMerged).toBe(1);
  });

  it("a zero-lesson session is processed — zero row writes, marked merged, NO LESSONS line, no per-lesson lines, no skip line", async () => {
    seedUnmerged(PA, contentOfChars(400));
    const llm = scriptLlmCall("(none)");
    const res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
    expect(res.sessionsMarkedMerged).toBe(1);
    expect(res.signalsProcessed).toBe(0);
    expect(res.decisions).toHaveLength(0);
    expect(res.skipped).toHaveLength(0);
    expect(rows()).toHaveLength(0);
    expect(lines).toEqual(["LTROW MODE ROWSTORE", "LTROW PRUNED 0"]); // quiet — nothing between
    expect(unmerged(PA)).toBeNull();
  });

  it("the 24K chunk guard — 50K chars → exactly 3 EXTRACT calls, each the chunk-agnostic prompt, each consuming a cap slot; cross-chunk duplicates fall to COMPARE", async () => {
    const content = contentOfChars(50000, "aaa"); // ceil(50000/24000) = 3 chunks
    seedUnmerged(PA, content);
    const embed = makeEmbed();
    const llm = scriptLlmCall(
      "- Dup lesson\n- Unique one",
      "- Dup lesson", // chunk 2 — the cross-chunk duplicate
      "(none)",       // chunk 3
      MATCH_JSON,     // lesson 3 ("Dup lesson") matches the row written by lesson 1
    );
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    const chunk1 = content.slice(0, 24000);
    const chunk2 = content.slice(24000, 48000);
    const chunk3 = content.slice(48000);
    expect(llm.prompts[0]).toBe(expectedExtractPrompt(chunk1));
    expect(llm.prompts[1]).toBe(expectedExtractPrompt(chunk2));
    expect(llm.prompts[2]).toBe(expectedExtractPrompt(chunk3));
    expect(llm.count()).toBe(4); // 3 EXTRACT + 1 COMPARE (lesson 1/2 short-circuit new)
    expect(lines).toContain(`LTROW LESSONS n=3 session=${basename(PA)}`);
    expect(res.signalsProcessed).toBe(3);
    expect(res.decisions.map(d => d.action)).toEqual(["new", "new", "match"]);
    expect(rows()).toHaveLength(2);
    expect(rows().find(r => r.item === "Dup lesson")).toMatchObject({ score: 2, lastSeen: SC });
    expect(res.deferredSessions).toBe(0); // the 3 slots fit the default cap of 4
  });

  it("quarantine-pure exclusions — skipped without processing: not counted, not deferred, not logged; the engine never reads the sentinel store", async () => {
    const CA = contentOfChars(300, "aaa");
    const CB = contentOfChars(300, "bbb");
    seedUnmerged(PA, CA, "2026-01-01T00:00:00.000Z");
    seedUnmerged(PB, CB, "2026-01-02T00:00:00.000Z");
    // A is quarantined (3 strikes, content-matched sentinel) AND excluded by the run-start pass
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      mergeQuarantineKey(PA),
      JSON.stringify({ headPath: PA, contentHash: md5Content(CA), failures: 3, quarantinedAt: NOW - 1000 }),
    );
    const llm = scriptLlmCall("- B lesson");
    const res = await runMerge(configFor(), makeEmbed().fn, llm.fn, { excludedPaths: [PA] });
    expect(res.sessionsMarkedMerged).toBe(1); // only B
    expect(res.sessionsFailed).toHaveLength(0);
    expect(res.deferredSessions).toBe(0); // A is NOT deferred (excluded ≠ deferred)
    expect(lines.filter(l => l.includes(basename(PA)))).toHaveLength(0); // A never logged
    expect(lines.filter(l => l.startsWith("LTROW MERGE-DEFERRED "))).toHaveLength(0);
    expect(unmerged(PA)).toBe(CA); // A untouched
    expect(items()).toEqual(["B lesson"]);
  });

  it("the engine never reads the sentinel store — a 3-strike sentinel NOT in excludedPaths does not stop the session", async () => {
    const CB = contentOfChars(300, "bbb");
    seedUnmerged(PB, CB, "2026-01-02T00:00:00.000Z");
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      mergeQuarantineKey(PB),
      JSON.stringify({ headPath: PB, contentHash: md5Content(CB), failures: 3, quarantinedAt: NOW - 1000 }),
    );
    const llm = scriptLlmCall("- B lesson");
    const res = await runMerge(configFor(), makeEmbed().fn, llm.fn); // no excludedPaths
    expect(res.sessionsMarkedMerged).toBe(1); // processed anyway — quarantine-pure
    expect(items()).toEqual(["B lesson"]);
  });

  it("run-end prune always runs — a run that processed nothing still prunes + emits LTROW PRUNED <n> (n=0 included), last line", async () => {
    // (a) nothing unmerged at all → PRUNED 0
    let res = await runMerge(configFor(), makeEmbed().fn, scriptLlmCall().fn);
    expect(lines).toEqual(["LTROW MODE ROWSTORE", "LTROW PRUNED 0"]);
    expect(res.pruned).toBe(0);

    lines.length = 0; // (b) re-runs on the same spy — reset between sub-cases
    // (b) a stale row (age 101 > 100, score 1 < 3) → PRUNED 1
    db.exec("DELETE FROM session_summaries");
    insertRow(db, { item: "stale", score: 1, lastSeen: SC - 101, embedding: unitVec(1) });
    res = await runMerge(configFor(), makeEmbed().fn, scriptLlmCall().fn);
    expect(lines).toEqual(["LTROW MODE ROWSTORE", "LTROW PRUNED 1"]);
    expect(res.pruned).toBe(1);
    expect(rows()).toHaveLength(0);
    // (c) a session present but excluded → still PRUNED 0 (nothing processed)
    seedUnmerged(PA, contentOfChars(300));
    res = await runMerge(configFor(), makeEmbed().fn, scriptLlmCall().fn, { excludedPaths: [PA] });
    expect(lines[lines.length - 1]).toBe("LTROW PRUNED 0");
    expect(res.pruned).toBe(0);
  });

  it("COMPARE prompt byte-identity — the captured prompt == C3's buildMergePrompt bytes with the lesson in the {bare} slot (decision 7)", async () => {
    const C = contentOfChars(400);
    const v = unitVec(9);
    const stored = "Existing stored fact";
    insertRow(db, { item: stored, score: 1, lastSeen: SC - 10, embedding: v });
    seedUnmerged(PA, C);
    const lesson = "The incoming lesson text";
    const embed = makeEmbed({ [`query:${lesson}`]: v });
    const llm = scriptLlmCall(`- ${lesson}`, MATCH_JSON);
    await runMerge(configFor(), embed.fn, llm.fn);
    const expectedCompare = [
      "You maintain a small, deduplicated long-term memory store of short fact lines.",
      "Decide how to merge ONE new signal into the store.",
      "",
      "New signal:",
      lesson, // the lesson in the {bare} slot — the ONLY byte that differs from C3
      "",
      "Existing rows (id: text), in similarity order:",
      `1: ${stored}`,
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
    expect(llm.prompts[1]).toBe(expectedCompare);
  });
});

// ─── (d) match-time enrichment (decision 17) ─────────────────────────────────────────

describe("match-time enrichment (decision 17)", () => {
  const C = contentOfChars(400);

  /** Seed a stored row (score 1) + wire the lesson's query embed to the row's vector
   *  (sim 1.0 → the lesson is a candidate); return the embed seam. */
  function matchFixture(stored: string, lesson: string, docVec?: number[]) {
    const v = unitVec(9);
    const id = insertRow(db, { item: stored, score: 1, lastSeen: SC - 10, embedding: v });
    // the parser trims trailing ws — key BOTH the raw and the parsed form
    const map: Record<string, number[]> = { [`query:${lesson}`]: v, [`query:${lesson.trim()}`]: v };
    if (docVec) { map[`document:${lesson}`] = docVec; map[`document:${lesson.trim()}`] = docVec; }
    seedUnmerged(PA, C);
    return { id, embed: makeEmbed(map), v };
  }

  it("normalized-identical → score-only `none` (no LLM beyond EXTRACT+COMPARE; no re-embed; the row byte-identical)", async () => {
    const stored = "Fix the build";
    const lesson = "  fix   THE build. "; // n(lesson) === n(stored)
    const { embed } = matchFixture(stored, lesson);
    const llm = scriptLlmCall(`- ${lesson.trim()}`, MATCH_JSON);
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(2);
    expect(embed.calls).toEqual([{ text: lesson.trim(), kind: "query" }]); // score-only: NO document embed
    const row = rows()[0];
    expect(row.item).toBe(stored); // byte-identical after
    expect(row.score).toBe(2);
    expect(row.lastSeen).toBe(SC);
    expect(row.embedding).toEqual(unitVec(9)); // the original embedding, untouched
    expect(lines).toContain("LTROW MERGE-DECISION action=match rowId=1 top=1.0000 by=llm enrich=none");
    expect(res.decisions).toHaveLength(1);
  });

  it("raw-superset → rewrite + re-embed (exactly ONE document embed of the incoming text; zero LLM beyond COMPARE)", async () => {
    const stored = "Fix the build";
    const lesson = "Fix the build, and also the tests"; // lesson.includes(stored) raw
    const v2 = unitVec(77);
    const { embed } = matchFixture(stored, lesson, v2);
    const llm = scriptLlmCall(`- ${lesson}`, MATCH_JSON);
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(2);
    expect(embed.calls).toEqual([
      { text: lesson, kind: "query" },
      { text: lesson, kind: "document" }, // exactly one document embed — of the NEW text
    ]);
    const row = rows()[0];
    expect(row.item).toBe(lesson); // rewritten
    expect(row.score).toBe(2);
    expect(row.lastSeen).toBe(SC);
    expect(row.embedding).toEqual(v2); // the re-embedded vector
    expect(lines).toContain("LTROW MERGE-DECISION action=match rowId=1 top=1.0000 by=llm enrich=rewrite");
  });

  it("normalized-restatement → score-only `none` (n(stored) ⊃ n(lesson); no MERGE call)", async () => {
    const stored = "always use pnpm for installs";
    const lesson = "use pnpm"; // n(lesson) ⊂ n(stored)
    const { embed } = matchFixture(stored, lesson);
    const llm = scriptLlmCall(`- ${lesson}`, MATCH_JSON);
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(2); // NO MERGE call
    expect(embed.calls).toEqual([{ text: lesson, kind: "query" }]);
    expect(rows()[0].item).toBe(stored);
    expect(rows()[0].score).toBe(2);
    expect(lines).toContain("LTROW MERGE-DECISION action=match rowId=1 top=1.0000 by=llm enrich=none");
    expect(res.decisions).toHaveLength(1);
  });

  it("partial overlap → exactly ONE MERGE call (the 3rd call; the prompt carries the contract word-for-word)", async () => {
    const stored = "use pnpm for installs";
    const lesson = "use npm for installs unless told"; // no containment either way
    const v2 = unitVec(78);
    const merged = "use pnpm for installs; and npm only when pnpm is missing";
    const { embed } = matchFixture(stored, lesson, v2);
    const llm = scriptLlmCall(`- ${lesson}`, MATCH_JSON, merged);
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(3);
    const expectedEnrich = [
      "You maintain one lesson line in a long-term memory store.",
      "Merge the stored lesson and the incoming lesson into one cohesive line.",
      "Keep every fact from both lessons; the wording is up to you.",
      "If the incoming lesson adds nothing the stored lesson doesn't already say — even in different words — output the stored lesson exactly.",
      "",
      "Stored lesson:",
      stored,
      "",
      "Incoming lesson:",
      lesson,
      "",
      "Reply with exactly one line of plain text and nothing else.",
    ].join("\n");
    expect(llm.prompts[2]).toBe(expectedEnrich); // the contract line word-for-word
    expect(embed.calls).toEqual([
      { text: lesson, kind: "query" },
      { text: merged, kind: "document" },
    ]);
    expect(rows()[0].item).toBe(merged);
  });

  it("MERGE parse-pass (containing) → rewrite + re-embed + score+1 in ONE write (the §1.5 one-write invariant)", async () => {
    const stored = "beta fact";
    const lesson = "the beta item plus gamma"; // no containment either way → MERGE call
    const merged = "beta fact; plus the gamma follow-up"; // merged.includes(stored) raw, merged ≠ stored → parse-pass rewrite
    const { embed } = matchFixture(stored, lesson);
    const llm = scriptLlmCall(`- ${lesson}`, MATCH_JSON, merged);
    await runMerge(configFor(), embed.fn, llm.fn);
    const row = rows()[0];
    // ONE write: item + embedding + score + last_seen committed together
    expect(row.item).toBe(merged);
    expect(row.score).toBe(2);
    expect(row.lastSeen).toBe(SC);
    expect(row.embedding).toEqual(unitVec(hashText(merged))); // the re-embed of the NEW text
    expect(embed.calls.filter(c => c.kind === "document")).toHaveLength(1);
    expect(lines).toContain("LTROW MERGE-DECISION action=match rowId=1 top=1.0000 by=llm enrich=rewrite");
  });

  it("MERGE byte-equal → score-only `none` (no re-embed)", async () => {
    const stored = "delta fact";
    const lesson = "the delta item plus a nuance"; // no containment either way → the MERGE call
    const { embed } = matchFixture(stored, lesson);
    const llm = scriptLlmCall(`- ${lesson}`, MATCH_JSON, stored); // m === S exactly
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(3);
    expect(embed.calls).toEqual([{ text: lesson, kind: "query" }]); // NO document embed
    expect(rows()[0].item).toBe(stored);
    expect(rows()[0].score).toBe(2);
    expect(lines).toContain("LTROW MERGE-DECISION action=match rowId=1 top=1.0000 by=llm enrich=none");
  });
  it("MERGE parse-pass → a re-worded merge that does NOT contain the stored text byte-for-byte is accepted as the rewrite (decision B — the containment check is deleted)", async () => {
    const stored = "delta fact";
    const lesson = "the delta item plus a nuance"; // no containment either way → the MERGE call
    const merged = "a coherent restatement of the delta item with its nuance"; // does NOT contain "delta fact" raw
    const { embed } = matchFixture(stored, lesson);
    const llm = scriptLlmCall(`- ${lesson}`, MATCH_JSON, merged);
    await runMerge(configFor(), embed.fn, llm.fn);
    const row = rows()[0];
    expect(row.item).toBe(merged); // the re-worded merge is the new row text (parse-only acceptance)
    expect(row.item.includes(stored)).toBe(false); // NO containment requirement (decision B)
    expect(row.score).toBe(2);
    expect(row.lastSeen).toBe(SC);
    expect(row.embedding).toEqual(unitVec(hashText(merged))); // the re-embed of the NEW text
    expect(embed.calls.filter(c => c.kind === "document")).toHaveLength(1);
    expect(lines).toContain("LTROW MERGE-DECISION action=match rowId=1 top=1.0000 by=llm enrich=rewrite");
  });

  for (const [name, mergeOut] of [
    // "guard-reject" (m contains no stored text) is GONE — decision B (task 7.5): the re-worded merge is accepted (parse-pass); the reject sub-reasons are just what the seam/parser already produce (task 7.3 makes them visible per decision).
    ["garbage (multi-line)", "line one\nline two"],
    ["garbage (empty after trim)", "   "],
    ["timeout / no text (null)", null],
  ] as Array<[string, string | null]>) {
    it(`fail-safe on ${name} → score-only \`rejected\`, the row byte-identical after (score+1 only), NO sentinel strike, session marked merged`, async () => {
      const stored = "epsilon fact";
      // no containment either way (raw or normalized) — the fixture must reach
      // ladder branch 4 (the MERGE call); "epsilon fact plus zeta" would have
      // been a raw superset (branch 2 — zero LLM) and never spent the call.
      const lesson = "the epsilon item plus zeta";
      const { embed, v } = matchFixture(stored, lesson);
      const llm = scriptLlmCall(`- ${lesson}`, MATCH_JSON, mergeOut);
      const res = await runMerge(configFor(), embed.fn, llm.fn);
      expect(llm.count()).toBe(3); // ONE MERGE attempt — NO retry (the design pin)
      const row = rows()[0];
      expect(row.item).toBe(stored); // byte-identical text
      expect(row.embedding).toEqual(v); // byte-identical embedding
      expect(row.score).toBe(2); // score+1 — C3's match status quo
      expect(row.lastSeen).toBe(SC);
      expect(readMergeQuarantine(db, PA)).toBeNull(); // NO sentinel strike
      expect(res.sessionsMarkedMerged).toBe(1); // NOT a lesson failure (fail-safe)
      expect(res.sessionsFailed).toHaveLength(0);
      expect(lines).toContain("LTROW MERGE-DECISION action=match rowId=1 top=1.0000 by=llm enrich=rejected");
    });
  }

  it("re-embed only on rewrite — the embed seam spy across the full match population (a document embed exactly when the text was rewritten, never for a score-only match)", async () => {
    const v1 = unitVec(11);
    const v2 = unitVec(12);
    const v3 = unitVec(13);
    insertRow(db, { item: "alpha fact", score: 1, lastSeen: SC - 10, embedding: v1 });
    insertRow(db, { item: "beta fact", score: 1, lastSeen: SC - 10, embedding: v2 });
    insertRow(db, { item: "delta fact", score: 1, lastSeen: SC - 10, embedding: v3 });
    seedUnmerged(PA, C);
    const lesson1 = "  ALPHA   FACT. "; // normalized-identical → none
    const lesson2 = "beta fact plus gamma"; // raw-superset → rewrite
    const lesson3 = "the delta item plus nuance"; // no containment → MERGE byte-equal → none
    const embed = makeEmbed({
      [`query:${lesson1.trim()}`]: v1,
      [`query:${lesson2}`]: v2,
      [`query:${lesson3}`]: v3,
    });
    const llm = scriptLlmCall(
      `- ${lesson1.trim()}\n- ${lesson2}\n- ${lesson3}`,
      '{"action":"match","rowId":1}',
      '{"action":"match","rowId":2}',
      '{"action":"match","rowId":3}',
      "delta fact", // the MERGE response for lesson 3 (byte-equal)
    );
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(5);
    expect(embed.calls.filter(c => c.kind === "document")).toEqual([{ text: lesson2, kind: "document" }]); // EXACTLY one — the rewrite
    expect(rows().map(r => r.item)).toEqual(["alpha fact", "beta fact plus gamma", "delta fact"]);
    expect(rows().map(r => r.score)).toEqual([2, 2, 2]);
    expect(res.decisions).toHaveLength(3);
  });

  it("parse-only acceptance — the post-read store check: ladder step 2's raw check STAYS (the zero-LLM fast path); branch 4 has NO containment gate (decision B)", async () => {
    const v1 = unitVec(14);
    const v2 = unitVec(15);
    const r1 = insertRow(db, { item: "old text one", score: 1, lastSeen: SC - 10, embedding: v1 });
    const r2 = insertRow(db, { item: "old text two", score: 1, lastSeen: SC - 10, embedding: v2 });
    seedUnmerged(PA, C);
    const lesson1 = "old text one extended"; // raw-superset rewrite (the step-2 RAW check — stays)
    // no containment either way (raw or normalized) → MERGE parse-pass; the
    // model's re-worded merge does NOT contain the stored text byte-for-byte
    // and is still the new row text (decision B — no mechanical containment
    // gate; "old-text-two" hyphenation keeps the raw check honest).
    const lesson2 = "the old-text-two item plus more";
    const merged2 = "a coherent restatement covering the old-text-two item and more"; // NO raw containment of "old text two"
    const embed = makeEmbed({ [`query:${lesson1}`]: v1, [`query:${lesson2}`]: v2 });
    const llm = scriptLlmCall(
      `- ${lesson1}\n- ${lesson2}`,
      `{"action":"match","rowId":${r1}}`,
      `{"action":"match","rowId":${r2}}`,
      merged2,
    );
    await runMerge(configFor(), embed.fn, llm.fn);
    const after = new Map(rows().map(r => [r.id, r.item]));
    expect(after.get(r1)).toBe(lesson1);
    expect(after.get(r2)).toBe(merged2); // the re-worded merge is accepted — parse-pass
    expect(after.get(r1)!.includes("old text one")).toBe(true); // the step-2 RAW check STAYS (the proven-superset fast path)
    expect(after.get(r2)!.includes("old text two")).toBe(false); // NO mechanical containment gate (decision B)
  });
});

// ─── (d2) the LTROW MERGE-ENRICH audit line (task 7.3) ──────────────────────────────

describe("the LTROW MERGE-ENRICH audit line (task 7.3 — one per branch-4 decision; branches 1–3 emit none)", () => {
  const S = "delta fact";
  const I = "the delta item plus a nuance"; // no containment either way → ladder branch 4

  const enrichLine = (enrich: string, why: string, m: string | null): string =>
    `LTROW MERGE-ENRICH rowId=1 enrich=${enrich} why=${why} s=${S} i=${I} m=${m === null ? "-" : m}`;


  /** Seed a stored row (score 1) + wire the lesson's query embed to the row's vector
   *  (sim 1.0 → the lesson is a candidate) — the (d) matchFixture, local to this describe. */
  function matchFixtureLocal(stored: string, lesson: string, v: number[]) {
    insertRow(db, { item: stored, score: 1, lastSeen: SC - 10, embedding: v });
    // the parser trims trailing ws — key BOTH the raw and the parsed form
    const map: Record<string, number[]> = { [`query:${lesson}`]: v, [`query:${lesson.trim()}`]: v };
    seedUnmerged(PA, contentOfChars(400));
    return { embed: makeEmbed(map), v };
  }

  it("why=pass — an accepted merge (the parse-pass) records S, I and the model's exact line (enrich=rewrite)", async () => {
    const v = unitVec(9);
    const merged = "a coherent restatement of the delta item with its nuance";
    const { embed } = matchFixtureLocal(S, I, v);
    const llm = scriptLlmCall(`- ${I}`, MATCH_JSON, merged);
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(lines).toContain(enrichLine("rewrite", "pass", merged));
    expect(lines.filter(l => l.startsWith("LTROW MERGE-ENRICH "))).toHaveLength(1);
  });

  it("why=byte-equal — m === S records the model's line (= S) with enrich=none", async () => {
    const v = unitVec(9);
    const { embed } = matchFixtureLocal(S, I, v);
    const llm = scriptLlmCall(`- ${I}`, MATCH_JSON, S);
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(lines).toContain(enrichLine("none", "byte-equal", S));
  });

  it("why=llm-null — the seam's null (fail/timeout/no text) records m=- with enrich=rejected", async () => {
    const v = unitVec(9);
    const { embed } = matchFixtureLocal(S, I, v);
    const llm = scriptLlmCall(`- ${I}`, MATCH_JSON, null);
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(lines).toContain(enrichLine("rejected", "llm-null", null));
  });

  it("why=empty — a whitespace-only merge response records m=- with enrich=rejected", async () => {
    const v = unitVec(9);
    const { embed } = matchFixtureLocal(S, I, v);
    const llm = scriptLlmCall(`- ${I}`, MATCH_JSON, "   ");
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(lines).toContain(enrichLine("rejected", "empty", null));
  });

  it("why=multiline — a multi-line merge response records m=- with enrich=rejected", async () => {
    const v = unitVec(9);
    const { embed } = matchFixtureLocal(S, I, v);
    const llm = scriptLlmCall(`- ${I}`, MATCH_JSON, "line one\nline two");
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(lines).toContain(enrichLine("rejected", "multiline", null));
  });

  it("why=re-embed-null — an accepted merge whose re-embed degrades records the model's line + the degrade (enrich=rejected, the row byte-identical)", async () => {
    const v = unitVec(9);
    const merged = "a coherent restatement of the delta item with its nuance";
    const base = matchFixtureLocal(S, I, v).embed.fn;
    const embed = (async (text: string, kind: string) => {
      if (kind === "document" && text === merged) return null; // the re-embed degrade
      return base(text, kind); // base = the fixture's embed fn (records nothing extra — the degrade is the point)
    }) as typeof base;
    const llm = scriptLlmCall(`- ${I}`, MATCH_JSON, merged);
    await runMerge(configFor(), embed, llm.fn);
    expect(lines).toContain(enrichLine("rejected", "re-embed-null", merged)); // the model's line is recorded (const→let)
    expect(rows()[0].item).toBe(S); // the degrade — the row text is byte-identical
  });

  it("branches 1–3 emit NO MERGE-ENRICH line (only the branch-4 decisions audit)", async () => {
    const v1 = unitVec(11);
    const v2 = unitVec(12);
    const v3 = unitVec(13);
    insertRow(db, { item: "alpha fact", score: 1, lastSeen: SC - 10, embedding: v1 });
    insertRow(db, { item: "beta fact", score: 1, lastSeen: SC - 10, embedding: v2 });
    insertRow(db, { item: "delta fact", score: 1, lastSeen: SC - 10, embedding: v3 });
    const C = contentOfChars(400);
    seedUnmerged(PA, C);
    const embed = makeEmbed({
      "query:ALPHA FACT": v1,
      "query:beta fact plus gamma": v2,
      "query:the delta item plus nuance": v3,
    });
    const llm = scriptLlmCall(
      "- ALPHA FACT\n- beta fact plus gamma\n- the delta item plus nuance",
      '{"action":"match","rowId":1}', // branch 1 — normalized-identical (no audit line)
      '{"action":"match","rowId":2}', // branch 2 — raw-superset (no audit line)
      '{"action":"match","rowId":3}', // branch 4 — the MERGE call (the ONE audit line)
      "delta fact", // byte-equal response
    );
    await runMerge(configFor(), embed.fn, llm.fn);
    const enrichLines = lines.filter(l => l.startsWith("LTROW MERGE-ENRICH "));
    expect(enrichLines).toHaveLength(1);
    expect(enrichLines[0]).toBe("LTROW MERGE-ENRICH rowId=3 enrich=none why=byte-equal s=delta fact i=the delta item plus nuance m=delta fact");
  });
});

// ─── (d3) lesson-line length guard (task 7.6 — one split-permitted re-ask) ──────────

/** task 7.6 — the pinned rejection line (both sites); the engine's constant is
 *  module-private — the tests pin the bytes directly. */
const LESSON_LINE_REJECTION =
  "Response rejected: over length limit. Re-emit preserving every fact — shorten the wording, or split into multiple one-line lessons.";

/** v5 enrichment prompt assembly — the bytes are pinned at (d); the re-ask prompt is
 *  the same prompt + blank line + the pinned rejection line. */
const v5EnrichPrompt = (stored: string, incoming: string): string =>
  [
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

describe("lesson-line length guard (task 7.6 — one split-permitted re-ask)", () => {
  // LESSON_LINE_MAX_CHARS = 5000 — pinned by the P2 frozen-surface test (rowstore.test.ts).
  const OVER = 5001; // the MERGE-site over line (measured as m.length)
  const overBullet = () => "- " + "x".repeat(OVER + 1); // parsed EXTRACT lesson = OVER + 1 chars > budget
  const matchFixture = (S: string, I: string, v: number[]) => {
    insertRow(db, { item: S, score: 1, lastSeen: SC - 10, embedding: v });
    const C = contentOfChars(400);
    seedUnmerged(PA, C);
    const embed = makeEmbed({ [`query:${I}`]: v, [`query:${I.trim()}`]: v });
    return { C, embed };
  };

  it("EXTRACT site — over-once-then-short: exactly 2 attempts; the re-ask carries the same prompt + blank line + the pinned rejection line; the short line is written", async () => {
    const C = contentOfChars(300);
    seedUnmerged(PA, C);
    const short = "- a short compliant lesson";
    const llm = scriptLlmCall(overBullet(), short);
    const embed = makeEmbed();
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(2); // exactly one re-ask
    expect(llm.prompts[0]).toBe(expectedExtractPrompt(C));
    expect(llm.prompts[1]).toBe(expectedExtractPrompt(C) + "\n\n" + LESSON_LINE_REJECTION);
    expect(items()).toEqual(["a short compliant lesson"]);
    expect(res.sessionsMarkedMerged).toBe(1);
  });

  it("EXTRACT site — over-always: the EXISTING session-failure policy (parse-fail, sentinel strike, unmarked) — no new strike semantics", async () => {
    const C = contentOfChars(300);
    seedUnmerged(PA, C);
    const llm = scriptLlmCall(overBullet(), overBullet());
    const embed = makeEmbed();
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(2); // at most ONE retry per failure class
    assertExtractFailure(res, PA, "parse-fail", C, 2, llm.count());
  });

  it("EXTRACT site — the retry budget: garbage→over→short = exactly 3 attempts (one retry per failure class; hard cap 3 per chunk; no loops)", async () => {
    const C = contentOfChars(300);
    seedUnmerged(PA, C);
    const short = "- a short compliant lesson";
    const llm = scriptLlmCall("bad header line", overBullet(), short);
    const embed = makeEmbed();
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(3);
    expect(llm.prompts[1]).toBe(llm.prompts[0]); // the garbage retry re-asks the same prompt
    expect(llm.prompts[2]).toBe(llm.prompts[0] + "\n\n" + LESSON_LINE_REJECTION); // the over-length re-ask
    expect(items()).toEqual(["a short compliant lesson"]);
  });

  it("MERGE site — over-once-then-short: exactly 2 MERGE attempts (the SOLE exception to the one-attempt pin); the short line is the rewrite (why=pass)", async () => {
    const S = "delta fact";
    const I = "the delta item plus a nuance";
    const v = unitVec(9);
    const { embed } = matchFixture(S, I, v);
    const overM = "y".repeat(OVER); // a valid single line, over budget
    const shortM = "delta fact plus the nuance, coherently merged";
    const llm = scriptLlmCall(`- ${I}`, MATCH_JSON, overM, shortM);
    await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(4); // EXTRACT + COMPARE + MERGE + the one re-ask
    expect(llm.prompts[2]).toBe(v5EnrichPrompt(S, I));
    expect(llm.prompts[3]).toBe(v5EnrichPrompt(S, I) + "\n\n" + LESSON_LINE_REJECTION);
    const row = rows()[0];
    expect(row.item).toBe(shortM);
    expect(row.score).toBe(2);
    expect(lines).toContain(`LTROW MERGE-ENRICH rowId=1 enrich=rewrite why=pass s=${S} i=${I} m=${shortM}`);
  });

  it("MERGE site — over-always: the m = null path — enrich=rejected why=over-length, the row byte-identical, score+1, NO sentinel strike (fail-safe)", async () => {
    const S = "delta fact";
    const I = "the delta item plus a nuance";
    const v = unitVec(9);
    const { embed } = matchFixture(S, I, v);
    const overM = "y".repeat(OVER);
    const llm = scriptLlmCall(`- ${I}`, MATCH_JSON, overM, overM);
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    expect(llm.count()).toBe(4); // a parse-failure never re-asks; over-length re-asks once
    const row = rows()[0];
    expect(row.item).toBe(S); // byte-identical
    expect(row.score).toBe(2); // score+1 — C3's match status quo
    expect(readMergeQuarantine(db, PA)).toBeNull(); // NO sentinel strike (fail-safe degrade)
    expect(res.sessionsMarkedMerged).toBe(1);
    expect(lines).toContain(`LTROW MERGE-ENRICH rowId=1 enrich=rejected why=over-length s=${S} i=${I} m=-`);
  });
});

// ─── (e) log bytes (C3.5) ────────────────────────────────────────────────────────────

describe("log bytes (C3.5)", () => {
  it("the LTROW LESSONS line — byte shape (n first, basename incl. .jsonl), one per lesson-yielding session, n=0 quiet (the three-lesson / one-lesson / zero-lesson run fixture)", async () => {
    seedUnmerged(PA, contentOfChars(300, "aaa"), "2026-01-01T00:00:00.000Z");
    seedUnmerged(PB, contentOfChars(300, "bbb"), "2026-01-02T00:00:00.000Z");
    seedUnmerged(PC, contentOfChars(300, "ccc"), "2026-01-03T00:00:00.000Z");
    const llm = scriptLlmCall(
      "- A1\n- A2\n- A3", // A → 3 lessons
      "- B1",             // B → 1 lesson
      "(none)",           // C → 0 lessons (quiet)
    );
    const res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
    const lessons = lines.filter(l => l.startsWith("LTROW LESSONS "));
    expect(lessons).toEqual([
      `LTROW LESSONS n=3 session=${basename(PA)}`,
      `LTROW LESSONS n=1 session=${basename(PB)}`,
    ]); // exactly one per lesson-yielding session; NONE for C (n=0 quiet)
    expect(lines.filter(l => l.includes(basename(PC)))).toHaveLength(0); // C is quiet end-to-end
    // placement: each LESSONS line precedes its session's first per-lesson line
    const iA = lines.indexOf(`LTROW LESSONS n=3 session=${basename(PA)}`);
    const iFirstCand = lines.findIndex(l => l.startsWith("LTROW CANDIDATES "));
    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iA).toBeLessThan(iFirstCand);
    expect(res.sessionsMarkedMerged).toBe(3); // C marked too (processed, not retried)
    expect(res.signalsProcessed).toBe(4);
  });

  it("the enrich= token per branch — the 7-branch → token map (P1) + the four C3 decision shapes with the token", async () => {
    // nine seeded rows: R2 contradict, R3 normalized-identical, R4 raw-superset,
    // R5 normalized-restatement, R6 MERGE parse-pass (containing), R7 MERGE parse-pass (re-worded),
    // R8 MERGE timeout, R9 MERGE byte-equal. Lesson 1 → new (engine short-circuit).
    const storedItems = [
      "unused row",      // R1 — no lesson targets this one
      "R2 stored",       // → contradict
      "R3 stored",       // → normalized-identical
      "R4 stored",       // → raw-superset
      "R5 stored long sentence here", // → normalized-restatement
      "R6 stored",       // → MERGE parse-pass (containing)
      "R7 stored",       // → MERGE parse-pass (re-worded)
      "R8 stored",       // → MERGE timeout
      "R9 stored",       // → MERGE byte-equal
    ];
    storedItems.forEach((item, i) => {
      insertRow(db, { item, score: 1, lastSeen: SC - 10, embedding: unitVec(100 + i) });
    });
    const lessons = ["L1 brand new fact", "L2", "R3  STORED.", "R4 stored plus more", "R5 stored long", "R6 other words entirely", "R7 other words entirely", "R8 other words entirely", "R9 other words entirely"];
    // lesson i (i ≥ 1) → the vector of row i (id i+1, sim 1.0); lesson 0 → a fresh vector (no candidate)
    const map: Record<string, number[]> = {};
    lessons.forEach((l, i) => { map[`query:${l}`] = i === 0 ? unitVec(300) : unitVec(100 + i); });
    const embed = makeEmbed(map);
    // lesson i (i ≥ 1) matches row i (id i+1): lesson 1 → no candidate (fresh vector)
    const q = (i: number) => `{"action":"match","rowId":${i + 1}}`;
    // C3.5 per-lesson pipeline: a match lesson's enrichment (MERGE) runs BEFORE
    // the next lesson's COMPARE — the script below is the REAL call order
    // (interleaved), not batched COMPAREs-then-MERGEs.
    const llm = scriptLlmCall(
      lessons.map(l => `- ${l}`).join("\n"),
      `{"action":"contradict","rowId":2}`,   // L2 COMPARE
      q(2),                                  // L3 COMPARE (normalized-identical → no MERGE)
      q(3),                                  // L4 COMPARE (raw-superset → no MERGE)
      q(4),                                  // L5 COMPARE (normalized-restatement → no MERGE)
      q(5), "R6 stored; appended fact",       // L6 COMPARE → MERGE parse-pass (containing) (row 6)
      q(6), "reject me",                      // L7 COMPARE → MERGE parse-pass (re-worded — accepted at face value) (row 7)
      q(7), null,                             // L8 COMPARE → MERGE timeout (row 8)
      q(8), "R9 stored",                      // L9 COMPARE → MERGE byte-equal (row 9)
    );

    // C3.5: the engine selects from the unmerged set — seed the session the nine
    // lessons EXTRACT from (≤24K → one chunk; the content bytes are unasserted
    // here — the token map is the point).
    seedUnmerged(PA, contentOfChars(400));
    const res = await runMerge(configFor(), embed.fn, llm.fn);
    const decisions = lines.filter(l => l.startsWith("LTROW MERGE-DECISION "));
    expect(decisions).toHaveLength(9);
    expect(decisions).toContain("LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none");
    expect(decisions).toContain("LTROW MERGE-DECISION action=contradict rowId=2 top=1.0000 by=llm enrich=none");
    expect(decisions).toContain("LTROW MERGE-DECISION action=match rowId=3 top=1.0000 by=llm enrich=none");     // normalized-identical
    expect(decisions).toContain("LTROW MERGE-DECISION action=match rowId=4 top=1.0000 by=llm enrich=rewrite");   // raw-superset
    expect(decisions).toContain("LTROW MERGE-DECISION action=match rowId=5 top=1.0000 by=llm enrich=none");     // normalized-restatement
    expect(decisions).toContain("LTROW MERGE-DECISION action=match rowId=6 top=1.0000 by=llm enrich=rewrite");   // MERGE parse-pass (containing)
    expect(decisions).toContain("LTROW MERGE-DECISION action=match rowId=7 top=1.0000 by=llm enrich=rewrite");   // MERGE parse-pass (re-worded — decision B)
    expect(decisions).toContain("LTROW MERGE-DECISION action=match rowId=8 top=1.0000 by=llm enrich=rejected");  // MERGE timeout
    expect(decisions).toContain("LTROW MERGE-DECISION action=match rowId=9 top=1.0000 by=llm enrich=none");     // MERGE byte-equal
    expect(res.decisions).toHaveLength(9);
    expect(rows().some(r => r.item === "R2 stored")).toBe(false); // contradict = net deletion
    expect(rows().find(r => r.id === 7)?.item).toBe("reject me"); // the re-worded merge became the row text (parse-pass — no containment gate)
  });

  it("the MERGE-SKIP EXTRACT-failure path — signal=\"extract-failed\" with reasons timeout / parse-fail (the byte shapes)", async () => {
    const C = contentOfChars(300);
    seedUnmerged(PA, C);
    // (a) timeout — first EXTRACT call no-text → IMMEDIATE failure (no retry, lock rule 1)
    let llm = scriptLlmCall(null);
    let res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
    expect(llm.count()).toBe(1);
    expect(lines).toContain(`LTROW MERGE-SKIP reason=timeout session=${basename(PA)} signal="extract-failed"`);
    expect(res.sessionsFailed).toEqual([PA]);
    // (b) parse-fail — garbage twice
    llm = scriptLlmCall("bad", "bad");
    res = await runMerge(configFor(), makeEmbed().fn, llm.fn);
    expect(llm.count()).toBe(2);
    expect(lines).toContain(`LTROW MERGE-SKIP reason=parse-fail session=${basename(PA)} signal="extract-failed"`);
    expect(res.sessionsFailed).toEqual([PA]);
  });

  it("per-lesson ordering and completeness — CANDIDATES first then exactly one of DECISION|SKIP; the query embed-null failure has NO CANDIDATES line; the zero-lesson session has no per-lesson lines; one MODE (first) + one PRUNED (last) per run", async () => {
    const v = unitVec(9);
    insertRow(db, { item: "stored for match", score: 1, lastSeen: SC - 10, embedding: v });
    seedUnmerged(PA, contentOfChars(300, "aaa"), "2026-01-01T00:00:00.000Z");
    seedUnmerged(PB, contentOfChars(300, "bbb"), "2026-01-02T00:00:00.000Z");
    // A: lesson 1 → match (CANDIDATES + DECISION); lesson 2 → query embed null (SKIP embed-null, no CANDIDATES) → session stops
    const embedMap: Record<string, number[]> = { [`query:stored for match`]: v };
    const embed = makeEmbed(embedMap);
    // override: "failing lesson" query → null
    const embedFn = async (text: string, kind: string) => {
      if (text === "failing lesson" && kind === "query") {
        embed.calls.push({ text, kind });
        return null;
      }
      return embed.fn(text, kind);
    };
    // call order: A's EXTRACT → A lesson 1's COMPARE → A stops (lesson 2 embed-null) → B's EXTRACT
    const llm = scriptLlmCall(
      "- stored for match\n- failing lesson", // A
      MATCH_JSON,                             // A lesson 1's COMPARE
      "(none)",                                // B (zero lessons)
    );
    const res = await runMerge(configFor(), embedFn as any, llm.fn);
    // run-level: exactly one MODE (first) + one PRUNED (last)
    expect(lines[0]).toBe("LTROW MODE ROWSTORE");
    expect(lines[lines.length - 1]).toMatch(/^LTROW PRUNED \d+$/);
    expect(lines.filter(l => l === "LTROW MODE ROWSTORE")).toHaveLength(1);
    expect(lines.filter(l => l.startsWith("LTROW PRUNED "))).toHaveLength(1);
    // per-lesson: CANDIDATES before its DECISION; exactly one of DECISION|SKIP per processed lesson
    const cand = lines.filter(l => l.startsWith("LTROW CANDIDATES "));
    const dec = lines.filter(l => l.startsWith("LTROW MERGE-DECISION "));
    const skip = lines.filter(l => l.startsWith("LTROW MERGE-SKIP "));
    expect(cand).toEqual(["LTROW CANDIDATES n=1 pairs=1:1.0000"]); // ONLY lesson 1's — the embed-null lesson has NONE
    expect(dec).toEqual(["LTROW MERGE-DECISION action=match rowId=1 top=1.0000 by=llm enrich=none"]);
    expect(skip).toEqual([`LTROW MERGE-SKIP reason=embed-null session=${basename(PA)} signal="failing lesson"`]);
    expect(lines.indexOf(cand[0])).toBeLessThan(lines.indexOf(dec[0]));
    // the zero-lesson session B: no per-lesson lines, no LESSONS line
    expect(lines.filter(l => l.includes(basename(PB)))).toHaveLength(0);
    // A failed (stop-session) → unmarked; B marked
    expect(res.sessionsFailed).toEqual([PA]);
    expect(res.sessionsMarkedMerged).toBe(1);
    expect(res.skipped).toEqual([{ sessionPath: PA, signalIndex: 1, reason: "embed-null" }]);
  });
});

// ─── the EXTRACT timeout constant + the per-class seam wiring (design §4.4) ─────────

describe("EXTRACT timeout constant + per-class seam wiring", () => {
  it("EXTRACT_LLM_TIMEOUT_MS = 300_000 — DRY-calibrated 2026-08-30 (extract p50=18.2s p90=24.7s max=61.1s; ≈5× the observed max, matching the C3 300s seam — which stays byte-identical and untouched)", () => {
    expect(EXTRACT_LLM_TIMEOUT_MS).toBe(300_000); // DRY-calibrated (was the deliberate 30-min emergency-watchdog start)
    expect(ROWSTORE_MERGE_LLM_TIMEOUT_MS).toBe(300_000); // C3's constant — unchanged
  });

  it("an injected llmCall serves ALL THREE classes in call order — per session, EXTRACT first (one per chunk, chunk order), then per-lesson COMPARE/MERGE (the production path with no injection stays hermetic)", async () => {
    const content = contentOfChars(50000, "aaa"); // 3 chunks
    seedUnmerged(PA, content);
    const v = unitVec(9);
    const stored = "stored match target";
    insertRow(db, { item: stored, score: 1, lastSeen: SC - 10, embedding: v });
    const lesson = "stored match target";
    const embed = makeEmbed({ [`query:${lesson}`]: v });
    const llm = scriptLlmCall(
      `- ${lesson}`, // chunk 1
      "(none)",      // chunk 2
      "(none)",      // chunk 3
      MATCH_JSON,    // COMPARE (the per-lesson call)
      "stored match target", // MERGE (byte-equal — present to prove class ordering when the ladder reaches it)
    );
    await runMerge(configFor(), embed.fn, llm.fn);
    const chunk1 = content.slice(0, 24000);
    const chunk2 = content.slice(24000, 48000);
    const chunk3 = content.slice(48000);
    expect(llm.prompts[0]).toBe(expectedExtractPrompt(chunk1)); // EXTRACT first
    expect(llm.prompts[1]).toBe(expectedExtractPrompt(chunk2)); // chunk order
    expect(llm.prompts[2]).toBe(expectedExtractPrompt(chunk3));
    expect(llm.prompts[3]).toContain("Decide how to merge ONE new signal into the store."); // COMPARE = C3's prompt
    expect(llm.count()).toBeGreaterThanOrEqual(4);
  });

  it("onLlmCall fires after every attempt of every class (retries included), with the attempt's wall time + the session path (the DRY latency-distribution source)", async () => {
    const C = contentOfChars(300);
    const v = unitVec(9);
    const stored = "stored for compare";
    insertRow(db, { item: stored, score: 1, lastSeen: SC - 10, embedding: v });
    seedUnmerged(PA, C);
    const lesson = "stored for compare";
    const embed = makeEmbed({ [`query:${lesson}`]: v });
    const events: Array<{ call: string; ms: number; session: string }> = [];
    const llm = scriptLlmCall("garbage", `- ${lesson}`, MATCH_JSON); // EXTRACT retry (2 attempts) + COMPARE
    await runMerge(configFor(), embed.fn, llm.fn, {
      onLlmCall: (callClass, durationMs, sessionPath) => events.push({ call: callClass, ms: durationMs, session: sessionPath }),
    } as RowStoreMergeOptions);
    expect(events.map(e => e.call)).toEqual(["extract", "extract", "compare"]); // every attempt, retries included
    expect(events.every(e => typeof e.ms === "number" && e.ms >= 0)).toBe(true);
    expect(events.every(e => e.session === PA)).toBe(true);
  });

  it("updateRowItemEmbeddingScoreAndLastSeen — ONE write of item + JSON embedding + score + last_seen (the additive storage surface)", () => {
    const v = unitVec(42);
    const id = insertRow(db, { item: "old", score: 1, lastSeen: 10, embedding: v });
    const v2 = unitVec(43);
    const changed = updateRowItemEmbeddingScoreAndLastSeen(db, id, "new text", v2, 7, SC);
    expect(changed).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ item: "new text", score: 7, lastSeen: SC });
    expect(rows()[0].embedding).toEqual(v2);
    expect(updateRowItemEmbeddingScoreAndLastSeen(db, 9999, "ghost", v2, 1, SC)).toBe(0); // absent id → 0
  });

  it("normalizeLesson — trim, lowercase, collapse whitespace, strip one trailing period (the shared normalizer recipe)", () => {
    expect(normalizeLesson("  Fix   THE build. ")).toBe("fix the build");
    expect(normalizeLesson("No trailing period")).toBe("no trailing period");
    expect(normalizeLesson("double..")).toBe("double."); // ONE trailing period only
    expect(normalizeLesson("")).toBe("");
  });
});
