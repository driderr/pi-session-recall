// test/correction-recency.test.ts — correction-recency-injection, unit A RED (task 2.1).
//
// ONE new file owns the whole NEW unit-A surface (C3.5 boundary rule — the existing
// C2/C3/C3.5/C4 test files keep their spec-pinned lines and are NOT modified here):
// (a) the correction config surface (D-9 / P6) — six keys, clamps, gates, marker-format
//     validation;
// (b) the @@CORR marker line class in unmerged_fresh_content (spec R7) — appended via
//     the existing join, the merge-state predicate unchanged, marker-only mergeable;
// (c) the corrected_at schema + write branches (D-2 / P2 / spec R1 + R3) — the six-column
//     DDL, the additive migration, self-ensure, set/refresh/preserve/drop-both;
// (d) the fold correction stream (D-1/D-3/D-6/D-10 / P3/P4/P7 / spec R2 + R6) —
//     sweep-before-extract, the pinned correction-extract prompt (design §4), the
//     per-line quarantine sentinels, failure isolation, mark-merged-strictly-last, the
//     CORROW OUTCOME bytes.
//
// Strict TDD: this file starts RED — (a) fails against the not-yet-parsed config keys
// (GREEN: 3.1); (c)–(d) fail against the not-yet-existing corrected_at column, the
// sweep, the correction stream, and the CORROW emitter (GREEN: 6.1/7.1). Every
// EXISTING file stays green (no collateral damage). A few boundary sub-assertions pin
// pre-change behavior (the append join, the merge-state predicate, double-apply) and
// pass in RED by design — the file as a whole is observed failing before 3.1–7.1.
//
// House mechanics (design §12): ONE in-memory better-sqlite3 via createRequire (no
// temp files) seeded with BOTH schemas (ensureSchema then ensureRowStoreSchema —
// mirroring production's single DB); vi.spyOn(logger, "log") for ALL log byte-asserts;
// no HTTP — every seam injected (embed / llmCall / nowMs / sessionCountOverride).
// The frozen correction-extract prompt fixture below is transcribed VERBATIM from
// design.md §4 (the code block, 90 lines) — design.md is the transcription source;
// the 8.2(e) wording check diffs it back. The exact export surface this file reaches
// is recorded at 8.2.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { basename } from "node:path";
import * as logger from "../logger.js";
import { DEFAULT_CONFIG, loadConfig, resetConfigCache, type SessionRecallConfig } from "../config.js";
import { vol } from "memfs";
import {
  ensureSchema,
  md5Content,
  readMergeQuarantine,
  sqliteAppendUnmergedFreshContent,
  sqliteReadUnmergedSessionSummaries,
} from "../summarizer.js";
import {
  ensureRowStoreSchema,
  insertRow,
  getRows,
  mergeSignalsIntoRowStore,
  type RowStoreMergeResult,
} from "../rowstore.js";
import * as rowstore from "../rowstore.js"; // unit-B RED (10.1(a)): namespace on purpose — the not-yet-existing getRecentCorrections must fail at CALL time (the pinned RED reason), not at import time (the house pattern, rowstore-injection.test.ts header)

// The part-(a) config tests read the yaml through a mocked homedir + memfs (the
// config.test.ts house pattern) — node:os/node:fs are intercepted for this file's
// module graph only; better-sqlite3 loads natively via createRequire (unaffected).
vi.mock("node:os", () => ({
  homedir: () => "/test/session-recall-config",
}));
vi.mock("node:fs", async () => {
  const { fs: memfsFs } = await import("memfs");
  return {
    default: memfsFs,
    ...memfsFs,
    watch: () => ({ close: () => {}, closeSync: () => {} }),
    unwatchFile: () => {},
    createReadStream: memfsFs.createReadStream,
    createWriteStream: memfsFs.createWriteStream,
    constants: memfsFs.constants,
  };
});

// ─── Constants ──────────────────────────────────────────────────────────────────────

const tmpRoot = "/test/session-recall-config";
const YAML_PATH = "/test/session-recall-config/.pi/agent/session-recall.yaml";

// ISO-8601 UTC, second precision, Z suffix — the same clock/format corrected_at stores
// (D-2/D-3). T2 > T1 (the re-correction vectors).
const T1 = "2026-09-03T12:34:56Z";
const T2 = "2026-09-05T09:00:00Z";

const DIM = 768;
const SC = 1084; // pinned run sessionCount (the test pin for last_seen / prune age)
const NOW = 1_700_000_000_000; // the injected run timestamp (sentinel keying / quarantine)

const P_MAIN = "2026-09-03T12-34-56-789Z_aa0001.jsonl";

const corrMarker = (ts: string, text: string): string => `@@CORR ${ts}@@ ${text}`;

/** The PRE-CHANGE long_term_rows DDL, verbatim from the pre-change rowstore.ts — the
 *  additive-migration input table (task 2.1(c)). */
const PRE_CHANGE_DDL = [
  "CREATE TABLE IF NOT EXISTS long_term_rows (",
  "  id INTEGER PRIMARY KEY,",
  "  item TEXT NOT NULL,",
  "  score INTEGER NOT NULL,",
  "  last_seen INTEGER NOT NULL,",
  "  embedding TEXT NOT NULL  -- JSON-serialized float32 vector",
  ");",
].join("\n");

// ─── The frozen correction-extract prompt (design.md §4, VERBATIM — 90 lines) ──────
// The two slot lines (${correction} / ${content}) are the ONLY variation — the block is
// byte-identical for any input (8.2(e) diffs this block back against design.md §4).

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

/** The assembled prompt for `correction` + `content` — the slot substitution is the
 *  ONLY variation. */
const expectedCorrectionPrompt = (correction: string, content: string): string =>
  CORRECTION_EXTRACT_PROMPT_LINES.map(l =>
    l === "${correction}" ? correction : l === "${content}" ? content : l,
  ).join("\n");

// ─── Shared mechanics (design §12 seams) ────────────────────────────────────────────

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

/** 768-dim unit vector with 1.0 at dimension idx — cosine 1 against itself, 0 against
 *  any other unit vector (deterministic match/no-match control under the 0.5 default
 *  threshold). */
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

/** The embed seam — records {text, kind} per call; vectors come from a
 *  `${kind}:${text}` map, else a deterministic per-text unit vector (same text →
 *  cosine 1; different text → cosine 0 < the 0.5 threshold). */
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

