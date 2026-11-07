// A pi-subagents child runs inside the parent's process. pi-subagents loads the
// ambient extensions again for that child (the FORK Pi loads, 0.82.1:
// `src/runs/shared/child-session.ts:561` `noExtensions: !launch.ambientExtensions`, the flag
// decided at `src/runs/shared/child-launch.ts:239` from the agent's tool plan), so this extension's
// factory is called a second time in the same process. The loaded guard
// (index.ts, "R4: Global singleton guard") then returns before any tool,
// command or handler is registered, so the child records nothing at all — no
// session summary, no memory block. Both foreground (in-process) children in the report
// that motivated this fix recorded nothing at all. A child hosted by a separate runner
// process is NOT affected — that process loads this extension once, so the guard never
// fires there (rows from such runs do reach `session_summaries`, written by the runner's
// own full-parent registration; see the R4 note in index.ts).
//
// pi-subagents marks the child in the environment (PI_SUBAGENT_CHILD) and keeps
// that marking only for the child-creation window that contains its
// loader.reload(), so the factory can tell the two cases the guard has to
// distinguish: a second instance for the SAME session (/reload — the guard must
// keep holding) and a DIFFERENT session in the same process (a child — it must
// register).
//
// Both halves of that premise — the second ambient load, and the marker being set
// around it — are what a local FORK of pi-subagents does: Pi loads a fork checkout's
// `pi-subagents\dist-pkg` (named in settings.json's `packages`; a checkout of
// github.com/nicobailon/pi-subagents, 0.82.1), and the marker
// for an in-process child is written at `src/runs/shared/child-launch.ts:187`. The npm-era patch
// that first added both halves is gone: its record
// `~/.pi/agent/npm/patches/pi-subagents+0.80.0.patch.disabled` and the npm copy it patched were
// DELETED on 2026-10-26 (the patch text survives in that folder's git history), so the fork is the
// only thing that provides this premise.
// Upstream gives an in-process child noExtensions and never sets the marker in the
// parent's process, so a FORK change that reverts either half (an update, a branch switch, a
// fork-side edit of the child-creation window) drops the premise here and detection goes silently
// false — which is why this file is the check to re-run after any fork change.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as logger from "../logger.js";
import { G } from "../types.js";
import { loadConfigOnce, DEFAULT_CONFIG } from "../config.js";
import defaultExport from "../index.js";
import { fakeApi, type CapturedHandlers } from "./helpers/fake-extension-api.js";
import {
  openCacheDb,
  sqliteAppendUnmergedFreshContent,
  captureSessionModel,
  mergeSessionSummary,
} from "../summarizer.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  // useRowStore is pinned false here on purpose: it is the FIRST gate inside
  // runRecallFlush, and the /recall-flush tests below rely on the drain never starting.
  // If DEFAULT_CONFIG ever flips to true, this pin is what keeps those tests from
  // walking the real row-store path.
  return {
    ...actual,
    loadConfigOnce: vi.fn(() => ({ ...actual.DEFAULT_CONFIG, useRowStore: false })),
  };
});

// The factory's load-time self-test opens the cache DB, whose path is baked
// from the real homedir at module load. null keeps it from touching the live
// session-index.sqlite; every other export stays real.
vi.mock("../summarizer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../summarizer.js")>();
  return {
    ...actual,
    openCacheDb: vi.fn(async () => null),
    sqliteAppendUnmergedFreshContent: vi.fn(), // the @@CORR marker append: the only DB write the capture makes
    captureSessionModel: vi.fn(async () => {}), // session_start's model capture: no models.json read
    // The turn-end pipeline calls this for the session summary. Left real, it runs
    // summarizer's own openCacheDb — an intra-module call this file's mock above
    // cannot intercept — and writes a fake session row into the operator's live
    // session-index.sqlite, where the next fold would feed it to the LLM.
    mergeSessionSummary: vi.fn(async () => null),
  };
});

