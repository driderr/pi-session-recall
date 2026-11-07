import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";
import { G } from "../types.js";
import * as logger from "../logger.js";
import {
  isSubagentSession,
  matchesIgnorePatterns,
  discoverSessions,
} from "../discoverer.js";

// The row-budget tests at the end of this file point the shared DB handle at a throwaway
// table; their seedCacheDb helper says why mocking summarizer's openCacheDb cannot work here.

/* ------------------------------------------------------------------ */
/*  isSubagentSession                                                  */
/* ------------------------------------------------------------------ */

describe("isSubagentSession", () => {
  it("detects subagent session with run-1", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/run-1/session.jsonl"
      )
    ).toBe(true);
  });

  it("detects subagent session with run-99", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/run-99/session.jsonl"
      )
    ).toBe(true);
  });

  it("detects subagent session with run-0", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/run-0/session.jsonl"
      )
    ).toBe(true);
  });

  it("returns false for normal session path", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/2026-06-06T08-15-34-883Z_abc123.jsonl"
      )
    ).toBe(false);
  });

  it("returns false for nested non-subagent path", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/notes/session.jsonl"
      )
    ).toBe(false);
  });

  it("returns false for path containing 'run' but not subagent pattern", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/run-something/session.jsonl"
      )
    ).toBe(false);
  });

  it("detects subagent session with Windows backslashes", () => {
    expect(
      isSubagentSession(
        "C:\\Users\\user\\.pi\\agent\\sessions\\parent\\abc123\\run-1\\session.jsonl"
      )
    ).toBe(true);
  });

  it("returns false for Windows normal session path", () => {
    expect(
      isSubagentSession(
        "C:\\Users\\user\\.pi\\agent\\sessions\\2026-06-06T08-15-34-883Z_abc123.jsonl"
      )
    ).toBe(false);
  });

  it("returns false for empty path", () => {
    expect(isSubagentSession("")).toBe(false);
  });

  it("returns false for path ending in session.jsonl without run-N prefix", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/session.jsonl"
      )
    ).toBe(false);
  });

  it("returns false for run-N without session.jsonl suffix", () => {
    expect(
      isSubagentSession(
        "/home/user/.pi/agent/sessions/parent/abc123/run-1/other.jsonl"
      )
    ).toBe(false);
  });
});

/*  matchesIgnorePatterns                                              */
/* ------------------------------------------------------------------ */

