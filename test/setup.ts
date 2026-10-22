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

beforeEach(() => {
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