const CHILD_ENV = "PI_SUBAGENT_CHILD";
const RUNNER_PID_ENV = "PI_SUBAGENT_RUNNER_PID";
const GUARD_LINE = "Extension already loaded (global guard), skipping";

function register(captured: CapturedHandlers, counters?: { tool: () => void; command: () => void }) {
  defaultExport(fakeApi(captured, counters));
}

/** A ctx the session_shutdown handler accepts (empty branch → no turn to process). */
function shutdownCtxFor(sessionFile: string): any {
  return {
    sessionManager: { getSessionFile: () => sessionFile, getBranch: () => [] },
    cwd: "/test/sr-child",
  };
}

describe("the loaded guard against an in-process child session", () => {
  let messages: string[];
  let stubHome: string;
  let realHome: { HOME: string | undefined; USERPROFILE: string | undefined };

  beforeAll(() => {
    // The factory's load-time self-test calls getPrimaryModel(), which reads
    // ~/.pi/agent/models.json. A scratch home keeps registration tests off operator
    // state, and restores both afterwards like test/session-model-wiring.test.ts.
    stubHome = mkdtempSync(join(tmpdir(), "sr-childreg-"));
    mkdirSync(join(stubHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(stubHome, ".pi", "agent", "models.json"),
      JSON.stringify({
        providers: {
          llamacpp: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:5001/v1",
            apiKey: "none",
            models: [{ id: "test-model" }],
          },
        },
      }),
    );
    realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = stubHome;
    process.env.USERPROFILE = stubHome;
  });

  afterAll(() => {
    try { rmSync(stubHome, { recursive: true, force: true }); } catch { /* scratch */ }
    // Restore, or every later test file in this worker bakes homedir()-derived
    // paths against a scratch directory that no longer exists.
    // Assigning `undefined` through process.env stores the string "undefined", which
    // leaves every later file in the worker worse off than it found.
    if (realHome.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = realHome.HOME;
    if (realHome.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realHome.USERPROFILE;
  });
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation((m: string) => messages.push(m));
    G.__sessionRecallLoaded__ = false;
    delete process.env[CHILD_ENV];
    // The useRowStore:false pin from the config mock above has to survive this reset, or
    // the day DEFAULT_CONFIG flips these tests start draining the real row store.
    vi.mocked(loadConfigOnce).mockReset().mockReturnValue({ ...DEFAULT_CONFIG, useRowStore: false });
    G.__sessionRecallMergeInProgress__ = false; // each test starts with the fold free
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env[CHILD_ENV];
    delete process.env[RUNNER_PID_ENV];
  });

  it("a second instance for the same session is still skipped by the guard", () => {
    const parent: CapturedHandlers = {};
    register(parent);
    expect(parent["session_start"]).toBeTypeOf("function");
    expect(G.__sessionRecallLoaded__).toBe(true);

    const duplicate: CapturedHandlers = {};
    register(duplicate);
    expect(Object.keys(duplicate)).toEqual([]);
    expect(messages).toContain(GUARD_LINE);
  });

  it("a child instance registers its handlers, tools and commands while the parent's registration is live", () => {
    const parent: CapturedHandlers = {};
    register(parent);
    expect(G.__sessionRecallLoaded__).toBe(true);

    let tools = 0;
    let commands = 0;
    process.env[CHILD_ENV] = "1";
    const child: CapturedHandlers = {};
    register(child, { tool: () => tools++, command: () => commands++ });

    for (const event of ["session_start", "agent_end", "before_agent_start", "session_shutdown"]) {
      expect(child[event], `${event} must be registered in a child`).toBeTypeOf("function");
    }
    expect(tools).toBeGreaterThan(0);
    expect(commands).toBeGreaterThan(0);
    expect(messages).not.toContain(GUARD_LINE);
    // Which role loaded has to be countable from the log alone (R14), and the child's line
    // is deliberately a different literal from the parent's. Nothing else pins either one:
    // collapsing both to "Extension loaded" kept every test green.
    expect(messages).toContain("Extension loaded (subagent child instance)");
    expect(messages.filter((m) => m === "Extension loaded")).toHaveLength(1); // the parent's
    // And the one line the residue list names as how a mislabel is found: every instance
    // that decides "child" logs it at registration. Until now no test asserted it existed.
    expect(
      messages.some((m) => m.startsWith("child instance detected (PI_SUBAGENT_CHILD=1)")),
    ).toBe(true);
  });

  it("a child registration leaves the parent's guard ownership alone and a duplicate session is still refused", () => {
    const parent: CapturedHandlers = {};
    register(parent);
    expect(G.__sessionRecallLoaded__).toBe(true);

    process.env[CHILD_ENV] = "1";
    const child: CapturedHandlers = {};
    register(child);
    expect(child["session_start"]).toBeTypeOf("function");
    expect(G.__sessionRecallLoaded__).toBe(true); // the child must not consume it

    delete process.env[CHILD_ENV];
    const duplicate: CapturedHandlers = {};
    register(duplicate);
    expect(Object.keys(duplicate)).toEqual([]); // the /reload case still holds
    expect(messages).toContain(GUARD_LINE);
  });

  it("a child's session_shutdown leaves the parent's guard set", async () => {
    const parent: CapturedHandlers = {};
    register(parent);
    expect(G.__sessionRecallLoaded__).toBe(true);

    process.env[CHILD_ENV] = "1";
    const child: CapturedHandlers = {};
    register(child);
    // pi-subagents restores the marker as soon as the child-creation window
    // closes, so by the time this child shuts down the environment no longer
    // says "child": the handler has to use what it captured at registration.
    delete process.env[CHILD_ENV];
    await child["session_shutdown"]({ reason: "quit" }, shutdownCtxFor("/pi/agent/sessions/child/run-0/session.jsonl"));

    // A child clearing the flag would let a later duplicate parent instance
    // register twice for one session — the bug commit 764e730 fixed.
    expect(G.__sessionRecallLoaded__).toBe(true);
  });

  it("a child session_start never takes the shared fold flag or the fold-model capture, even on a parent-shaped session file", async () => {
    const rotateSpy = vi.spyOn(logger, "rotateLogs").mockImplementation(() => {});
    const parent: CapturedHandlers = {};
    register(parent);

    process.env[CHILD_ENV] = "1";
    const child: CapturedHandlers = {};
    register(child);
    // pi-subagents can hand a child a session file outside run-N, so the path
    // shape alone cannot be what keeps it out of the long-term fold.
    const ctx: any = {
      sessionManager: { getSessionFile: () => "/pi/agent/sessions/sess-a.jsonl", getBranch: () => [] },
      cwd: "/test/sr-child",
    };
    vi.mocked(captureSessionModel).mockReset();
    await child["session_start"]({ reason: "new" }, ctx);

    expect(messages.some((m) => m.includes("subagent session, skipping merge"))).toBe(true);
    expect(G.__sessionRecallMergeInProgress__).toBeFalsy();
    // The fold reads one module-level model capture. A child that refreshed it would
    // repoint the parent's merge at the child's model (pi-subagents can share one
    // module copy between them when its per-child cache reset fails).
    expect(vi.mocked(captureSessionModel)).not.toHaveBeenCalled();
    rotateSpy.mockRestore();
  });

  it("a child session stamps no correction marker and writes no /recall-health state, even on a parent-shaped file", async () => {
    const db: any = { prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }), all: () => [] }) };
    vi.mocked(openCacheDb).mockResolvedValue(db);
    vi.mocked(sqliteAppendUnmergedFreshContent).mockReset();
    vi.mocked(mergeSessionSummary).mockReset();

    const ctx: any = {
      sessionManager: {
        getSessionFile: () => "/pi/agent/sessions/sess-a.jsonl",
        getBranch: () => [
          { type: "message", message: { role: "user", content: [{ type: "text", text: "I said to use pwsh, not bash" }] } },
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Switched the scripts to pwsh." }] } },
        ],
      },
      cwd: "/test/sr-child",
    };

    // A child registers while its parent's registration is still live — the only
    // arrangement pi-subagents produces inside a parent's process.
    const parent: CapturedHandlers = {};
    register(parent);
    process.env[CHILD_ENV] = "1";
    const child: CapturedHandlers = {};
    register(child);
    delete process.env[CHILD_ENV];

    // Child leg first: a parent's session_shutdown hands the process flag back, so
    // the child's registration has to happen while the parent still holds it.
    G.__sessionRecallCorrectionRateLimit__ = {}; // fresh counter: turn 0 is always a save turn
    G.__sessionRecallLastShutdownResult__ = "parent-slot"; // sentinel, asserted below
    await child["session_shutdown"]({ reason: "quit" }, ctx);
    // Same turn, same file shape, child role: no marker row, so nothing it says
    // reaches the correction stream every later session's prompt reads.
    expect(sqliteAppendUnmergedFreshContent).not.toHaveBeenCalled();
    // And the positive half of this change — the one behaviour the branch exists to
    // install: a child-role instance still writes its OWN session summary. Every other
    // assertion in this file is negative or about registration shape, so until these two
    // lines existed an `if (childInstance) return;` at the top of processLastTurn — exactly
    // the pre-branch behaviour, where the child recorded nothing — kept the whole suite green.
    expect(vi.mocked(mergeSessionSummary)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mergeSessionSummary).mock.calls[0][0]).toBe("/pi/agent/sessions/sess-a.jsonl");
    // And the one process-wide shutdown slot /recall-health reports keeps the
    // sentinel — both legs write the same text, so only the sentinel can tell them
    // apart.
    expect(G.__sessionRecallLastShutdownResult__).toBe("parent-slot");

    // Parent leg last: the same turn must stamp for a parent, or the child
    // assertion above proves nothing.
    vi.mocked(sqliteAppendUnmergedFreshContent).mockReset();
    vi.mocked(mergeSessionSummary).mockReset(); // so the parent's count below is its own
    G.__sessionRecallCorrectionRateLimit__ = {}; // fresh counter: turn 0 is always a save turn
    await parent["session_shutdown"]({ reason: "quit" }, ctx);
    expect(sqliteAppendUnmergedFreshContent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mergeSessionSummary)).toHaveBeenCalledTimes(1);
    expect(G.__sessionRecallLastShutdownResult__).toBe("session_shutdown processed");
  });
  it("a child-role shutdown that throws leaves the /recall-health error slot to the parent", async () => {
    // The failure half of the guard the sentinel above pins on the success path. Nothing
    // reached it before: processLastTurn swallows its own errors, so the throw has to come from
    // the handler's pre-`try` path (getBranch here), and deleting the role gate on the
    // `Error: …` line kept the whole suite green. A child's failure must not become the thing
    // an operator reads as this process's last shutdown.
    const throwingCtx: any = {
      sessionManager: {
        getSessionFile: () => "/pi/agent/sessions/sess-a.jsonl",
        getBranch: () => {
          throw new Error("boom");
        },
      },
      cwd: "/test/sr-child",
    };

    const parent: CapturedHandlers = {};
    register(parent);
    process.env[CHILD_ENV] = "1";
    const child: CapturedHandlers = {};
    register(child);
    delete process.env[CHILD_ENV];

    G.__sessionRecallLastShutdownResult__ = "parent-slot";
    await child["session_shutdown"]({ reason: "quit" }, throwingCtx);
    expect(G.__sessionRecallLastShutdownResult__).toBe("parent-slot");

    // The same failure for a parent: it owns the slot, so the operator sees the error.
    await parent["session_shutdown"]({ reason: "quit" }, throwingCtx);
    expect(String(G.__sessionRecallLastShutdownResult__)).toMatch(/^Error: /);
  });

  it("a child model_select never repoints the parent's fold-model capture", async () => {
    vi.mocked(captureSessionModel).mockReset();
    const ctx: any = { model: { provider: "strata", id: "parent-model" }, modelRegistry: {} };
    const parent: CapturedHandlers = {};
    register(parent);
    await parent["model_select"]({ model: { provider: "strata", id: "parent-model" } }, ctx);
    expect(vi.mocked(captureSessionModel)).toHaveBeenCalledTimes(1);

    // Same event, child role: the one module-level slot the fold reads must stay
    // where the parent put it.
    vi.mocked(captureSessionModel).mockReset();
    process.env[CHILD_ENV] = "1";
    const child: CapturedHandlers = {};
    register(child);
    delete process.env[CHILD_ENV];
    await child["model_select"]({ model: { provider: "llama", id: "child-model" } }, ctx);
    expect(vi.mocked(captureSessionModel)).not.toHaveBeenCalled();
    // And the greppable line exists, naming the session. This is also the only assertion that
    // exercises sessionLogName's real path — every other call site in this file passes a ctx
    // with no sessionManager, so only its "unknown" fallback ever ran: forcing the helper to
    // return "unknown" for every input kept the whole suite green.
    const namedCtx: any = {
      sessionManager: { getSessionFile: () => "/pi/agent/sessions/hash-0/run-0/session.jsonl" },
      model: { provider: "strata", id: "parent-model" },
      modelRegistry: {},
    };
    await child["model_select"]({ model: { provider: "llama", id: "child-model" } }, namedCtx);
    expect(messages).toContain(
      "model_select: session=session.jsonl subagent session, leaving the fold-model capture alone",
    );
    expect(vi.mocked(captureSessionModel)).not.toHaveBeenCalled();
  });

  it("a child agent_end never writes the /recall-health shutdown slot", async () => {
    // agent_end defers its work to a macro-task (setTimeout), so each leg flushes
    // the timer queue once before the slot is read.
    const flushTimers = () => new Promise((r) => setTimeout(r, 0));
    const ctx = shutdownCtxFor("/pi/agent/sessions/sess-a.jsonl");

    G.__sessionRecallLastShutdownResult__ = "parent-slot";
    const parent: CapturedHandlers = {};
    register(parent);
    await parent["agent_end"]({}, ctx);
    await flushTimers();
    expect(G.__sessionRecallLastShutdownResult__).toBe("agent_end processed");

    G.__sessionRecallLastShutdownResult__ = "parent-slot";
    process.env[CHILD_ENV] = "1";
    const child: CapturedHandlers = {};
    register(child);
    delete process.env[CHILD_ENV];
    await child["agent_end"]({}, ctx);
    await flushTimers();
    expect(G.__sessionRecallLastShutdownResult__).toBe("parent-slot");
  });

  it("a child instance's /recall-flush refuses instead of draining the backlog", async () => {
    // Safe to dispatch here: the command's work runs through runRecallFlush, whose
    // first gate is config.useRowStore, and loadConfigOnce is mocked to the default
    // (false) in this file — a parent dispatch rejects before touching any store.
    const notices: string[] = [];
    const uiCtx: any = { ui: { notify: (m: string) => notices.push(m) } };

    const parent: CapturedHandlers = {};
    register(parent);
    await parent["command:recall-flush"]({}, uiCtx);
    expect(notices.join(" | ")).not.toContain("subagent");

    process.env[CHILD_ENV] = "1";
    const child: CapturedHandlers = {};
    register(child);
    delete process.env[CHILD_ENV];
    notices.length = 0;
    const logsBeforeChild = messages.length;
    await child["command:recall-flush"]({}, uiCtx);
    const childLogs = messages.slice(logsBeforeChild);
    expect(childLogs.some((m) => m.includes("subagent session, refusing to drain"))).toBe(true);
    expect(notices.join(" | ")).toContain("subagent");
    // runRecallFlush's first act is a FLUSH START / FLUSH REJECTED log, so their
    // absence proves the drain was never entered. (The re-entrancy flag proves
    // nothing: it reads false both when a drain never started and after one ends.)
    expect(childLogs.some((m) => m.includes("FLUSH START") || m.includes("FLUSH REJECTED"))).toBe(false);
  });
  it("a parent re-registering after its own shutdown is not labelled a child by a marker in the window", async () => {
    // The case the third detection branch decides: a process that started clean, whose
    // parent session then shut down (/new, /reload) handing the guard flag back, and
    // whose NEXT registration lands while pi-subagents' child-creation marker is set.
    // Believing the marker there would leave the returning parent with no fold and no
    // correction markers for the rest of its life.
    //
    // It needs a module instance whose first registration was clean, so the test imports
    // its own copy with the marker absent: a vitest worker started by a subagent
    // inherits PI_SUBAGENT_CHILD process-wide, which would otherwise decide the
    // process-level label before this test had anything to say.
    delete process.env[CHILD_ENV];
    delete process.env[RUNNER_PID_ENV];
    vi.resetModules();
    const { default: freshExtension } = await import("../index.js");
    const ctx: any = {
      sessionManager: {
        getSessionFile: () => "/pi/agent/sessions/sess-parent.jsonl",
        getBranch: () => [],
      },
      cwd: "/test/sr-parent",
    };
    try {
      const first: CapturedHandlers = {};
      freshExtension(fakeApi(first)); // clean start: this process runs as a parent
      expect(G.__sessionRecallLoaded__).toBe(true);
      await first["session_shutdown"]({ reason: "quit" }, ctx);
      expect(G.__sessionRecallLoaded__).toBeFalsy(); // the shutdown is what hands it back

      process.env[CHILD_ENV] = "1"; // a child was being created in this window
      const again: CapturedHandlers = {};
      freshExtension(fakeApi(again));
      expect(again["session_start"]).toBeTypeOf("function");
      // Owning the flag again is the discriminator — a child-role instance never claims
      // it. No log assertion: after resetModules this copy logs through its own logger
      // module, which the shared spy cannot see.
      expect(G.__sessionRecallLoaded__).toBe(true);
    } finally {
      delete process.env[CHILD_ENV];
      vi.resetModules();
    }
  });

  it("a runner process that started clean is a child by its own runner pid alone", async () => {
    // The runner writes both variables at its own start and hosts only children, so
    // requiring a live parent registration there would hand the fold to a child.
    //
    // The branch has to be forced. The process-level read happens at the module copy's
    // FIRST registration, and by this point in the file earlier tests have already
    // registered clean copies — so a plain register() here is decided by that capture and
    // never reaches the runner pid. Measured: with the runner-pid branch stubbed out, the
    // previous version of this test still passed on its own. A fresh copy whose first
    // registration runs with BOTH variables absent fixes the capture at false, and then
    // the runner pid is the only thing left that can answer "child".
    delete process.env[CHILD_ENV];
    delete process.env[RUNNER_PID_ENV];
    vi.resetModules();
    const { default: freshExtension } = await import("../index.js");
    try {
      const cleanStart: CapturedHandlers = {};
      freshExtension(fakeApi(cleanStart)); // this copy's capture is now false
      expect(G.__sessionRecallLoaded__).toBe(true); // and it registered as a parent
      G.__sessionRecallLoaded__ = false; // that instance is gone: nothing is live now

      process.env[CHILD_ENV] = "1";
      process.env[RUNNER_PID_ENV] = String(process.pid);
      const instance: CapturedHandlers = {};
      freshExtension(fakeApi(instance));
      expect(instance["session_start"]).toBeTypeOf("function");
      expect(G.__sessionRecallLoaded__).toBe(false); // never owns the guard
      // No log assertion: after resetModules this copy logs through its own logger module,
      // which the shared spy cannot see. The load literal is pinned by the foreground-child
      // test, where the spy does reach.
    } finally {
      delete process.env[CHILD_ENV];
      delete process.env[RUNNER_PID_ENV];
      vi.resetModules();
    }
  });
  it("a process that started with the marker stays a child though it holds no parent registration", async () => {
    // A process that STARTS with the marker — the shape a detached child run would have, IF
    // pi-subagents forwards its launch env into that process. The marker is placed in the launch
    // env (fork `child-launch.ts:184-190`, marker at `:187`); the spawn route that would carry it is
    // not traced in this repo and no such respawn was found in the fork (0.82.1), so this case is
    // the process-role branch's
    // coverage for a shape the extension must handle even if this pi-subagents version never
    // produces it (see the note at the capture in index.ts). Such a process carries the marker in
    // its own startup environment and never contains a parent registration.
    // Deciding the role from live registration alone would hand that process a merge
    // of its own — the server contention R13 exists to prevent. The process-level read
    // happens at the module's first registration, so only a fresh import whose first
    // registration runs with the marker set can exercise it.
    process.env[CHILD_ENV] = "1";
    vi.resetModules();
    try {
      const { default: freshExtension } = await import("../index.js");
      const instance: CapturedHandlers = {};
      freshExtension(fakeApi(instance));
      expect(instance["session_start"]).toBeTypeOf("function");
      // The guard flag is the whole discriminator here: a parent-role instance would
      // have claimed it. No log assertion is possible — after resetModules this copy
      // of the extension logs through its own logger module, which the shared spy
      // above cannot see.
      expect(G.__sessionRecallLoaded__).toBe(false); // never owns the guard
    } finally {
      delete process.env[CHILD_ENV];
      vi.resetModules();
    }
  });
  it("a copy that captured the marker answers parent again once the marker leaves the environment", async () => {
    // The ORDER inside isSubagentChildInstance() is load-bearing and no other test can see it:
    // the live environment is consulted BEFORE the first-registration capture, so the capture
    // can only ever answer "child" while the marker is actually present. That is what makes
    // residue (d) narrower than (a) AT THE COPY LEVEL: once the window closes, the NEXT
    // registration in that module copy answers "parent" again — it does not wait for a pi restart.
    // The session that was already registered keeps its child role until it re-registers, because
    // every gate closes over the one `childInstance` decision (see residue (d) in index.ts).
    // Answering from the capture first (the two guards swapped) passes every other test in this
    // file: this is the one that stops it.
    delete process.env[CHILD_ENV];
    delete process.env[RUNNER_PID_ENV];
    vi.resetModules();
    const { default: freshExtension } = await import("../index.js");
    try {
      process.env[CHILD_ENV] = "1"; // this copy's FIRST registration runs inside the window
      const marked: CapturedHandlers = {};
      freshExtension(fakeApi(marked));
      expect(G.__sessionRecallLoaded__).toBe(false); // capture=true → child role, guard untouched

      delete process.env[CHILD_ENV]; // pi-subagents closes the window and restores the env
      G.__sessionRecallLoaded__ = false; // nothing is live: only the environment can answer now
      const after: CapturedHandlers = {};
      freshExtension(fakeApi(after));
      expect(after["session_start"]).toBeTypeOf("function");
      expect(G.__sessionRecallLoaded__).toBe(true); // parent role again — the marker is gone
    } finally {
      delete process.env[CHILD_ENV];
      vi.resetModules();
    }
  });

  it("keeps the child path rule in one function instead of re-inlining it per call site", () => {
    // Requirement 5 of the handoff report: "a test that fails if someone renames the shared
    // rule back to a single-site literal". Two places in index.ts consult the rule (the
    // correction guard and the fold gate) and discovery consults it in discoverer.ts. A
    // third copy of the same regex behaves identically, so no behavioural test can see the
    // difference — this pin has to be structural.
    const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const discovererSource = readFileSync(new URL("../discoverer.ts", import.meta.url), "utf8");

    expect(indexSource.match(/isSubagentSession\(/g)?.length).toBeGreaterThanOrEqual(2);
    // The rule's signature appears exactly once in the extension: at its definition. Only
    // code counts — a comment that QUOTES the regex must not fail this test.
    const codeOf = (src: string) =>
      src
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
    expect(codeOf(discovererSource).match(/run-\\d\+/g)).toHaveLength(1);
    expect(codeOf(indexSource)).not.toMatch(/run-\\d\+/);
  });
});
