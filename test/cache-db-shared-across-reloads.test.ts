// One SQLite connection per process. pi re-reads the extension module on every
// /reload with the module cache disabled, so anything stored in module scope starts
// empty again — openCacheDb used to open another connection to the same database
// file on each load. The connection and its failure counter now live on globalThis,
// so every load in one process shares them.
//
// better-sqlite3 is replaced by a counting stand-in: the effect under test is how
// many connections one process opens, and no database file is touched. The stand-in's
// counters sit on a test-only globalThis key because the mock factory runs again after
// vi.resetModules(), which would replace a closure variable.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { G } from "../types.js";

interface FakeSqliteState {
  constructors: number;
  closes: number;
  failNextOpen: boolean;
}

const FAKE_SQLITE_KEY = "__testFakeSqliteState";

function fakeSqlite(): FakeSqliteState {
  const g = globalThis as unknown as Record<string, FakeSqliteState | undefined>;
  return (g[FAKE_SQLITE_KEY] ??= { constructors: 0, closes: 0, failNextOpen: false });
}

vi.mock("better-sqlite3", () => {
  class FakeDatabase {
    constructor(_path: string) {
      const state = fakeSqlite();
      state.constructors++;
      if (state.failNextOpen) throw new Error('SQLITE_CANTOPEN (test stand-in)');
    }
    pragma() { return "wal"; }
    exec() {}
    prepare() { return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }; }
    close() { fakeSqlite().closes++; }
  }
  return { default: FakeDatabase };
});

describe("openCacheDb: one shared connection across module loads", () => {
  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>)[FAKE_SQLITE_KEY] = undefined;
    // The shared connection and its failure counter are reset for every test in
    // test/setup.ts — the same place the other globalThis resets live.
  });

  it("re-loading the module (a /reload) reuses the connection instead of opening a second one", async () => {
    const firstLoad = await import("../summarizer.js");
    const firstDb = await firstLoad.openCacheDb();
    expect(firstDb).toBeTruthy();
    expect(fakeSqlite().constructors).toBe(1);

    // pi's reload path: the module is read again, module-scope state starts empty.
    vi.resetModules();
    const secondLoad = await import("../summarizer.js");
    const secondDb = await secondLoad.openCacheDb();

    expect(secondDb).toBe(firstDb); // the same handle, not a new one
    expect(fakeSqlite().constructors).toBe(1); // still one connection for the process
  });

  it("closeCacheDb closes the shared handle and clears the global so a later call reopens", async () => {
    const mod = await import("../summarizer.js");
    const db = await mod.openCacheDb();

    mod.closeCacheDb();

    expect(fakeSqlite().closes).toBe(1);
    expect(G.__sessionRecallCacheDb__).toBeUndefined(); // the shared global is cleared
    const reopened = await mod.openCacheDb();
    expect(reopened).not.toBe(db);
    expect(fakeSqlite().constructors).toBe(2);
  });

  it("the three-failure cap is shared across module loads, not restarted by a reload", async () => {
    fakeSqlite().failNextOpen = true;
    const firstLoad = await import("../summarizer.js");
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await firstLoad.openCacheDb()).toBeNull();
    }
    expect(fakeSqlite().constructors).toBe(3); // the 3-retry limit still holds

    vi.resetModules();
    const secondLoad = await import("../summarizer.js");
    expect(await secondLoad.openCacheDb()).toBeNull();
    expect(fakeSqlite().constructors).toBe(3); // no fourth attempt — the counter survived
    expect(G.__sessionRecallCacheDbFailCount__).toBe(3);
  });
  it("two callers that reach openCacheDb before the database is open share one connection", async () => {
    const mod = await import("../summarizer.js");
    const [first, second] = await Promise.all([mod.openCacheDb(), mod.openCacheDb()]);

    expect(first).toBeTruthy();
    expect(second).toBe(first); // the same handle, so no orphaned second connection
    expect(fakeSqlite().constructors).toBe(1); // exactly one connection was opened
    expect(G.__sessionRecallCacheDbOpening__).toBeUndefined(); // the shared wait is cleared
  });

  it("a failed open counts as one attempt when several callers wait on it", async () => {
    fakeSqlite().failNextOpen = true;
    const mod = await import("../summarizer.js");
    const results = await Promise.all([mod.openCacheDb(), mod.openCacheDb(), mod.openCacheDb()]);

    expect(results).toEqual([null, null, null]);
    expect(fakeSqlite().constructors).toBe(1); // one attempt, not three
    expect(G.__sessionRecallCacheDbFailCount__).toBe(1); // one failure counted
    expect(G.__sessionRecallCacheDbOpening__).toBeUndefined(); // a later call may retry
  });
});
