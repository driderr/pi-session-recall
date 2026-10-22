// recall-flush.test.ts — /recall-flush (recall-flush-plan.md §6.1): the
// user-invoked uncapped drain of the unmerged backlog. The 10 §6.1 unit tests:
// (1) session-start keeps the default cap — wired in test/session-start-merge-
// flow.test.ts; (2)–(3) the engine cap parameter (extractCapOverride); (4)–(10)
// the flush loop (runRecallFlush).
//
// House mechanics (design §12): in-memory better-sqlite3 via createRequire (no
// temp files); vi.spyOn(logger, "log") for ALL log byte-asserts; memfs homedir
// (unique per file — no cross-file collisions). NO HTTP in the unit suite —
// every seam is injected: db / llmBusy / sleepMs via runRecallFlush's opts, and
// the engine's embed / llmCall / nowMs / sessionCountOverride via the
// mergeSignalsIntoRowStore module mock, which DELEGATES to the REAL engine
// (vi.importActual) so the flush loop drives the production pipeline (selection,
// EXTRACT, strikes, mark-merged, byte-pinned LTROW lines) — no fold logic is
// copied into this test.
//
// Strict TDD: this file starts RED against the not-yet-existing export
// (runRecallFlush from index.js) and the not-yet-existing engine option
// (extractCapOverride on RowStoreMergeOptions).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import * as logger from "../logger.js";
import { DEFAULT_CONFIG, loadConfigOnce, type SessionRecallConfig } from "../config.js";
import {
  ensureSchema,
  sqliteReadUnmergedSessionSummaries,
  sqliteCountUnmergedSessions,
  readMergeQuarantine,
  buildMergeModelPair,
  waitForLlmEndpointReady,
} from "../summarizer.js";
import { ensureEmbedServer } from "../embeddings.js";
import { ensureRowStoreSchema, getRows, mergeSignalsIntoRowStore, type RowStoreMergeOptions } from "../rowstore.js";
import { G } from "../types.js";
import { runRecallFlush } from "../index.js";

// Unique per-file memfs homedir (avoids cross-file memfs collisions).
const HOMEDIR = "/test/sr-recall-flush";

vi.mock("node:os", () => ({ homedir: () => "/test/sr-recall-flush" })); // inlined: the factory is hoisted above HOMEDIR
vi.mock("node:fs", async () => {
  const { fs } = await import("memfs");
  return {
    default: fs,
    ...fs,
    watch: () => ({ close: () => {}, closeSync: () => {} }),
    unwatchFile: () => {},
    createReadStream: fs.createReadStream,
    createWriteStream: fs.createWriteStream,
    constants: fs.constants,
  };
});

// config: loadConfigOnce is process-cached in production — the mock makes it
// per-test controllable (useRowStore on by default; the rowstore-off test flips
// it off).
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfigOnce: vi.fn(() => actual.DEFAULT_CONFIG) };
});

// embeddings: NO HTTP — the unit suite never probes or spawns the real 5002
// server (the deterministic no-op returns "ready"; unmocked, the flush's embed
// gate would probe 127.0.0.1:5002 from the suite).
vi.mock("../embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../embeddings.js")>();
  return {
    ...actual,
    ensureEmbedServer: vi.fn(async () => ({ status: "ready", source: "probe", port: 5002 })),
  };
});

// summarizer: the two 2026-10-07 fold-call-site seams (buildMergeModelPair /
// waitForLlmEndpointReady) are mocked so the flush suite stays hermetic — the real
// buildMergeModelPair would read the dev machine's models.json and the real wait
// would probe 127.0.0.1:5001 from the suite. Default null pair = wait never entered.
vi.mock("../summarizer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../summarizer.js")>();
  return {
    ...actual,
    buildMergeModelPair: vi.fn(() => null),
    waitForLlmEndpointReady: vi.fn(async () => true),
  };
});

