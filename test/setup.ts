import { beforeEach } from "vitest";
import { vol } from "memfs";
import { G } from "../types.js"; // Typed globalThis accessor

beforeEach(() => {
  // Reset LLM busy flag
  G.__sessionRecallLlmBusy__ = false;
  // Reset LLM stats
  G.__sessionRecallLlmStats__ = undefined as any; // Reset to trigger re-init
  // Reset VCC merge flags
  G.__sessionRecallVccMerge__ = {};
  // Reset in-memory filesystem
  vol.reset();
});