/** Deterministic session content of EXACTLY `chars` chars (the engine's char meter —
 *  JS UTF-16 .length; 32-char units + a tail). */
function contentOfChars(chars: number, tag = "aaa"): string {
  const unit = 32;
  let s = "";
  for (let i = 0; s.length + unit <= chars; i++) s += `sess-${tag} line ${String(i).padStart(4, "0")} ${"x".repeat(12)}\n`;
  s += "y".repeat(chars - s.length);
  return s;
}

const configFor = (over: Record<string, unknown> = {}): SessionRecallConfig =>
  ({ ...DEFAULT_CONFIG, ...over } as SessionRecallConfig);

let db: any;
let logSpy: ReturnType<typeof vi.spyOn>;
const lines: string[] = [];
const linesOf = (prefix: string): string[] => lines.filter(l => l.startsWith(prefix));

beforeEach(() => {
  resetConfigCache();
  vol.reset();
  lines.length = 0;
  logSpy = vi.spyOn(logger, "log").mockImplementation(m => lines.push(m));
  // ONE :memory: db with BOTH schemas (mirrors production's single DB).
  db = new Database(":memory:");
  ensureSchema(db);
  ensureRowStoreSchema(db);
});

afterEach(() => {
  resetConfigCache();
  logSpy.mockRestore();
  db.close();
});

function seedSession(path: string, vccContent: string | null = null): void {
  db.prepare(
    "INSERT OR REPLACE INTO session_summaries (session_path, version, summary, char_count, merge_count, updated_at) VALUES (?, 1, '', 0, 0, '2026-01-01T00:00:00.000Z')",
  ).run(path);
  if (vccContent !== null) {
    db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?").run(vccContent, path);
  }
}

const unmergedOf = (): string | null =>
  (db.prepare("SELECT unmerged_fresh_content FROM session_summaries WHERE session_path = ?").get(P_MAIN) as any)?.unmerged_fresh_content ?? null;

/** Seed a stored row with an explicit corrected_at — the unit-A runtime's insertRow does
 *  not take corrected_at (the sweep/fold owns it), so the fixtures seed via direct SQL
 *  (the house pattern for pre-existing rows). */
function seedRowWithCorrectedAt(item: string, correctedAt: string | null, score: number, lastSeen: number, embedding: number[]): number {
  const info = db.prepare("INSERT INTO long_term_rows (item, score, last_seen, embedding, corrected_at) VALUES (?, ?, ?, ?, ?)")
    .run(item, score, lastSeen, JSON.stringify(embedding), correctedAt);
  return Number(info.lastInsertRowid);
}

const rows = (): any[] => getRows(db);
const items = (): string[] => rows().map(r => r.item);
const idOf = (item: string): number => rows().find(r => r.item === item)!.id;
const correctedAtOf = (id: number): string | null =>
  (db.prepare("SELECT corrected_at FROM long_term_rows WHERE id = ?").get(id) as any)?.corrected_at ?? null;

/** The line's OWN corr_quarantine sentinel (task 2.1(d) / D-6 — NEVER the session's
 *  merge_quarantine). */
const corrSentinel = (line: string): { markerLine: string; failures: number; quarantinedAt: number | null } | null => {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`corr_quarantine:${md5Content(line)}`) as any;
  return row ? (JSON.parse(row.value) as { markerLine: string; failures: number; quarantinedAt: number | null }) : null;
};

/** The engine run — the default test pins (sessionCountOverride + nowMs) applied
 *  everywhere: the pins are about engine behavior (last_seen / sentinel keying), not
 *  config. */
async function runFold(
  scripted: Array<string | null>,
  opts: {
    overrides?: Record<string, unknown>;
    embedMap?: Record<string, number[]>; // the match/no-match vectors (the `${kind}:${text}` map)
    nowMs?: number;
    failCalls?: number[]; // call indices (0-based) that throw (the injected LLM failure)
    onCall?: (callIndex: number, unmerged: string | null) => void; // the mark-merged-strictly-last probe
  } = {},
): Promise<{ result: RowStoreMergeResult; prompts: string[]; embedCalls: Array<{ text: string; kind: string }> }> {
  const embed = makeEmbed(opts.embedMap);
  const llm = scriptLlmCall(...scripted);
  const failCalls = new Set(opts.failCalls ?? []);
  const llmCall = async (prompt: string): Promise<string | null> => {
    const idx = llm.prompts.length;
    opts.onCall?.(idx, unmergedOf());
    // Record the prompt BEFORE the failure check: a failed LLM call still SENT
    // its prompt, so it occupies its slot in the call sequence — idx must count
    // it even though the call throws (otherwise a run whose first call fails
    // would re-index every later call at 0 and no later call could succeed).
    const text = await llm.fn(prompt);
    if (failCalls.has(idx)) throw new Error("injected LLM failure");
    return text;
  };
  const result = await mergeSignalsIntoRowStore(db, configFor(opts.overrides), {
    embed: embed.fn,
    llmCall,
    sessionCountOverride: SC,
    nowMs: () => opts.nowMs ?? NOW,
  });
  return { result, prompts: llm.prompts, embedCalls: embed.calls };
}

/** The ${content} slot of a correction-extract prompt (between the SESSION CONTEXT
 *  sigils — the frozen block pins the exact line placement). */
const ctxSlot = (prompt: string): string =>
  prompt.split("=== SESSION CONTEXT START ===\n")[1].split("\n=== SESSION CONTEXT END ===")[0];

// ─── (a) the correction config surface (2.1(a) / D-9 / P6) ─────────────────────────