// rowstore: the engine is mocked at the module boundary so runRecallFlush's loop
// is drivable hermetically; the mock DELEGATES to the real engine (importActual)
// with the injected seams — the real pipeline runs unmodified.
vi.mock("../rowstore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rowstore.js")>();
  return { ...actual, mergeSignalsIntoRowStore: vi.fn() };
});

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

type RealRowstore = Awaited<ReturnType<typeof vi.importActual<typeof import("../rowstore.js")>>>;

const SC = 1084; // pinned run sessionCount (last_seen / prune age)
const DIM = 768;

function createDb(): any {
  const db = new Database(":memory:");
  ensureSchema(db);         // session_summaries + long_term + meta (legacy schema)
  ensureRowStoreSchema(db); // long_term_rows (C2 DDL, self-ensure)
  return db;
}

// ─── Cloned helpers (test/rowstore-lessons.test.ts — house mechanics) ────────

/** 768-dim unit vector with 1.0 at dimension idx — cosine 1 against itself, 0
 *  against any other unit vector (deterministic match/no-match control under
 *  the 0.5 default threshold). */
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

/** The embed seam — vectors come from a `${kind}:${text}` map, else a
 *  deterministic per-text unit vector (same text → same vector → cosine 1;
 *  different text → cosine 0 < the 0.5 threshold). */
function makeEmbed(map: Record<string, number[]> = {}) {
  const calls: Array<{ text: string; kind: string }> = [];
  const fn = async (text: string, kind: string) => {
    calls.push({ text, kind });
    return map[`${kind}:${text}`] ?? unitVec(hashText(text));
  };
  return { fn, calls };
}

/** The llmCall seam — a scripted text/null sequence in call order (null = no text,
 *  the seam's real failure mode); repeats the last entry if the engine over-calls
 *  (a bug). */
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

const configFor = (over: Partial<SessionRecallConfig> = {}): SessionRecallConfig =>
  ({ ...DEFAULT_CONFIG, ...over });

// ─── Harness state ────────────────────────────────────────────────────────────

let db: any;
let messages: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let realRowstore: RealRowstore;

