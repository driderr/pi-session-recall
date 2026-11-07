import { beforeEach } from "vitest";
import { vol } from "memfs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { G } from "../types.js"; // Typed globalThis accessor

// Test hygiene (2026-10-22): suites that start the extension write through
// logger.ts, whose log path defaults to the operator's live log
// (~/.pi/agent/extensions/session-recall/log-<date>.txt). Measured: a full-suite
// run appended "Loaded OK" lines there. Redirect the logger at a scratch
// directory; setupFiles run before any test module is imported, so logger.ts
// reads this value at load time.
try { mkdirSync(join(tmpdir(), "session-recall-test-logs"), { recursive: true }); } catch { /* ignore */ }
process.env.SESSION_RECALL_LOG_DIR = join(tmpdir(), "session-recall-test-logs");

// Test hygiene (2026-10-25): a vitest worker launched from inside a pi-subagents run
// inherits PI_SUBAGENT_CHILD (and usually PI_SUBAGENT_RUNNER_PID) process-wide. The
// extension reads those to decide whether the instance registering is a subagent child,
// and a child owns no long-term-memory work — so without this, `PI_SUBAGENT_CHILD=1 npm
// test` made 27 tests decide "child" and fail, and other tests pass for the wrong
// reason. Cleared here, before any test module is imported, so the role a process
// decides at its first registration never depends on who started vitest. A test that
// WANTS a child role sets the variable in its own body.
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_RUNNER_PID;

beforeEach(() => {
  // Same reason as the module-scope clear above, enforced per test: one file leaking the
  // marker must not decide the role of the next file's registrations.
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_RUNNER_PID;
  // Reset LLM busy flag
  G.__sessionRecallLlmBusy__ = false;
  // Reset LLM stats
  G.__sessionRecallLlmStats__ = undefined as any; // Reset to trigger re-init
  // Reset VCC merge flags
  G.__sessionRecallVccMerge__ = {};
  // Close and forget the shared SQLite connection. It lives on globalThis so every
  // module load in one process reuses it, which would also carry it from one test file
  // into the next; this reset keeps the isolation the module-scope variable used to give.
  try { G.__sessionRecallCacheDb__?.close(); } catch { /* ignore */ }
  G.__sessionRecallCacheDb__ = undefined;
  G.__sessionRecallCacheDbFailCount__ = 0;
  G.__sessionRecallCacheDbOpening__ = undefined;
  // Reset in-memory filesystem
  vol.reset();
});