describe("unit A — the correction config surface (D-9 / P6)", () => {
  it("the six keys' defaults encode the pinned decisions (true / 7 / 30 / 3 / 5 / the default marker format)", () => {
    expect(DEFAULT_CONFIG.correctionDetectionEnabled).toBe(true);
    expect(DEFAULT_CONFIG.correctionWindowDays).toBe(7);
    expect(DEFAULT_CONFIG.correctionMaxWindowDays).toBe(30);
    expect(DEFAULT_CONFIG.correctionMinItems).toBe(3);
    expect(DEFAULT_CONFIG.correctionMaxItems).toBe(5);
    expect(DEFAULT_CONFIG.correctionMarkerFormat).toBe("@@CORR ${timestamp}@@");
    const cfg = loadConfig(tmpRoot); // no yaml — the defaults stand
    expect(cfg.correctionDetectionEnabled).toBe(true);
    expect(cfg.correctionWindowDays).toBe(7);
    expect(cfg.correctionMaxWindowDays).toBe(30);
    expect(cfg.correctionMinItems).toBe(3);
    expect(cfg.correctionMaxItems).toBe(5);
    expect(cfg.correctionMarkerFormat).toBe("@@CORR ${timestamp}@@");
  });

  it("number clamps: below-min and above-max pin to the bound ([1,365] / [7,365] / [1,50] / [1,50]); in-range passes through", () => {
    vol.fromJSON({
      [YAML_PATH]:
        "correctionWindowDays: 0\n" +
        "correctionMaxWindowDays: 999\n" +
        "correctionMinItems: 0\n" +
        "correctionMaxItems: 99\n",
    });
    const cfg = loadConfig(tmpRoot);
    expect(cfg.correctionWindowDays).toBe(1);
    expect(cfg.correctionMaxWindowDays).toBe(365);
    expect(cfg.correctionMinItems).toBe(1);
    expect(cfg.correctionMaxItems).toBe(50);
    vol.fromJSON({
      [YAML_PATH]:
        "correctionWindowDays: 14\n" +
        "correctionMaxWindowDays: 45\n" +
        "correctionMinItems: 10\n" +
        "correctionMaxItems: 25\n",
    });
    const within = loadConfig(tmpRoot);
    expect(within.correctionWindowDays).toBe(14);
    expect(within.correctionMaxWindowDays).toBe(45);
    expect(within.correctionMinItems).toBe(10);
    expect(within.correctionMaxItems).toBe(25);
  });

  it("non-integer numbers floor (house pattern: Number.isFinite + Math.floor + clamp)", () => {
    vol.fromJSON({ [YAML_PATH]: "correctionWindowDays: 29.9\n" });
    expect(loadConfig(tmpRoot).correctionWindowDays).toBe(29);
  });

  it("the boolean gate: non-boolean input keeps the default (true)", () => {
    vol.fromJSON({ [YAML_PATH]: "correctionDetectionEnabled: \"yes\"\n" });
    expect(loadConfig(tmpRoot).correctionDetectionEnabled).toBe(true);
    vol.fromJSON({ [YAML_PATH]: "correctionDetectionEnabled: 0\n" });
    expect(loadConfig(tmpRoot).correctionDetectionEnabled).toBe(true);
  });

  it("the marker format: trimmed, non-empty, exactly one ${timestamp}; zero or two placeholders → the default is kept", () => {
    vol.fromJSON({ [YAML_PATH]: "correctionMarkerFormat: \"  @@CORR ${timestamp}@@  \"\n" });
    expect(loadConfig(tmpRoot).correctionMarkerFormat).toBe("@@CORR ${timestamp}@@");
    vol.fromJSON({ [YAML_PATH]: "correctionMarkerFormat: \"[[ ${timestamp} ]]\"\n" });
    expect(loadConfig(tmpRoot).correctionMarkerFormat).toBe("[[ ${timestamp} ]]");
    vol.fromJSON({ [YAML_PATH]: "correctionMarkerFormat: \"@@CORR @@\"\n" });
    expect(loadConfig(tmpRoot).correctionMarkerFormat).toBe("@@CORR ${timestamp}@@");
    vol.fromJSON({ [YAML_PATH]: "correctionMarkerFormat: \"@@CORR ${timestamp}@@ ${timestamp}@@\"\n" });
    expect(loadConfig(tmpRoot).correctionMarkerFormat).toBe("@@CORR ${timestamp}@@");
    vol.fromJSON({ [YAML_PATH]: "correctionMarkerFormat: \"   \"\n" });
    expect(loadConfig(tmpRoot).correctionMarkerFormat).toBe("@@CORR ${timestamp}@@");
  });
});

// ─── (b) the @@CORR marker line class (2.1(b) / spec R7) ────────────────────────────

describe("unit A — the marker line class in unmerged_fresh_content (spec R7)", () => {
  it("a marker line is appended through the existing --- join; the VCC bytes and the merge-state predicate are unchanged", () => {
    seedSession(P_MAIN, "sess line one\nsess line two");
    const marker = corrMarker(T1, "use pwsh");
    sqliteAppendUnmergedFreshContent(db, P_MAIN, marker);
    expect(unmergedOf()).toBe(`sess line one\nsess line two\n---\n${marker}`);
    // the merge-state predicate (IS NOT NULL AND length > 0) still sees the session
    const unmerged = sqliteReadUnmergedSessionSummaries(db);
    expect(unmerged.map(s => s.session_path)).toContain(P_MAIN);
    expect(unmerged.find(s => s.session_path === P_MAIN)!.unmerged_fresh_content)
      .toBe(`sess line one\nsess line two\n---\n${marker}`);
  });

  it("a marker-only backlog (no VCC lines) is mergeable — the predicate is unchanged", () => {
    seedSession(P_MAIN, corrMarker(T1, "use pwsh"));
    expect(sqliteReadUnmergedSessionSummaries(db).map(s => s.session_path)).toContain(P_MAIN);
  });
});

// ─── (c) the corrected_at schema (2.1(c) / D-2 / P2 / spec R1) ──────────────────────