beforeEach(async () => {
  db = createDb();
  messages = [];
  logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
  G.__sessionRecallMergeInProgress__ = false;
  realRowstore = await vi.importActual<typeof import("../rowstore.js")>("../rowstore.js");
  vi.mocked(loadConfigOnce).mockReset().mockReturnValue(configFor({ useRowStore: true }));
  vi.mocked(ensureEmbedServer).mockReset().mockResolvedValue({ status: "ready", source: "probe", port: 5002 });
  vi.mocked(mergeSignalsIntoRowStore).mockReset();
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

const unmergedOf = (path: string): string | null =>
  (db.prepare("SELECT unmerged_fresh_content FROM session_summaries WHERE session_path = ?").get(path) as any)?.unmerged_fresh_content ?? null;

/** Wire the module-boundary engine mock to delegate to the REAL engine with the
 *  injected seams (embed / llmCall / nowMs / sessionCountOverride — the house
 *  "every seam is injected" rule). `before`/`after` run around each delegated
 *  call (the concurrent-append seam). Returns a call counter plus the options the
 *  most recent delegated run was given. */
function delegateEngine(
  embed: (text: string, kind: string) => Promise<number[] | null>,
  llm: (prompt: string) => Promise<string | null>,
  before?: (callNo: number) => void,
  after?: (callNo: number) => void,
): { calls: () => number; lastOpts: () => RowStoreMergeOptions | undefined } {
  let n = 0;
  const optsSeen: RowStoreMergeOptions[] = [];
  vi.mocked(mergeSignalsIntoRowStore).mockImplementation(async (dbArg: any, cfg: SessionRecallConfig, opts: any) => {
    n++;
    optsSeen.push(opts);
    before?.(n);
    const res = await realRowstore.mergeSignalsIntoRowStore(dbArg, cfg, {
      embed,
      llmCall: llm,
      sessionCountOverride: SC,
      nowMs: () => Date.now(), // the 7-day quarantine recheck window is anchored at the real now (pruneMergeQuarantine runs with Date.now())
      ...opts,
    });
    after?.(n);
    return res;
  });
  return { calls: () => n, lastOpts: () => optsSeen[optsSeen.length - 1] };
}

// ─── (2)–(3) Engine cap parameter (extractCapOverride) ────────────────────────

describe("recall-flush: engine cap parameter (extractCapOverride)", () => {
  const P = (i: number) => `/sessions/2026-03-0${i}T00-00-00-session.jsonl`;
  const T = (i: number) => `2026-03-0${i}T00:00:00.000Z`;
  const CONTENT = (i: number) => `content-${i} ` + "x".repeat(90);

  it("(2) extractCapOverride: 2 — five 1-call sessions → 2 started, 3 deferred, LTROW MERGE-DEFERRED sessions=3, deferred content byte-untouched", async () => {
    for (let i = 1; i <= 5; i++) seedUnmerged(P(i), CONTENT(i), T(i));
    const llm = scriptLlmCall("(none)");
    const res = await realRowstore.mergeSignalsIntoRowStore(db, configFor({ useRowStore: true }), {
      extractCapOverride: 2,
      embed: makeEmbed().fn,
      llmCall: llm.fn,
      sessionCountOverride: SC,
      nowMs: () => Date.now(),
    });
    expect(llm.count()).toBe(2); // exactly 2 EXTRACT calls — C, D, E's content is never touched
    expect(res.sessionsMarkedMerged).toBe(2);
    expect(res.deferredSessions).toBe(3);
    expect(res.sessionsFailed).toHaveLength(0);
    // the deferred sessions' content is byte-untouched (still unmerged)
    for (const i of [3, 4, 5]) expect(unmergedOf(P(i))).toBe(CONTENT(i));
    // the started ones are marked merged (unmerged cleared)
    for (const i of [1, 2]) expect(unmergedOf(P(i))).toBeNull();
    expect(messages).toEqual(["LTROW MODE ROWSTORE", "LTROW MERGE-DEFERRED sessions=3", "LTROW PRUNED 0"]);
  });

  it("(3) extractCapOverride: null — unlimited: eight 1-call sessions → all 8 start, 0 deferred, all marked, NO DEFERRED line", async () => {
    for (let i = 1; i <= 8; i++) seedUnmerged(P(i), CONTENT(i), T(i));
    const llm = scriptLlmCall("(none)");
    const res = await realRowstore.mergeSignalsIntoRowStore(db, configFor({ useRowStore: true }), {
      extractCapOverride: null,
      embed: makeEmbed().fn,
      llmCall: llm.fn,
      sessionCountOverride: SC,
      nowMs: () => Date.now(),
    });
    expect(llm.count()).toBe(8); // all 8 sessions' EXTRACT calls — nothing deferred
    expect(res.sessionsMarkedMerged).toBe(8);
    expect(res.deferredSessions).toBe(0);
    expect(res.sessionsFailed).toHaveLength(0);
    expect(sqliteCountUnmergedSessions(db)).toBe(0);
    expect(messages.filter(m => m.includes("LTROW MERGE-DEFERRED"))).toHaveLength(0); // none when 0
    expect(messages).toEqual(["LTROW MODE ROWSTORE", "LTROW PRUNED 0"]);
  });
});

// ─── (4)–(10) The flush loop (runRecallFlush) ─────────────────────────────────

describe("recall-flush: the flush loop (runRecallFlush)", () => {
  const P = (i: number) => `/sessions/2026-04-0${i}T00-00-00-session.jsonl`;
  const T = (i: number) => `2026-04-0${i}T00:00:00.000Z`;
  const CONTENT = (i: number) => `flush-content-${i} ` + "y".repeat(80);

  it("(4) loop terminates at 0 unmerged — six seeded sessions drain in TWO batched engine runs (cap 5 → 5+1); FLUSH DONE remaining=0 byte-pinned; flag cleared in finally", async () => {
    for (let i = 1; i <= 6; i++) seedUnmerged(P(i), CONTENT(i), T(i));
    const { calls, lastOpts } = delegateEngine(makeEmbed().fn, scriptLlmCall("(none)").fn);
    const out = await runRecallFlush({ db, sleepMs: async () => {} });
    const finalRunOpts = lastOpts();
    expect(finalRunOpts, "the flush must have delegated at least one engine run").toBeDefined();
    expect(finalRunOpts?.extractCapOverride).toBe(5); // the flush's batch — FLUSH RUN is mid-run progress (decided 2026-09-04)
    expect(calls()).toBe(2); // batched: run 1 takes 5 (the cap), run 2 takes the last one
    expect(messages.filter(m => m === "LTROW MODE ROWSTORE")).toHaveLength(2); // the engine ran exactly twice
    expect(sqliteCountUnmergedSessions(db)).toBe(0);
    expect(messages).toContain("FLUSH START unmerged=6");
    expect(messages).toContain("FLUSH RUN 1 marked=5 failed=0 deferred=1 remaining=1");
    expect(messages).toContain("FLUSH RUN 2 marked=1 failed=0 deferred=0 remaining=0");
    // runs = loop iterations (plan §3.2 pseudocode `for (run = 1; ; run++)`) — engine runs 1–2 + the drain-check iteration that breaks
    expect(messages.some(m => /^FLUSH DONE remaining=0 quarantined=0 runs=3 elapsed_ms=\d+$/.test(m))).toBe(true);
    expect(messages.filter(m => m.startsWith("FLUSH ABORT"))).toHaveLength(0);
    expect(G.__sessionRecallMergeInProgress__).toBe(false); // cleared in finally
    expect(out).toContain("complete");
  });

  it("(5) concurrent-append drain — content appended after run 1 (agent_end) is picked up by run 2 → final remaining=0", async () => {
    for (let i = 1; i <= 3; i++) seedUnmerged(P(i), CONTENT(i), T(i));
    const P4 = "/sessions/2026-04-09T00-00-00-session.jsonl";
    const { calls } = delegateEngine(makeEmbed().fn, scriptLlmCall("(none)").fn, undefined, (callNo) => {
      if (callNo === 1) seedUnmerged(P4, CONTENT(9), "2026-04-09T00:00:00.000Z"); // the append lands AFTER run 1's marks
    });
    await runRecallFlush({ db, sleepMs: async () => {} });
    expect(calls()).toBe(2); // run 2 picks up the append — the loop's raison d'être
    expect(sqliteCountUnmergedSessions(db)).toBe(0);
    expect(messages).toContain("FLUSH START unmerged=3");
    expect(messages).toContain("FLUSH RUN 1 marked=3 failed=0 deferred=0 remaining=1"); // the append is visible in the post-run count
    expect(messages).toContain("FLUSH RUN 2 marked=1 failed=0 deferred=0 remaining=0");
    // runs = loop iterations — engine runs 1–2 + the drain-check iteration
    expect(messages.some(m => /^FLUSH DONE remaining=0 quarantined=0 runs=3 elapsed_ms=\d+$/.test(m))).toBe(true);
  });

  it("(6) all-quarantined end state — persistent total failure: runs 1–3 strike every session (1/2/3), run 4 breaks on empty packable → FLUSH DONE (NOT an abort), quarantined=N, sentinel rows terminal", async () => {
    seedUnmerged(P(1), CONTENT(1), T(1));
    seedUnmerged(P(2), CONTENT(2), T(2));
    const { calls } = delegateEngine(makeEmbed().fn, scriptLlmCall(null).fn); // every EXTRACT → null → timeout → session strike
    const out = await runRecallFlush({ db, sleepMs: async () => {} });
    expect(calls()).toBe(3); // run 4 finds packable empty and breaks BEFORE the fold
    // monotonic — nothing marked, nothing lost: the sessions stay unmerged
    expect(sqliteCountUnmergedSessions(db)).toBe(2);
    expect(sqliteReadUnmergedSessionSummaries(db).map(r => r.session_path)).toEqual([P(1), P(2)]);
    expect(messages).toContain("FLUSH RUN 1 marked=0 failed=2 deferred=0 remaining=2");
    expect(messages).toContain("FLUSH RUN 2 marked=0 failed=2 deferred=0 remaining=2");
    expect(messages).toContain("FLUSH RUN 3 marked=0 failed=2 deferred=0 remaining=2");
    // toContain = exact element match (not substring) — the DONE line carries an unpredictable elapsed_ms
    expect(messages.some(m => m.startsWith("FLUSH DONE remaining=2 quarantined=2 runs=4 "))).toBe(true);
    expect(messages.filter(m => m.startsWith("FLUSH ABORT"))).toHaveLength(0); // DONE, not abort — the user adjudicates
    for (const p of [P(1), P(2)]) {
      const sent = readMergeQuarantine(db, p)!;
      expect(sent.failures).toBe(3);
      expect(sent.quarantinedAt).not.toBeNull(); // terminal
    }
    expect(out).toContain("REVIEW"); // quarantined > 0 → a REVIEW note (the live-vehicle discipline)
  });

  it("(7) re-entrancy guard — pre-set flag → immediate FLUSH REJECTED reason=merge-in-progress; engine never called; the flag is STILL true afterwards", async () => {
    seedUnmerged(P(1), CONTENT(1), T(1));
    G.__sessionRecallMergeInProgress__ = true; // someone else's fold holds the flag
    const { calls } = delegateEngine(makeEmbed().fn, scriptLlmCall("(none)").fn);
    const out = await runRecallFlush({ db, sleepMs: async () => {} });
    expect(calls()).toBe(0);
    expect(vi.mocked(ensureEmbedServer)).not.toHaveBeenCalled(); // the reject precedes the embed gate
    expect(messages).toContain("FLUSH REJECTED reason=merge-in-progress");
    expect(messages.filter(m => m.startsWith("FLUSH START") || m.startsWith("FLUSH DONE") || m.startsWith("FLUSH ABORT"))).toHaveLength(0);
    expect(G.__sessionRecallMergeInProgress__).toBe(true); // the reject must not clear someone else's flag
    expect(out).toContain("rejected");
  });

  it("(8) rowstore-off reject — useRowStore: false → FLUSH REJECTED reason=rowstore-off; engine never called", async () => {
    vi.mocked(loadConfigOnce).mockReturnValue(configFor({ useRowStore: false }));
    seedUnmerged(P(1), CONTENT(1), T(1));
    const { calls } = delegateEngine(makeEmbed().fn, scriptLlmCall("(none)").fn);
    const out = await runRecallFlush({ db, sleepMs: async () => {} });
    expect(calls()).toBe(0);
    expect(vi.mocked(ensureEmbedServer)).not.toHaveBeenCalled();
    expect(messages).toContain("FLUSH REJECTED reason=rowstore-off");
    expect(G.__sessionRecallMergeInProgress__).toBe(false); // the reject precedes the set
    expect(sqliteCountUnmergedSessions(db)).toBe(1); // untouched
    expect(out).toContain("rejected");
  });

  it("(9) busy-skip abort — 10 consecutive skips allowed, the 11th aborts → FLUSH ABORT reason=llm-busy; zero writes, zero strikes", async () => {
    seedUnmerged(P(1), CONTENT(1), T(1));
    const sleeps: number[] = [];
    const llmBusy = async <T>(_fn: () => Promise<T>): Promise<T | null> => null; // always busy (skip-not-queue)
    const { calls } = delegateEngine(makeEmbed().fn, scriptLlmCall("(none)").fn);
    const out = await runRecallFlush({ db, llmBusy, sleepMs: async (ms) => { sleeps.push(ms); } });
    expect(calls()).toBe(11); // the 11th busy skip aborts (the 10th is still allowed)
    expect(sleeps).toHaveLength(10); // the sleep follows skips 1–10; the 11th aborts before sleeping
    expect(sleeps.every(ms => ms === 2000)).toBe(true);
    expect(messages).toContain("FLUSH START unmerged=1");
    expect(messages).toContain("FLUSH ABORT reason=llm-busy remaining=1");
    expect(messages.filter(m => m.startsWith("FLUSH RUN "))).toHaveLength(0); // busy-skip runs never log FLUSH RUN
    expect(messages.filter(m => m.startsWith("FLUSH DONE"))).toHaveLength(0); // abort is terminal — no DONE
    // zero writes, zero strikes (monotonic — nothing lost)
    expect(getRows(db)).toHaveLength(0);
    expect(readMergeQuarantine(db, P(1))).toBeNull();
    expect(sqliteCountUnmergedSessions(db)).toBe(1);
    expect(G.__sessionRecallMergeInProgress__).toBe(false); // cleared in finally
    expect(out).toContain("aborted");
  });

  it("(10) failure-continue mid-flush — A fails (extract timeout) in run 1 while B–E are marked (F deferred to run 2); A struck once and NOT marked; run 2 re-folds A + F (success) → final remaining=0", async () => {
    for (let i = 1; i <= 6; i++) seedUnmerged(P(i), CONTENT(i), T(i)); // A = P(1) — oldest → first
    // A's run-1 EXTRACT → null (timeout); B–F's and A's run-2 EXTRACT → "(none)"
    const llm = scriptLlmCall(null, "(none)");
    const { calls } = delegateEngine(makeEmbed().fn, llm.fn);
    await runRecallFlush({ db, sleepMs: async () => {} });
    expect(calls()).toBe(2);
    expect(sqliteCountUnmergedSessions(db)).toBe(0);
    expect(messages).toContain("FLUSH RUN 1 marked=4 failed=1 deferred=1 remaining=2"); // batch 5: A+B–E start (F deferred); A fails
    expect(messages).toContain("FLUSH RUN 2 marked=2 failed=0 deferred=0 remaining=0"); // run 2 re-folds A + the deferred F
    expect(messages.filter(m => m.startsWith("FLUSH ABORT"))).toHaveLength(0); // the flush does NOT abort on a session failure
    const sent = readMergeQuarantine(db, P(1))!;
    expect(sent.failures).toBe(1);          // A struck once in run 1
    expect(sent.quarantinedAt).toBeNull();  // not terminal
    expect(unmergedOf(P(1))).toBeNull();    // A marked merged in run 2
  });

  it("(11) fix 2: the model endpoint never answers - the flush is rejected before any fold work", async () => {
    for (let i = 1; i <= 3; i++) seedUnmerged(P(i), CONTENT(i), T(i));
    const { calls } = delegateEngine(makeEmbed().fn, scriptLlmCall('(none)').fn);
    vi.mocked(buildMergeModelPair).mockReturnValue({ modelObj: { baseUrl: 'http://127.0.0.1:5001/v1' } as any, apiKey: 'sk-none' });
    vi.mocked(waitForLlmEndpointReady).mockReset().mockResolvedValue(false);

    const out = await runRecallFlush({ db, sleepMs: async () => {} });

    expect(out).toContain('the model endpoint is not answering');
    expect(messages).toContain('FLUSH REJECTED reason=llm-endpoint-unready endpoint=http://127.0.0.1:5001/v1');
    expect(messages.filter(m => m.startsWith('FLUSH START'))).toHaveLength(0); // no drain started
    expect(calls()).toBe(0);                          // the engine never ran
    expect(getRows(db)).toHaveLength(0);              // zero rows written
    expect(sqliteCountUnmergedSessions(db)).toBe(3);  // nothing lost - all still unmerged
    expect(G.__sessionRecallMergeInProgress__).toBe(false); // cleared in finally (the reject is inside the try)
  });
});
