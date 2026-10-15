// Flat 30-minute emergency watchdog for the long-term merge LLM call
// (lt-merge-prompt-fix D2/D4): the merge timeout is the single flat
// MERGE_EMERGENCY_WATCHDOG_MS — no input-size-derived timeouts, no
// output-token cap. Expiry aborts the attempt → stopReason "aborted"
// → null → the EXISTING strike path (fold strike/quarantine; no new mechanism).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vol } from "memfs";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";
import {
  mergeLongTerm,
  productionConversionLlmCall,
  MERGE_EMERGENCY_WATCHDOG_MS,
} from "../summarizer.js";
import * as logger from "../logger.js";
import {
  mockCompleteReset,
  mockCompleteQueue,
  mockCompleteCalls,
} from "@earendil-works/pi-ai";

// Unique per-file memfs homedir (avoids cross-file memfs collisions).
const HOMEDIR = "/test/sr-merge-timeout";

vi.mock("node:os", () => ({ homedir: () => "/test/sr-merge-timeout" }));
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

const MODELS_JSON = {
  providers: {
    local: {
      api: "openai-completions",
      baseUrl: "http://localhost:5001/v1",
      apiKey: "none",
      models: [
        {
          id: "test-model",
          name: "Test",
          maxTokens: 8000,
          contextWindow: 256000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Valid 5-section table summary (passes the T2 validateTableSummary gate) with the label row. */
function validTables(label: string): string {
  const empty = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
  const first = `## Key Decisions\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| ${label} | 1 | 1 |`;
  return [first, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
}

/** Queued LLM that hangs until the attempt's signal is aborted (simulates a stuck llama.cpp). */
const hungUntilAbort = (call: { options: Record<string, unknown> }): Promise<unknown> =>
  new Promise(res => {
    const signal = call.options.signal as AbortSignal;
    signal.addEventListener("abort", () => res({ content: [], stopReason: "aborted" }), { once: true });
  });

describe("flat 30-minute merge watchdog (lt-merge-prompt-fix D2/D4)", () => {
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vol.fromJSON({
      [`${HOMEDIR}/.pi/agent/models.json`]: JSON.stringify(MODELS_JSON),
      [`${HOMEDIR}/.pi/agent/.keep`]: "",
    });
    mockCompleteReset();
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
  });
  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it("MERGE_EMERGENCY_WATCHDOG_MS is the single flat 30-minute constant", () => {
    expect(MERGE_EMERGENCY_WATCHDOG_MS).toBe(30 * 60 * 1000);
  });

  it("a hung mergeLongTerm attempt is aborted at exactly the flat watchdog (no size-derived timeout)", async () => {
    vi.useFakeTimers();
    const config: SessionRecallConfig = { ...DEFAULT_CONFIG };
    // Oversized input: the old size-derived scheme would have capped this at 20 min;
    // the flat watchdog must fire at 30 min instead.
    mockCompleteQueue(hungUntilAbort);

    let settled = false;
    const pending = mergeLongTerm("S".repeat(200_000), ["e"], config);
    pending.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(MERGE_EMERGENCY_WATCHDOG_MS - 1);
    expect(settled).toBe(false); // one ms before the flat watchdog: still running

    // Expiry → abort → stopReason "aborted" → null (the EXISTING strike flow), no retry.
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(settled).toBe(true);
    expect(result.text).toBeNull();
    expect(result.restoredItemTexts).toEqual([]);
    const calls = mockCompleteCalls();
    expect(calls).toHaveLength(1);
    expect((calls[0].options.signal as AbortSignal).aborted).toBe(true);
  });

  it("the conversion call site uses the same flat watchdog (abort at exactly 30 min → null)", async () => {
    vi.useFakeTimers();
    mockCompleteQueue(hungUntilAbort);

    let settled = false;
    const pending = productionConversionLlmCall("P".repeat(200_000), DEFAULT_CONFIG);
    pending.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(MERGE_EMERGENCY_WATCHDOG_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(settled).toBe(true);
    expect(result).toBeNull();
    expect(mockCompleteCalls()).toHaveLength(1); // single attempt — no transient retry
  });

  // ~5.2s real-timer test (real 5s retry backoff) — the single slow test in the
  // file (design §6.10); explicit timeout above vitest's 5s default.
  it("second attempt is not killed by the first attempt's elapsed time", { timeout: 15000 }, async () => {
    const config: SessionRecallConfig = { ...DEFAULT_CONFIG, summarizeTimeoutMs: 150 };
    // Attempt 1: transient connection reset after ~200ms (retryable).
    mockCompleteQueue(async () => {
      await sleep(200);
      throw new Error("ECONNRESET");
    });
    // Attempt 2: recovers ~50ms later.
    mockCompleteQueue(async () => {
      await sleep(50);
      return { content: [{ type: "text", text: validTables("RECOVERED") }], stopReason: "stop" };
    });

    const result = await mergeLongTerm("s", ["e"], config);

    expect(result.text).toContain("RECOVERED"); // P10: result object ({ text, restoredItemTexts })
    const calls = mockCompleteCalls();
    expect(calls).toHaveLength(2);
    // Attempt 1's controller is released (aborted) once the attempt settles…
    expect((calls[0].options.signal as { aborted: boolean }).aborted).toBe(true);
    // …and attempt 2 starts with a FRESH, not-yet-aborted controller.
    expect(calls[1].signalAbortedAtCall).toBe(false);
  });

  it("attempt timer is cleared in finally (no pending timer after a fast success)", async () => {
    vi.useFakeTimers();
    const config: SessionRecallConfig = { ...DEFAULT_CONFIG };
    mockCompleteQueue({ content: [{ type: "text", text: validTables("OK") }], stopReason: "stop" });

    const before = vi.getTimerCount();
    const result = await mergeLongTerm("s", ["e"], config);

    expect(result.text).toContain("OK"); // P10: result object ({ text, restoredItemTexts })
    expect(vi.getTimerCount()).toBe(before);
  });

  it("the merge LLM call passes no maxTokens / output-token cap", async () => {
    const config: SessionRecallConfig = { ...DEFAULT_CONFIG };
    mockCompleteQueue({ content: [{ type: "text", text: validTables("OK") }], stopReason: "stop" });
    const result = await mergeLongTerm("s", ["e"], config);
    expect(result.text).toContain("OK");
    const call = mockCompleteCalls()[0];
    expect(call.options).not.toHaveProperty("maxTokens"); // D2: the output-token cap was removed
    expect(call.options.reasoningEffort).toBe("low");
  });

  it("the existing summary is passed to the prompt unclamped (full >5,000-char text intact)", async () => {
    const config: SessionRecallConfig = { ...DEFAULT_CONFIG };
    // Table-shaped existing summary, well over the old 5,000-char front-clamp.
    const row = "| filler " + "Z".repeat(60) + " | 1 | 5 |";
    const emptySection = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
    const existing = [
      `## Key Decisions\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n${Array.from({ length: 120 }, () => row).join("\n")}`,
      emptySection("Patterns & Conventions"),
      emptySection("Configuration"),
      emptySection("Lessons Learned"),
      emptySection("Open Issues"),
    ].join("\n\n");
    expect(existing.length).toBeGreaterThan(5000);
    mockCompleteQueue({ content: [{ type: "text", text: validTables("OK") }], stopReason: "stop" });

    const result = await mergeLongTerm(existing, ["e"], config);
    expect(result.text).toContain("OK");
    const prompt = mockCompleteCalls()[0].promptText;
    expect(prompt).toContain(existing); // the FULL existing summary — no front-clamp
  });

});