describe("unit A — the corrected_at schema (D-2 / P2 / spec R1)", () => {
  it("the fresh-DB DDL has exactly the six columns; corrected_at is nullable (no NOT NULL, no non-NULL default); no other schema additions", () => {
    const cols = db.prepare("PRAGMA table_info(long_term_rows)").all() as any[];
    expect(cols.map(c => c.name)).toEqual(["id", "item", "score", "last_seen", "embedding", "corrected_at"]);
    const ca = cols.find(c => c.name === "corrected_at")!;
    expect(ca.notnull).toBe(0);
    expect(ca.dflt_value).toBeNull();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all())
      .toEqual([{ name: "long_term" }, { name: "long_term_rows" }, { name: "meta" }, { name: "session_summaries" }]);
    expect(db.prepare("PRAGMA index_list(long_term_rows)").all()).toEqual([]);
  });

  it("double-apply is a no-op (existing rows untouched)", () => {
    const id = insertRow(db, { item: "Double apply fact", score: 1, lastSeen: 1, embedding: unitVec(0) });
    ensureRowStoreSchema(db);
    ensureRowStoreSchema(db);
    expect(rows().map(r => r.id)).toEqual([id]);
    expect(db.prepare("SELECT item, score, last_seen, embedding FROM long_term_rows WHERE id = ?").get(id))
      .toEqual({ item: "Double apply fact", score: 1, last_seen: 1, embedding: JSON.stringify(unitVec(0)) });
  });

  it("the additive migration: a pre-change table with rows + meta sentinels gains the column (no error, no rebuild); pre-existing rows read corrected_at = NULL byte-unchanged", () => {
    db.exec("DROP TABLE long_term_rows");
    db.exec(PRE_CHANGE_DDL);
    const emb = unitVec(1);
    db.prepare("INSERT INTO long_term_rows (item, score, last_seen, embedding) VALUES (?, 3, 7, ?)").run("Pre-change row", JSON.stringify(emb));
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("merge_quarantine:abc123", JSON.stringify({ content: "x", failures: 1, quarantinedAt: null }));
    ensureRowStoreSchema(db); // ADD COLUMN — must not throw, must not rebuild
    const row = db.prepare("SELECT id, item, score, last_seen, embedding, corrected_at FROM long_term_rows WHERE item = ?").get("Pre-change row") as any;
    expect(row.id).toBe(1);
    expect(row.item).toBe("Pre-change row");
    expect(row.score).toBe(3);
    expect(row.last_seen).toBe(7);
    expect(row.embedding).toBe(JSON.stringify(emb)); // byte-identical
    expect(row.corrected_at).toBeNull();
    expect(db.prepare("SELECT value FROM meta WHERE key = ?").get("merge_quarantine:abc123")).toBeTruthy();
  });

  it("the public entries self-ensure: a fresh table dropped without an explicit ensureRowStoreSchema accepts an insert (corrected_at NULL)", () => {
    db.exec("DROP TABLE long_term_rows");
    const id = insertRow(db, { item: "Self-ensure fact", score: 1, lastSeen: 1, embedding: unitVec(0) });
    expect(id).toBe(1);
    expect(correctedAtOf(id)).toBeNull();
  });
});

// ─── (c) the corrected_at write branches (2.1(c) / D-2 / spec R3) ───────────────────

describe("unit A — the corrected_at write branches (D-2 / spec R3)", () => {
  const MATCH_JSON = (rowId: number): string => JSON.stringify({ action: "match", rowId });
  const CONTRADICT_JSON = (rowId: number): string => JSON.stringify({ action: "contradict", rowId });

  it("new (correction stream): the insert carries corrected_at = T, score 1, last_seen = the run's sessionCount", async () => {
    seedSession(P_MAIN, corrMarker(T1, "use pwsh"));
    const run = await runFold(["- On Windows, use pwsh, not bash"]);
    expect(run.result.sessionsMarkedMerged).toBe(1);
    expect(items()).toEqual(["On Windows, use pwsh, not bash"]);
    const r = rows()[0];
    expect(r.score).toBe(1);
    expect(r.lastSeen).toBe(SC);
    expect(correctedAtOf(r.id)).toBe(T1);
  });

  it("new (normal stream): the insert stays corrected_at = NULL", async () => {
    seedSession(P_MAIN, "sess line one\nsess line two");
    const run = await runFold(["- Normal lesson"]);
    expect(run.result.sessionsMarkedMerged).toBe(1);
    expect(items()).toEqual(["Normal lesson"]);
    expect(correctedAtOf(rows()[0].id)).toBeNull();
  });

  it("match (correction lesson → normal row): the row is PROMOTED — corrected_at = T, score + 1, last_seen = the run's sessionCount", async () => {
    const id = insertRow(db, { item: "Stored fact", score: 4, lastSeen: 3, embedding: unitVec(1) });
    seedSession(P_MAIN, corrMarker(T1, "use pwsh"));
    const run = await runFold(["- Stored fact", MATCH_JSON(id)], {
      embedMap: { "query:Stored fact": unitVec(1) },
    });
    expect(run.prompts).toHaveLength(2); // CORRECTION extract, then the per-lesson COMPARE
    expect(items()).toEqual(["Stored fact"]);
    expect(correctedAtOf(id)).toBe(T1);
    const r = rows().find(x => x.id === id)!;
    expect(r.score).toBe(5);
    expect(r.lastSeen).toBe(SC);
    expect(linesOf("LTROW MERGE-DECISION")).toEqual([
      `LTROW MERGE-DECISION action=match rowId=${id} top=1.0000 by=llm enrich=none`,
    ]);
  });

  it("match (normal lesson → correction row): the tag is PRESERVED — corrected_at stays T1 (D-2)", async () => {
    const id = seedRowWithCorrectedAt("Stored fact", T1, 4, 3, unitVec(1));
    seedSession(P_MAIN, "sess line one\nsess line two");
    const run = await runFold(["- Stored fact", MATCH_JSON(id)], { embedMap: { "query:Stored fact": unitVec(1) } });
    expect(run.prompts).toHaveLength(2); // EXTRACT, then the per-lesson COMPARE
    expect(items()).toEqual(["Stored fact"]);
    expect(correctedAtOf(id)).toBe(T1);
    const r = rows().find(x => x.id === id)!;
    expect(r.score).toBe(5);
    expect(r.lastSeen).toBe(SC);
    expect(rows()).toHaveLength(1);
  });

  it("re-correction (a NEWER correction lesson, T2 > T1, on the same stored row): the SAME row updates — score + 1, corrected_at = T2 (re-promoted), no second row", async () => {
    const id = seedRowWithCorrectedAt("Stored fact", T1, 4, 3, unitVec(1));
    seedSession(P_MAIN, corrMarker(T2, "stop that"));
    const run = await runFold(["- Stored fact", MATCH_JSON(id)], { embedMap: { "query:Stored fact": unitVec(1) } });
    expect(run.prompts).toHaveLength(2);
    expect(correctedAtOf(id)).toBe(T2);
    const r = rows().find(x => x.id === id)!;
    expect(r.score).toBe(5);
    expect(r.lastSeen).toBe(SC);
    expect(rows()).toHaveLength(1);
  });

  it("contradict on a correction lesson: drop-both byte-identical — the stored row is deleted, no insert (the C3 net-deletion pin stays)", async () => {
    const id = insertRow(db, { item: "Stored fact", score: 4, lastSeen: 3, embedding: unitVec(1) });
    seedSession(P_MAIN, corrMarker(T1, "use pwsh"));
    const run = await runFold(["- Opposite fact", CONTRADICT_JSON(id)], { embedMap: { "query:Opposite fact": unitVec(1) } });
    expect(run.prompts).toHaveLength(2);
    expect(rows()).toHaveLength(0);
    expect(linesOf("LTROW MERGE-DECISION")).toEqual([
      `LTROW MERGE-DECISION action=contradict rowId=${id} top=1.0000 by=llm enrich=none`,
    ]);
  });
});