describe("matchesIgnorePatterns", () => {
  it("matches single wildcard * against a filename", () => {
    expect(matchesIgnorePatterns("temp.jsonl", ["*.jsonl"])).toBe(true);
  });

  it("single wildcard * matches within a path segment (substring match)", () => {
    // The regex is not anchored, so *.jsonl matches the "temp.jsonl" portion
    // of "dir/temp.jsonl" — it does NOT enforce full-path matching.
    expect(matchesIgnorePatterns("dir/temp.jsonl", ["*.jsonl"])).toBe(true);
  });

  it("double wildcard ** matches across directory boundaries", () => {
    expect(matchesIgnorePatterns("dir/sub/temp.jsonl", ["**/temp.jsonl"])).toBe(
      true
    );
  });

  it("double wildcard ** matches full path", () => {
    expect(
      matchesIgnorePatterns("a/b/c/d.jsonl", ["**/*.jsonl"])
    ).toBe(true);
  });

  it("literal match works", () => {
    expect(
      matchesIgnorePatterns("/home/user/.pi/agent/sessions/ignore-me.jsonl", [
        "/home/user/.pi/agent/sessions/ignore-me.jsonl",
      ])
    ).toBe(true);
  });

  it("literal match is case sensitive", () => {
    expect(
      matchesIgnorePatterns("/home/user/FILE.jsonl", ["/home/user/file.jsonl"])
    ).toBe(false);
  });

  it("returns false when no pattern matches", () => {
    expect(
      matchesIgnorePatterns("/home/user/session.jsonl", ["*.lock"])
    ).toBe(false);
  });

  it("returns true if any of multiple patterns matches", () => {
    expect(
      matchesIgnorePatterns("/home/user/session.jsonl", [
        "*.lock",
        "*.jsonl",
      ])
    ).toBe(true);
  });

  it("returns false if none of multiple patterns match", () => {
    expect(
      matchesIgnorePatterns("/home/user/session.txt", [
        "*.lock",
        "*.jsonl",
        "*.sqlite",
      ])
    ).toBe(false);
  });

  it("returns false for empty patterns array", () => {
    expect(matchesIgnorePatterns("/home/user/session.jsonl", [])).toBe(false);
  });

  it("handles empty path with non-empty patterns", () => {
    expect(matchesIgnorePatterns("", ["*.jsonl"])).toBe(false);
  });

  it("normalizes Windows backslashes to forward slashes", () => {
    expect(
      matchesIgnorePatterns("C:\\Users\\temp.jsonl", ["**/temp.jsonl"])
    ).toBe(true);
  });

  it("matches glob with directory prefix", () => {
    expect(
      matchesIgnorePatterns("/home/user/.pi/agent/sessions/2026-06-06T08-15-34.jsonl", [
        "**/sessions/**",
      ])
    ).toBe(true);
  });

  it("does not match when glob pattern is too specific", () => {
    expect(
      matchesIgnorePatterns("/home/user/sessions/2026-06-06T08-15-34.jsonl", [
        "**/data/**",
      ])
    ).toBe(false);
  });

  it("handles special regex characters in literal patterns", () => {
    // The function escapes regex special chars before matching
    expect(
      matchesIgnorePatterns("/home/user/file(1).jsonl", [
        "/home/user/file(1).jsonl",
      ])
    ).toBe(true);
  });

  it("handles special regex characters that should not match", () => {
    expect(
      matchesIgnorePatterns("/home/user/file(2).jsonl", [
        "/home/user/file(1).jsonl",
      ])
    ).toBe(false);
  });

  it("matches wildcard at end of path segment", () => {
    expect(
      matchesIgnorePatterns("/home/user/.pi/agent/sessions/abc123.jsonl", [
        "**/agent/sessions/*",
      ])
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  discoverSessions — the row budget when a delegated run just ran     */
/* ------------------------------------------------------------------ */

describe("discoverSessions row budget", () => {
  // Discovery reaches SQLite through summarizer's shared handle, so these tests inject that
  // handle (see seedCacheDb below). discoverer itself is NOT mocked — its child path rule is
  // part of what these tests pin.
  const SESSION_DIR = "--C--Users-Test-Documents-proj--";
  let tempRoot: string;

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "sr-discovery-"));
  });
  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });
  afterEach(() => {
    // The singleton is a global the whole process shares: hand it back exactly as
    // test/setup.ts leaves it between files.
    try {
      (G.__sessionRecallCacheDb__ as any)?.close();
    } catch {
      /* already closed */
    }
    G.__sessionRecallCacheDb__ = undefined;
  });

  /**
   * Point the shared DB handle at a throwaway table. Discovery reaches SQLite through
   * summarizer's `openCacheDb`, which returns this global when it is set — the documented
   * injection point, and the one that exercises the real SQL against a real table. Mocking
   * `openCacheDb` would intercept as well (a probe this pass mocked it and all five budget
   * tests came back [] with "SQLite unavailable for discovery"), but it would leave these
   * tests asserting against a stub instead of a table — and it contradicts what an earlier
   * pass of this branch recorded ("0 calls on the mock, production rows back"), a measurement
   * that does not reproduce against the current code and is superseded by that probe.
   */
  function seedCacheDb(db: any): void {
    G.__sessionRecallCacheDb__ = db;
  }

  /** Real files on disk: discovery stats every candidate, so it must exist. */
  function makeRealFiles(count: number): string[] {
    const dir = join(tempRoot, SESSION_DIR);
    mkdirSync(dir, { recursive: true });
    return Array.from({ length: count }, (_, i) => {
      const path = join(dir, `2026-01-01T00-00-${String(i).padStart(2, "0")}Z_real-${i}.jsonl`);
      writeFileSync(path, "{}");
      return path;
    });
  }

  /** The storage shape of a delegated child run, as the live index stores it. */
  function childPath(index: number): string {
    return `${tempRoot}/${SESSION_DIR}/2026-01-02T00-00-00Z_parent/hash-${index}/run-0/session.jsonl`;
  }

  function seedDb(rows: Array<{ path: string; at: string }>): any {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE session_summaries (session_path TEXT, updated_at TEXT)");
    const insert = db.prepare(
      "INSERT INTO session_summaries (session_path, updated_at) VALUES (?, ?)",
    );
    for (const row of rows) insert.run(row.path, row.at);
    return db;
  }

  function config(
    maxSessions: number,
    sessionScope: "all" | "cwd" = "all",
  ): SessionRecallConfig {
    return { ...DEFAULT_CONFIG, maxSessions, sessionScope, ignorePatterns: [] };
  }
  /** Capture discoverer's own log lines for the duration of one call. */
  function captureLogs(): { lines: string[]; stop: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(logger, "log").mockImplementation((m: string) => {
      lines.push(m);
    });
    return { lines, stop: () => spy.mockRestore() };
  }

  it("fills the budget from older rows when the newest ones are all child sessions", async () => {
    // maxSessions 3 means a window of 6 rows. Twenty child rows sit ABOVE every real
    // session here — the shape a just-finished delegated run leaves in the live index —
    // so a single fixed window saw only rows it was going to discard and returned
    // nothing at all.
    const real = makeRealFiles(10);
    seedCacheDb(
      seedDb([
        ...Array.from({ length: 20 }, (_, i) => ({
          path: childPath(i),
          at: `2026-02-${String(i).padStart(2, "0")}T00:00:00Z`,
        })),
        ...real.map((path, i) => ({
          path,
          at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        })),
      ]),
    );

    const found = await discoverSessions(config(3), "/test/cwd");

    // Newest real sessions first by updated_at, and none of them a child.
    expect(found.map((s) => s.path)).toEqual(real.slice().reverse().slice(0, 6));
    expect(found.every((s) => !isSubagentSession(s.path))).toBe(true);
  });

  it("never returns more than the budget when real sessions outnumber it", async () => {
    const real = makeRealFiles(40);
    seedCacheDb(
      seedDb(
        real.map((path, i) => ({
          path,
          at: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        })),
      ),
    );

    const found = await discoverSessions(config(3), "/test/cwd");

    // maxSessions * 2 is the ceiling the single LIMIT used to guarantee; paging the scan
    // must not raise it.
    expect(found).toHaveLength(6);
  });

  it("stops scanning after ten windows instead of walking the whole index", async () => {
    // Bounded work is the other half of the rule: 120 child rows ahead of 5 real ones,
    // with the scan capped at maxSessions * 2 * 10 rows. The real sessions sit past the
    // cap, so the honest answer is what a scan that gave up reports — never an unbounded
    // walk of the index.
    const real = makeRealFiles(5);
    seedCacheDb(
      seedDb([
        ...Array.from({ length: 120 }, (_, i) => ({
          path: childPath(i),
          at: `2026-05-${String(200 - i).padStart(3, "0")}T00:00:00Z`,
        })),
        ...real.map((path, i) => ({ path, at: `2026-01-0${i + 1}T00:00:00Z` })),
      ]),
    );

    const logs = captureLogs();
    const found = await discoverSessions(config(3), "/test/cwd");
    logs.stop();

    expect(found).toHaveLength(0);
    // The cap is the ONLY reason this scan stopped, so it has to say so: a short /recall
    // during a delegated run is otherwise indistinguishable from an empty index, and the
    // whole point of the paging rewrite was to make that failure visible. Exact text —
    // R4's checklist treats these log lines as the greppable interface.
    expect(logs.lines.filter((m) => m.startsWith("DISCOVERY SHORT"))).toEqual([
      "DISCOVERY SHORT scanned=60 wanted=6 reason=scan cap of 60 rows reached",
    ]);
  });
  it("stays silent when the table runs out at the same moment as the scan cap", async () => {
    // 55 child rows against a 60-row cap: the tenth window asks for 6 and gets 1, so the
    // TABLE is exhausted on the very page where the window position hits the cap. The honest
    // reason there is "there were no more rows", not "I gave up" — printing the SHORT line
    // would send an operator to raise a cap that was never the limit. Neither half of that
    // rule had a test: deleting the exhaustion flag runs the loop to the cap anyway, and
    // deleting the reason precedence prints the line for a scan that found the whole table.
    seedCacheDb(
      seedDb(
        Array.from({ length: 55 }, (_, i) => ({
          path: childPath(i),
          at: `2026-05-${String(200 - i).padStart(3, "0")}T00:00:00Z`,
        })),
      ),
    );

    const logs = captureLogs();
    const found = await discoverSessions(config(3), "/test/cwd");
    logs.stop();

    expect(found).toHaveLength(0);
    expect(logs.lines.filter((m) => m.startsWith("DISCOVERY SHORT"))).toEqual([]);
  });
  it("reports the short list when ignorePatterns empties a budget the scan itself filled", async () => {
    // 54 child rows then 6 real ones, `wanted` 6 and a 60-row cap: the tenth page is both the
    // cap page and the page that fills the budget, so the scan did its job — and
    // `ignorePatterns`, user config applied afterwards, drops one of those six. The list that
    // reaches the caller IS short and the cap DID end the scan, so the line has to print even
    // though the pre-filter count reached `wanted`. The check used to read the pre-filter list
    // and stayed silent: a short /recall with no reason recorded anywhere.
    const real = makeRealFiles(6);
    seedCacheDb(
      seedDb([
        ...Array.from({ length: 54 }, (_, i) => ({
          path: childPath(i),
          at: `2026-05-${String(200 - i).padStart(3, "0")}T00:00:00Z`,
        })),
        ...real.map((path, i) => ({ path, at: `2026-01-0${i + 1}T00:00:00Z` })),
      ]),
    );

    const logs = captureLogs();
    const found = await discoverSessions(
      { ...config(3), ignorePatterns: ["*real-3*"] },
      "/test/cwd",
    );
    logs.stop();

    expect(found).toHaveLength(5);
    expect(logs.lines.filter((m) => m.startsWith("DISCOVERY SHORT"))).toEqual([
      "DISCOVERY SHORT scanned=60 wanted=6 reason=scan cap of 60 rows reached",
    ]);
  });

  it("never lists a child session, even when its file is really on disk", async () => {
    // The point of R13 at this site: a delegated run is not offered to the user. The skip
    // happens before the file check, so a seeded child path that does not exist on disk
    // proves nothing — deleting the skip survived this whole suite until this test
    // existed. The child file here is real, through Windows separators.
    const dir = join(tempRoot, SESSION_DIR, "2026-01-03T00-00-00Z_parent", "hash-0", "run-0");
    mkdirSync(dir, { recursive: true });
    const childOnDisk = join(dir, "session.jsonl");
    writeFileSync(childOnDisk, "{}");
    const real = makeRealFiles(2);
    seedCacheDb(
      seedDb([
        { path: childOnDisk, at: "2026-04-02T00:00:00Z" },
        { path: childPath(9), at: "2026-04-01T00:00:00Z" },
        ...real.map((path, i) => ({ path, at: `2026-01-0${i + 1}T00:00:00Z` })),
      ]),
    );

    const found = await discoverSessions(config(3), "/test/cwd");

    // Newest real session first; the child that exists on disk is absent.
    expect(found.map((s) => s.path)).toEqual(real.slice().reverse());
  });

  it("applies the cwd scope together with the paging window", async () => {
    // sessionScope "cwd" adds the one bind parameter this statement has, and it must be
    // bound BEFORE the LIMIT/OFFSET pair. Every other test here runs scope "all", where the
    // parameter list is empty — so the whole WHERE leg and its binding order were unpinned:
    // swapping the bindings (`wanted, offset, ...params`) kept the entire suite green.
    const here = makeRealFiles(2);
    const elsewhere = join(tempRoot, "--C--Users-Test-Documents-other--");
    mkdirSync(elsewhere, { recursive: true });
    const otherPath = join(elsewhere, "2026-01-01T00-00-99Z_other.jsonl");
    writeFileSync(otherPath, "{}");
    seedCacheDb(
      seedDb([
        ...here.map((path, i) => ({ path, at: `2026-06-0${i + 1}T00:00:00Z` })),
        // Newest row in the table, but it belongs to a different working directory.
        { path: otherPath, at: "2026-06-09T00:00:00Z" },
      ]),
    );

    const logs = captureLogs();
    const found = await discoverSessions(config(3, "cwd"), join(tempRoot, SESSION_DIR));
    logs.stop();

    expect(found.map((s) => s.path).sort()).toEqual(here.slice().sort());
    // Three rows in the table, a budget of six: the TABLE ran out, the cap never bound. An
    // unfiltered row budget must never look like a scan that gave up.
    expect(logs.lines.filter((m) => m.startsWith("DISCOVERY SHORT"))).toEqual([]);
  });
});
