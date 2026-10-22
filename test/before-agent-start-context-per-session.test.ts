// One memory block per session file, and the record of who already got one has to
// survive /reload. The guard used to store a single session name, so when a second
// live session took its block the first session's record was overwritten and the
// first session added a second block on its next turn.
//
// Discovery and the block composer are stubbed: the only behaviour under test is the
// per-session guard in the before_agent_start handler (index.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as logger from "../logger.js";
import { G } from "../types.js";
import { mockCompleteReset } from "@earendil-works/pi-ai";
import defaultExport from "../index.js";
import { loadConfigOnce, DEFAULT_CONFIG } from "../config.js";
import { combineContextForInjection, openCacheDb, readLongTerm } from "../summarizer.js";
import { discoverSessions } from "../discoverer.js";
import { fakeApi } from "./helpers/fake-extension-api.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfigOnce: vi.fn(() => actual.DEFAULT_CONFIG) };
});

vi.mock("../discoverer.js", () => ({
  discoverSessions: vi.fn(),
  matchesIgnorePatterns: vi.fn(() => false),
  SQLITE_PATH: "/test/sr-inject/session-index.sqlite",
}));

vi.mock("../summarizer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../summarizer.js")>();
  return {
    ...actual,
    openCacheDb: vi.fn(async () => null), // no DB is needed once the composer is stubbed
    readLongTerm: vi.fn(async () => null),
    combineContextForInjection: vi.fn(), // every test sets the block text below
  };
});

const BRIEF = "BRIEF MEMORY BLOCK";
const SESSION_A = "/pi/agent/sessions/sess-a.jsonl";
const SESSION_B = "/pi/agent/sessions/sess-b.jsonl";

/** A ctx shaped like pi's: one session file per live session. */
function ctxFor(sessionFile: string): any {
  return { sessionManager: { getSessionFile: () => sessionFile }, cwd: "/test/sr-inject" };
}

/** A ctx the session_shutdown handler accepts (empty branch → no turn to process). */
function shutdownCtxFor(sessionFile: string): any {
  return {
    sessionManager: { getSessionFile: () => sessionFile, getBranch: () => [] },
    cwd: "/test/sr-inject",
  };
}

describe("before_agent_start: one memory block per session file", () => {
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let handlers: Record<string, (...args: any[]) => any>;

  beforeEach(() => {
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
    mockCompleteReset();
    G.__sessionRecallLoaded__ = false;
    G.__sessionRecallContextInjectedSessions__ = undefined;

    vi.mocked(loadConfigOnce).mockReset().mockReturnValue(DEFAULT_CONFIG);
    vi.mocked(discoverSessions).mockReset().mockResolvedValue([
      { path: "/pi/agent/sessions/older.jsonl", cwd: "/test/sr-inject", timestamp: "", sizeBytes: 0 },
    ]);
    vi.mocked(openCacheDb).mockReset().mockResolvedValue(null);
    vi.mocked(readLongTerm).mockReset().mockResolvedValue(null);
    vi.mocked(combineContextForInjection).mockReset().mockResolvedValue(BRIEF);

    const captured: Record<string, (...args: any[]) => any> = {};
    defaultExport(fakeApi(captured));
    handlers = captured;
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("single session: injects once, second turn injects nothing, same log line and message", async () => {
    const first = await handlers["before_agent_start"]({}, ctxFor(SESSION_A));

    expect(first).toEqual({
      message: { customType: "session-recall-context", content: BRIEF, display: false },
    });
    expect(messages).toContain(
      `before_agent_start: session=sess-a.jsonl injecting brief (${BRIEF.length} chars, 1 sessions discovered)`,
    );

    const second = await handlers["before_agent_start"]({}, ctxFor(SESSION_A));
    expect(second).toBeUndefined();
    expect(vi.mocked(combineContextForInjection)).toHaveBeenCalledTimes(1);
  });

  it("two live session files each get exactly one block, in any order", async () => {
    const a1 = await handlers["before_agent_start"]({}, ctxFor(SESSION_A));
    const b1 = await handlers["before_agent_start"]({}, ctxFor(SESSION_B));

    expect(a1?.message?.customType).toBe("session-recall-context");
    expect(b1?.message?.customType).toBe("session-recall-context");

    // B taking its block must not cost A its record: neither session repeats.
    expect(await handlers["before_agent_start"]({}, ctxFor(SESSION_A))).toBeUndefined();
    expect(await handlers["before_agent_start"]({}, ctxFor(SESSION_B))).toBeUndefined();
    expect(vi.mocked(combineContextForInjection)).toHaveBeenCalledTimes(2);
  });

  it("the record survives session_shutdown: no second block for the same file after a reload", async () => {
    const first = await handlers["before_agent_start"]({}, ctxFor(SESSION_A));
    expect(first?.message?.customType).toBe("session-recall-context");

    // pi shuts the instance down, then builds the new one (factory call again).
    await handlers["session_shutdown"]({ reason: "reload" }, shutdownCtxFor(SESSION_A));
    G.__sessionRecallLoaded__ = false;
    const reloaded: Record<string, (...args: any[]) => any> = {};
    defaultExport(fakeApi(reloaded));

    expect(await reloaded["before_agent_start"]({}, ctxFor(SESSION_A))).toBeUndefined();
    expect(vi.mocked(combineContextForInjection)).toHaveBeenCalledTimes(1);
  });

  it("the record is bounded: 500 session files kept, the oldest inserted drop first", async () => {
    const files = Array.from({ length: 501 }, (_, i) => `/pi/agent/sessions/capped-${i}.jsonl`);
    for (const file of files) {
      const result = await handlers["before_agent_start"]({}, ctxFor(file));
      expect(result?.message?.customType).toBe("session-recall-context"); // every file gets one
    }
    expect(G.__sessionRecallContextInjectedSessions__?.size).toBe(500); // cap, not 501

    // The newest entry is kept — no second block for it.
    expect(await handlers["before_agent_start"]({}, ctxFor(files[500]))).toBeUndefined();
    // The oldest entry was dropped by the cap, so that file injects again. This is the
    // documented trade-off for a record that can never grow past 500 names.
    const replay = await handlers["before_agent_start"]({}, ctxFor(files[0]));
    expect(replay?.message?.customType).toBe("session-recall-context");
    expect(G.__sessionRecallContextInjectedSessions__?.size).toBe(500);
  });
});