// ─── (d) the fold correction stream (2.1(d) / D-1/D-3/D-6/D-10 / P3/P4/P7) ──────────

describe("unit A — the fold correction stream (spec R2 + R6)", () => {
  it("sweep-before-extract: the markers — each with its parsed timestamp — are pulled out BEFORE the EXTRACT stage (a FULL scan finds a mid-backlog marker); the normal EXTRACT input carries no marker bytes", async () => {
    const m1 = corrMarker(T1, "use pwsh");
    const m2 = corrMarker(T2, "stop that");
    seedSession(P_MAIN, `vcc line A\n${m1}\nvcc line B\n${m2}\nvcc line C`);
    const run = await runFold(["- L1", "- L2", "- N"]);
    // two CORRECTION calls (one per swept line, in backlog order), THEN the normal EXTRACT
    expect(run.prompts).toHaveLength(3);
    expect(run.prompts[0]).toContain(`=== CORRECTION START ===\nuse pwsh\n=== CORRECTION END ===`);
    expect(run.prompts[1]).toContain(`=== CORRECTION START ===\nstop that\n=== CORRECTION END ===`);
    const extractPrompt = run.prompts[2];
    expect(extractPrompt).toContain("=== SESSION CONTENT START ===");
    expect(extractPrompt).not.toContain("@@CORR");
    for (const l of ["vcc line A", "vcc line B", "vcc line C"]) expect(extractPrompt).toContain(l);
    expect(items()).toEqual(["L1", "L2", "N"]);
    expect(correctedAtOf(idOf("L1"))).toBe(T1);
    expect(correctedAtOf(idOf("L2"))).toBe(T2);
    expect(correctedAtOf(idOf("N"))).toBeNull();
    expect(run.result.sessionsMarkedMerged).toBe(1);
  });

  it("the pinned correction-extract prompt: byte-identical to design.md §4 (the frozen block + the two slots; a marker-only backlog has an empty context slot)", async () => {
    seedSession(P_MAIN, corrMarker(T1, "use pwsh — bash breaks"));
    const run = await runFold(["- A"]);
    expect(run.prompts).toHaveLength(1); // no normal content → no normal EXTRACT call
    expect(run.prompts[0]).toBe(expectedCorrectionPrompt("use pwsh — bash breaks", ""));
  });

  it("a changed marker format (one ${timestamp}) stays parseable — the sweep follows correctionMarkerFormat (F6)", async () => {
    seedSession(P_MAIN, `[[CORR ${T1}]] use pwsh\nvcc line A`);
    const run = await runFold(["- L", "- N"], { overrides: { correctionMarkerFormat: "[[CORR ${timestamp}]]" } });
    expect(run.prompts[0]).toContain(`=== CORRECTION START ===\nuse pwsh\n=== CORRECTION END ===`);
    expect(items()).toEqual(["L", "N"]);
    expect(correctedAtOf(idOf("L"))).toBe(T1);
    expect(correctedAtOf(idOf("N"))).toBeNull();
    expect(run.result.sessionsMarkedMerged).toBe(1);
  });

  it("one swept line → exactly one correction-extract call with the DISTINCT prompt (not the EXTRACT framing), and the lesson runs the EXISTING per-lesson pipeline (query embed → decide → write — no new machinery)", async () => {
    seedSession(P_MAIN, `vcc line A\n${corrMarker(T1, "use pwsh")}`);
    const run = await runFold(["- On Windows, use pwsh, not bash", "- N"]);
    expect(run.prompts).toHaveLength(2);
    expect(run.prompts[0]).toContain("=== CORRECTION START ===");
    expect(run.prompts[0]).not.toContain("=== SESSION CONTENT START ===");
    expect(run.prompts[1]).toContain("=== SESSION CONTENT START ===");
    expect(run.prompts[1]).not.toContain("=== CORRECTION START ===");
    // the same query→decide→write shape for both lessons (the seam call shapes match)
    expect(run.embedCalls.map(c => [c.text, c.kind])).toEqual([
      ["On Windows, use pwsh, not bash", "query"],
      ["On Windows, use pwsh, not bash", "document"],
      ["N", "query"],
      ["N", "document"],
    ]);
    expect(linesOf("LTROW LESSONS")).toEqual([`LTROW LESSONS n=2 session=${basename(P_MAIN)}`]);
    expect(linesOf("LTROW MERGE-DECISION")).toEqual([
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
      "LTROW MERGE-DECISION action=new rowId=- top=- by=engine enrich=none",
    ]);
    expect(run.result.sessionsMarkedMerged).toBe(1);
  });

  it("the context bound: each call's ${content} = the swept normal content (all @@CORR lines removed) truncated to the most recent mergeChunkChars (24K) chars; NO per-run cap (two pending lines → two calls)", async () => {
    const normal = contentOfChars(50000, "ctx");
    seedSession(P_MAIN, `${normal}\n${corrMarker(T1, "use pwsh")}\n${corrMarker(T2, "stop that")}`);
    const run = await runFold(
      ["- L1", "- L2", "(none)", "(none)", "(none)"],
      { overrides: { lessonExtractMaxPerRun: 50 } }, // keep the run-cap out of this pin
    ); // 50K / 24K → 3 EXTRACT chunks + 2 CORRECTION calls = 5 prompts
    expect(run.prompts).toHaveLength(5);
    expect(ctxSlot(run.prompts[0])).toBe(normal.slice(-24000));
    expect(ctxSlot(run.prompts[1])).toBe(normal.slice(-24000));
    expect(run.prompts.slice(2).every(p => !p.includes("@@CORR"))).toBe(true);
    expect(items()).toEqual(["L1", "L2"]);
    expect(run.result.sessionsMarkedMerged).toBe(1);
  });

  it("a session with swept lines but zero normal lessons is NOT zero-work — the correction stream ran first, and the session is marked merged", async () => {
    seedSession(P_MAIN, corrMarker(T1, "use pwsh"));
    const snapshots: (string | null)[] = [];
    const run = await runFold(["- A"], { onCall: (i, u) => snapshots.push(u) });
    expect(run.prompts).toHaveLength(1);
    expect(run.prompts[0]).toContain("=== CORRECTION START ===");
    expect(items()).toEqual(["A"]);
    expect(run.result.sessionsMarkedMerged).toBe(1);
    expect(unmergedOf()).toBeNull();
    expect(snapshots.every(u => u !== null)).toBe(true); // still unmerged at every LLM call
    expect(linesOf("LTROW LESSONS")).toEqual([`LTROW LESSONS n=1 session=${basename(P_MAIN)}`]);
  });

  it("mark-merged strictly last: a mixed session is unmarked at its LAST LLM call (the correction write + the normal write both precede it), and merged only after", async () => {
    seedSession(P_MAIN, `vcc line A\n${corrMarker(T1, "use pwsh")}`);
    const snapshots: (string | null)[] = [];
    const run = await runFold(["- A", "- N"], { onCall: (i, u) => snapshots.push(u) });
    expect(run.prompts).toHaveLength(2);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every(u => u !== null)).toBe(true);
    expect(unmergedOf()).toBeNull();
    expect(run.result.sessionsMarkedMerged).toBe(1);
  });

  it("a valid (none) consumes the line — no row, CORROW status=none, the session is marked merged", async () => {
    seedSession(P_MAIN, `vcc line A\n${corrMarker(T1, "use pwsh")}`);
    const run = await runFold(["(none)", "(none)"]);
    expect(rows()).toHaveLength(0);
    expect(unmergedOf()).toBeNull();
    expect(run.result.sessionsMarkedMerged).toBe(1);
    expect(linesOf("CORROW OUTCOME")).toEqual([`CORROW OUTCOME status=none corrected_at=${T1} -`]);
  });

  // Failure isolation — the three failure modes share the same isolation pins.
  const marker = corrMarker(T1, "use pwsh");
  const failureVariants: Array<[string, Array<string | null>, number[] | undefined, number, string]> = [
    ["no-text (null) — fails immediately, no retry", [null, "- N lesson"], undefined, 2, "llm-error"],
    ["garbage after the retry ladder — exactly one retry", ["- A\n- B", "- A\n- B", "- N lesson"], undefined, 3, "malformed-output"],
    ["LLM error — the retry ladder fires", ["- N lesson"], [0, 1], 3, "llm-error"],
  ];
  for (const [name, script, failCalls, llmCalls, reason] of failureVariants) {
    it(`failure independence (${name}): the normal stream still runs and is written with corrected_at = NULL; the failed line is RETAINED with a strike on its OWN sentinel (never the session's merge_quarantine); the session stays unmarked; no partial row`, async () => {
      seedSession(P_MAIN, `vcc line A\n${marker}`);
      const run = await runFold(script, { failCalls });
      expect(run.prompts).toHaveLength(llmCalls);
      if (name.startsWith("garbage")) expect(run.prompts[0]).toBe(run.prompts[1]); // the retry re-issues the same prompt
      expect(items()).toEqual(["N lesson"]);
      expect(correctedAtOf(rows()[0].id)).toBeNull();
      expect(unmergedOf()).not.toBeNull();
      expect(unmergedOf()!).toContain(marker); // the failed line is RETAINED (not consumed)
      expect(corrSentinel(marker)).toEqual({ markerLine: marker, failures: 1, quarantinedAt: null });
      expect(readMergeQuarantine(db, P_MAIN)).toBeNull(); // NEVER the session's merge_quarantine
      expect(linesOf("CORROW OUTCOME")).toEqual([`CORROW OUTCOME status=quarantine corrected_at=${T1} reason=${reason}`]);
    });
  }

  it("the prompt contract is all-or-nothing: a prefixed line rejects the WHOLE output (no salvage) — no row + the failure path", async () => {
    seedSession(P_MAIN, marker);
    const run = await runFold(["Reply: - A", "Reply: - A"]);
    expect(run.prompts).toHaveLength(2); // garbage → one retry → still garbage
    expect(rows()).toHaveLength(0);
    expect(unmergedOf()!).toContain(marker);
    expect(corrSentinel(marker)).toEqual({ markerLine: marker, failures: 1, quarantinedAt: null });
    expect(linesOf("CORROW OUTCOME")).toEqual([`CORROW OUTCOME status=quarantine corrected_at=${T1} reason=malformed-output`]);
  });

  it("the CORROW OUTCOME bytes (P4): ok → lesson=\"<…>\" (a >120-char lesson truncates to 120 + …, log-only); none → detail = -; quarantine → reason=<…>; exactly one line per marker line processed", async () => {
    const long = "L".repeat(121);
    const m1 = corrMarker(T1, "use pwsh");
    const m2 = corrMarker(T2, "stop that");
    const m3 = corrMarker(T2, "wrong port");
    seedSession(P_MAIN, `${m1}\n${m2}\n${m3}`);
    const run = await runFold([`- ${long}`, "(none)", null]);
    expect(run.prompts).toHaveLength(3);
    expect(items()).toEqual([long]); // the row keeps the full 121-char lesson (the truncation is log-only)
    expect(linesOf("CORROW OUTCOME")).toEqual([
      `CORROW OUTCOME status=ok corrected_at=${T1} lesson="${long.slice(0, 120)}…"`,
      `CORROW OUTCOME status=none corrected_at=${T2} -`,
      `CORROW OUTCOME status=quarantine corrected_at=${T2} reason=llm-error`,
    ]);
    expect(lines.filter(l => l.startsWith("CORROW "))).toHaveLength(3);
  });

  it("the terminal quarantine: 3 strikes → quarantinedAt set; the session becomes mark-merged with the line retained in the sentinel; no retry before the 7-day recheck; a fold after 7 days retries the sentinel's line", async () => {
    seedSession(P_MAIN, marker);
    for (let n = 1; n <= 3; n++) {
      const run = await runFold([null], { nowMs: NOW + n * 86400000 });
      expect(run.prompts).toHaveLength(1); // no-text — immediate failure, no retry
      expect(run.result.sessionsMarkedMerged).toBe(n === 3 ? 1 : 0);
    }
    expect(corrSentinel(marker)).toEqual({ markerLine: marker, failures: 3, quarantinedAt: NOW + 3 * 86400000 });
    expect(unmergedOf()).toBeNull(); // terminal quarantine lets the session mark-merged; the line moves to the sentinel
    expect(linesOf("CORROW OUTCOME")).toHaveLength(3);
    // before the 7-day recheck: no retry (the sentinel is active)
    const probe = await runFold([null], { nowMs: NOW + 3 * 86400000 + 3600000 });
    expect(probe.prompts).toHaveLength(0);
    expect(corrSentinel(marker)).toEqual({ markerLine: marker, failures: 3, quarantinedAt: NOW + 3 * 86400000 });
    expect(linesOf("CORROW OUTCOME")).toHaveLength(3); // no new line — no retry
    // after the 7-day recheck: the sentinel's line is retried; a success writes the row with corrected_at = T
    const retry = await runFold(["- On Windows, use pwsh, not bash"], { nowMs: NOW + 3 * 86400000 + 7 * 86400000 + 1 });
    expect(retry.prompts).toHaveLength(1);
    expect(retry.prompts[0]).toBe(expectedCorrectionPrompt("use pwsh", ""));
    expect(items()).toEqual(["On Windows, use pwsh, not bash"]);
    expect(correctedAtOf(rows()[0].id)).toBe(T1);
    expect(linesOf("CORROW OUTCOME")).toHaveLength(4);
    expect(linesOf("CORROW OUTCOME")[3]).toBe(`CORROW OUTCOME status=ok corrected_at=${T1} lesson="On Windows, use pwsh, not bash"`);
  });

  it("a failed line retries across two runs: run 1 strike 1 + the line retained + the normal stream written + the session unmarked; run 2 the retry succeeds — the line removed, the row written with corrected_at = T, the sentinel released", async () => {
    seedSession(P_MAIN, `vcc line A\n${marker}`);
    // run 1 — the correction fails (no-text); the normal stream is unblocked + written
    const run1 = await runFold([null, "- N lesson"]);
    expect(run1.prompts).toHaveLength(2);
    expect(items()).toEqual(["N lesson"]);
    expect(correctedAtOf(rows()[0].id)).toBeNull();
    expect(corrSentinel(marker)).toEqual({ markerLine: marker, failures: 1, quarantinedAt: null });
    expect(unmergedOf()).not.toBeNull();
    expect(unmergedOf()!).toContain(marker);
    // run 2 — the retry succeeds (the backlog now holds only the failed line)
    const run2 = await runFold(["- On Windows, use pwsh, not bash"], { nowMs: NOW + 86400000 });
    expect(run2.prompts).toHaveLength(1);
    expect(run2.prompts[0]).toBe(expectedCorrectionPrompt("use pwsh", ""));
    expect(items()).toEqual(["N lesson", "On Windows, use pwsh, not bash"]);
    const corrRow = rows().find(r => r.item === "On Windows, use pwsh, not bash")!;
    expect(correctedAtOf(corrRow.id)).toBe(T1);
    expect(unmergedOf()).toBeNull();
    expect(corrSentinel(marker)).toBeNull(); // the strike record is released on success
    expect(run2.result.sessionsMarkedMerged).toBe(1);
  });
});

