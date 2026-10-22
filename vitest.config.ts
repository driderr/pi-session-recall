import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Worker cap (2026-10-22). The default pool spawns one fork per CPU — 24 on
    // this box — and each worker loads the extension plus the pi-ai mock. Run
    // 24 at once and several die: "FATAL ERROR: Committing semi space failed.
    // Allocation failed - JavaScript heap out of memory", surfaced as
    // "Worker exited unexpectedly with exit code 3221226505". Measured on one
    // tree, minutes apart: default pool → 11 worker deaths and a meaningless
    // 512/583 report; maxWorkers 4 → 845 passed, 19 skipped, 0 deaths, 5.5 s.
    // Physical RAM was not the limit (39 GB of 128 GB free) — it is per-worker
    // V8/commit demand. The same signature is what killed pi when a subagent
    // ran the full suite unbounded.
    maxWorkers: 4,
    deps: {
      // memfs is CJS — force ESM interop so vi.doMock works cleanly
      interopDefault: true,
    },
  },
  resolve: {
    alias: {
      "@earendil-works/pi-ai": resolve(__dirname, "test/mocks/pi-ai.ts"),
    },
  },
});