// ─── unit B (10.1(a)) — the recency read: getRecentCorrections (D-8 / P5 / spec R5) ─
//
// Strict TDD: this block starts RED — `getRecentCorrections` does not exist in
// rowstore.ts yet (GREEN: 11.1). House RED pattern: the namespace import at the
// top is deliberate — the not-yet-existing export must fail at CALL time
// ("not a function" — the pinned RED reason), not at import time. Every unit-A
// test above stays green (no collateral damage).
//
// Clock discipline: the window is anchored to the real now (the read has no
// clock seam — LLM-free / network-free by construction, one `(db, config)`
// signature), so every fixture is relative to Date.now() with a ≥1-day margin
// from each window edge (second-level clock drift cannot flip an assertion).
// The EXACT edge (a row whose corrected_at equals the cutoff) is pinned by the
// SQL operator itself: the pinned query shape is a strict `corrected_at > ?`
// (in vs out per spec — the boundary row is OUT).
//
// The return shape is pinned here (the P5 "the exact bytes are pinned by the
// RED fixture" convention): { items: string[] (newest-first), windowDays:
// number (the EFFECTIVE window — the base or the widened value, for the
// header's `last {N}d`) }.

describe("unit B — the recency read getRecentCorrections (D-8 / P5 / spec R5)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  // D-2/P2 format: ISO-8601 UTC, second precision, Z suffix, no fractional
  // seconds — fixed-width, so lexicographic compare = chronological.
  const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const ago = (days: number): string => iso(Date.now() - days * DAY);

  const seedCorr = (item: string, correctedAt: string | null, score = 1, lastSeen = 1): number =>
    seedRowWithCorrectedAt(item, correctedAt, score, lastSeen, unitVec(item.length % 16));

  it("rows within the window, newest-first, capped; NULL-corrected_at and out-of-window rows excluded (the D-9 defaults — DEFAULT_CONFIG, no yaml)", () => {
    seedCorr("old-40d", ago(40)); // outside even the widened 30d window
    seedCorr("mid-25d", ago(25)); // inside the 30d window only
    seedCorr("mid-10d", ago(10)); // inside the 30d window only
    seedCorr("new-2d", ago(2)); // inside the base 7d window
    seedCorr("new-1d", ago(1)); // inside the base 7d window
    seedRowWithCorrectedAt("normal-row", null, 9, 100, unitVec(0)); // NULL — never eligible (score irrelevant)

    const r = rowstore.getRecentCorrections(db, DEFAULT_CONFIG);
    // 2 rows in the base 7d window < correctionMinItems (3) → widens to 30d;
    // the 30d window holds new-1d, new-2d, mid-10d, mid-25d (4 ≤ the cap of 5).
    expect(r).toEqual({ items: ["new-1d", "new-2d", "mid-10d", "mid-25d"], windowDays: 30 });
  });

  it("the correctionMaxItems (5) cap boundary: exactly 5 rows in the window → all 5 (no truncation); 6 rows → the 5 newest", () => {
    for (let d = 1; d <= 5; d++) seedCorr(`cap-${d}d`, ago(d));
    const r5 = rowstore.getRecentCorrections(db, DEFAULT_CONFIG);
    // 5 in the base window ≥ correctionMinItems (3) → NO widen; 5 ≤ cap → all 5.
    expect(r5).toEqual({ items: ["cap-1d", "cap-2d", "cap-3d", "cap-4d", "cap-5d"], windowDays: 7 });

    seedCorr("cap-6d", ago(6));
    const r6 = rowstore.getRecentCorrections(db, DEFAULT_CONFIG);
    expect(r6).toEqual({ items: ["cap-1d", "cap-2d", "cap-3d", "cap-4d", "cap-5d"], windowDays: 7 });
    expect(r6.items).not.toContain("cap-6d"); // the 6th-newest is dropped at the cap
  });

  it("the 7/30 rule — NO widen at the boundary: exactly correctionMinItems (3) rows in the base window → effective 7d (the rows are the 7d rows only)", () => {
    seedCorr("in-7d-1", ago(1));
    seedCorr("in-7d-2", ago(2));
    seedCorr("in-7d-3", ago(3));
    seedCorr("only-30d-10", ago(10)); // in the 30d window only — must NOT appear
    seedCorr("only-30d-25", ago(25));
    const r = rowstore.getRecentCorrections(db, DEFAULT_CONFIG);
    expect(r).toEqual({ items: ["in-7d-1", "in-7d-2", "in-7d-3"], windowDays: 7 });
  });

  it("the 7/30 rule — widen below the boundary: fewer than correctionMinItems (3) rows in the base window → effective 30d (all 30d rows, newest-first, capped at 5)", () => {
    seedCorr("in-7d-1", ago(1));
    seedCorr("in-7d-2", ago(2)); // 2 < 3 → widen
    seedCorr("only-30d-10", ago(10));
    seedCorr("only-30d-20", ago(20));
    seedCorr("only-30d-25", ago(25));
    seedCorr("out-40d", ago(40)); // outside even the widened window
    const r = rowstore.getRecentCorrections(db, DEFAULT_CONFIG);
    expect(r).toEqual({ items: ["in-7d-1", "in-7d-2", "only-30d-10", "only-30d-20", "only-30d-25"], windowDays: 30 });
  });

  it("the same-second corrected_at tie-break: identical timestamps order by id DESC (deterministic — a second run over the same store is byte-identical)", () => {
    const ts = ago(1);
    seedCorr("tie-a", ts);
    seedCorr("tie-b", ts);
    seedCorr("tie-c", ts); // id 3 — the newest id, first in the result
    const r1 = rowstore.getRecentCorrections(db, DEFAULT_CONFIG);
    expect(r1).toEqual({ items: ["tie-c", "tie-b", "tie-a"], windowDays: 7 }); // 3 ≥ 3 → no widen
    const r2 = rowstore.getRecentCorrections(db, DEFAULT_CONFIG);
    expect(r2).toEqual(r1); // repeated run: byte-identical
  });

  it("the pinned query shape (P5 / spec R5): the exact fetch SQL — single-select item, the strict corrected_at > ? edge, corrected_at DESC + id DESC, LIMIT ?; NO prepared statement selects the embedding column", () => {
    seedCorr("q-1d", ago(1));
    seedCorr("q-2d", ago(2));
    seedCorr("q-3d", ago(3));
    const prepareSpy = vi.spyOn(db, "prepare");
    let prepared: string[] = [];
    try {
      rowstore.getRecentCorrections(db, DEFAULT_CONFIG);
      prepared = prepareSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      prepareSpy.mockRestore();
    }
    const selects = prepared.filter((s) => /^\s*SELECT\b/i.test(s));
    expect(selects).toContain(
      "SELECT item FROM long_term_rows WHERE corrected_at IS NOT NULL AND corrected_at > ? ORDER BY corrected_at DESC, id DESC LIMIT ?",
    );
    for (const s of selects) expect(s).not.toMatch(/embedding/i);
  });

  it("the read is agnostic to embedding content (LLM-free / network-free — one (db, config) signature, no seams, pure SQL): a row whose embedding column holds invalid JSON (pre-validation corruption) is ranked and returned like any other — no throw", () => {
    seedCorr("corrupt-sibling", ago(1));
    const bad = seedCorr("corrupt-embedding-row", ago(2));
    db.prepare("UPDATE long_term_rows SET embedding = ? WHERE id = ?").run("{not-valid-json", bad);
    expect(() => getRows(db)).toThrow(); // prove the corruption is real (the getRows contract)
    const r = rowstore.getRecentCorrections(db, DEFAULT_CONFIG); // no throw
    expect(r).toEqual({ items: ["corrupt-sibling", "corrupt-embedding-row"], windowDays: 30 }); // 2 < 3 → widen
  });

  it("the window edge is a strict > (the pinned SQL operator — the boundary row is OUT): with drift-proof margins, 1 day inside the effective cutoff is IN and 1 day outside is OUT", () => {
    seedCorr("edge-in-29d", ago(29)); // 1 day inside the effective 30d cutoff
    seedCorr("edge-out-31d", ago(31)); // 1 day outside it
    const r = rowstore.getRecentCorrections(db, DEFAULT_CONFIG); // 0 in 7d → widens to 30d
    expect(r).toEqual({ items: ["edge-in-29d"], windowDays: 30 });
    expect(r.items).not.toContain("edge-out-31d");
  });

  it("empty window → empty result (no rows, no throw); the widen still applies to the reported effective window (0 < 3 → 30d)", () => {
    expect(rowstore.getRecentCorrections(db, DEFAULT_CONFIG)).toEqual({ items: [], windowDays: 30 }); // empty store
    seedCorr("stale-40d", ago(40)); // outside even the widened window
    seedRowWithCorrectedAt("null-row", null, 1, 1, unitVec(0)); // NULL — never eligible
    expect(rowstore.getRecentCorrections(db, DEFAULT_CONFIG)).toEqual({ items: [], windowDays: 30 });
  });

  it("self-ensure: a completely fresh DB (ensureRowStoreSchema never called) works — the schema self-ensure is the function's first statement (spec R1 — the 'every public entry point' list extends with getRecentCorrections)", () => {
    const bare = new Database(":memory:");
    try {
      expect(rowstore.getRecentCorrections(bare, DEFAULT_CONFIG)).toEqual({ items: [], windowDays: 30 });
    } finally {
      bare.close();
    }
  });

  it("the D-9 defaults drive the read with NO yaml present (loadConfig over the empty memfs home — the 10.1(b) 'new config defaults' bullet): window 7 / widen 30 / min 3 / max 5", () => {
    const cfg = loadConfig(tmpRoot); // no yaml — the defaults stand
    seedCorr("d-1d", ago(1));
    seedCorr("d-2d", ago(2)); // 2 in the base 7d window < 3 → widen to 30d
    seedCorr("d-15d", ago(15));
    expect(rowstore.getRecentCorrections(db, cfg)).toEqual({ items: ["d-1d", "d-2d", "d-15d"], windowDays: 30 });
  });
});
