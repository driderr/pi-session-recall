import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { vol } from "memfs";
import { createRequire } from "node:module";
import { withLlmBusy, mergeLongTerm, ensureSchema, packMergeChunks, runMergeFold } from "../summarizer.js";
import { DEFAULT_CONFIG } from "../config.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import * as logger from "../logger.js";
import { G } from "../types.js"; // Typed globalThis accessor
import {
  mockCompleteReset,
  mockCompleteQueue,
  mockCompleteCalls,
} from "@earendil-works/pi-ai";

// LLM-level fixture recipe (design §4.1) for the mergeLongTerm tests below:
// memfs homedir + seeded models.json so getPrimaryModel() resolves the mock
// primary. Unique per-file HOMEDIR avoids cross-file memfs collisions.
const HOMEDIR = "/test/sr-llm-busy";

vi.mock("node:os", () => ({ homedir: () => "/test/sr-llm-busy" }));
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

/** Valid 5-section table summary (passes the T2 validateTableSummary gate) with the label row. */
function validTables(label: string): string {
  const empty = (name: string) => `## ${name}\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| (none) | | |`;
  const first = `## Key Decisions\n| Item | Score | Last-Seen |\n|------|-------|-----------|\n| ${label} | 1 | 1 |`;
  return [first, empty("Patterns & Conventions"), empty("Configuration"), empty("Lessons Learned"), empty("Open Issues")].join("\n\n");
}
describe("withLlmBusy", () => {
  beforeEach(() => {
    G.__sessionRecallLlmBusy__ = false;
  });

  it("completes single call normally", async () => {
    const result = await withLlmBusy(async () => "success");
    expect(result).toBe("success");
  });

  it("skips concurrent calls", async () => {
    // Start a long-running call
    const longCall = withLlmBusy(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "done";
    });

    // Immediately try a second call while first is in progress
    const skipped = await withLlmBusy(async () => "should-not-run");
    expect(skipped).toBeNull();

    // Wait for the first call to complete
    await longCall;
  });

  it("allows sequential calls after completion", async () => {
    const result1 = await withLlmBusy(async () => "first");
    expect(result1).toBe("first");

    const result2 = await withLlmBusy(async () => "second");
    expect(result2).toBe("second");
  });

  it("clears flag on callback error", async () => {
    await expect(withLlmBusy(async () => {
      throw new Error("test error");
    })).rejects.toThrow("test error");

    // Flag should be cleared
    expect(G.__sessionRecallLlmBusy__).toBe(false);

    // Next call should work
    const result = await withLlmBusy(async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("awaits async callbacks", async () => {
    const result = await withLlmBusy(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "delayed";
    });
    expect(result).toBe("delayed");
  });
});

// ─── mergeLongTerm busy acquisition (design §4.2, Whole-Run Busy Hold) ────

describe("mergeLongTerm busy acquisition (Whole-Run Busy Hold)", () => {
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
    G.__sessionRecallLlmBusy__ = false;
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("standalone callers retain internal acquisition (skip-not-queue)", async () => {
    // Flag already held -> skip, 0 LLM calls, flag untouched (still true —
    // the skipped call must not release someone else's flag).
    G.__sessionRecallLlmBusy__ = true;
    const skipped = await mergeLongTerm("s", ["e"], DEFAULT_CONFIG);
    expect(skipped.text).toBeNull(); // P10: result object ({ text, restores }) — busy skip = today's null
    expect(mockCompleteCalls()).toHaveLength(0);
    expect(G.__sessionRecallLlmBusy__).toBe(true);
    expect(messages.join("\n")).toContain("LLM call skipped");

    // Flag free -> acquires, executes, releases in finally.
    G.__sessionRecallLlmBusy__ = false;
    mockCompleteQueue({ content: [{ type: "text", text: validTables("OK") }], stopReason: "stop" });
    const result = await mergeLongTerm("s", ["e"], DEFAULT_CONFIG);
    expect(result.text).toContain("OK"); // P10: result object
    expect(mockCompleteCalls()).toHaveLength(1);
    expect(G.__sessionRecallLlmBusy__).toBe(false);
  });

  it("busyHeld: false bypasses re-acquire — caller owns the flag", async () => {
    G.__sessionRecallLlmBusy__ = true;
    mockCompleteQueue({ content: [{ type: "text", text: validTables("OK") }], stopReason: "stop" });
    const result = await mergeLongTerm("s", ["e"], DEFAULT_CONFIG, { busyHeld: false });
    expect(result.text).toContain("OK"); // P10: result object
    expect(mockCompleteCalls()).toHaveLength(1);
    // The fold-level caller owns the flag — a busyHeld call must not release it.
    expect(G.__sessionRecallLlmBusy__).toBe(true);
  });
  it("whole-run hold: both flags held between chunks; busy released in finally", async () => {
    const db: any = new Database(":memory:");
    ensureSchema(db);
    try {
      const insert = db.prepare(
        "INSERT OR REPLACE INTO session_summaries " +
        "(session_path, version, summary, char_count, merge_count, updated_at) " +
        "VALUES (?, 1, ?, ?, ?, ?)",
      );
      const setFresh = db.prepare("UPDATE session_summaries SET unmerged_fresh_content = ? WHERE session_path = ?");
      const nowIso = new Date().toISOString();
      const seed: Array<[string, string]> = [
        ["/pi/agent/sessions/sess-a.jsonl", "content-A " + "a".repeat(100)],
        ["/pi/agent/sessions/sess-b.jsonl", "content-B " + "b".repeat(100)],
      ];
      for (const [path, content] of seed) {
        insert.run(path, content, content.length, 1, nowIso); // 5 placeholders (version 1 is literal in SQL)
        setFresh.run(content, path);
      }

      G.__sessionRecallMergeInProgress__ = true; // mimics the handler's synchronous set
      G.__sessionRecallLlmBusy__ = false;
      mockCompleteQueue({ content: [{ type: "text", text: validTables("O1") }], stopReason: "stop" });
      const between: { busy: boolean; inProgress: boolean } = { busy: false, inProgress: false };
      mockCompleteQueue(async () => {
        between.busy = G.__sessionRecallLlmBusy__ === true;
        between.inProgress = G.__sessionRecallMergeInProgress__ === true;
        return { content: [{ type: "text", text: validTables("O2") }], stopReason: "stop" };
      });

      const rows = db.prepare(
        "SELECT session_path, unmerged_fresh_content FROM session_summaries " +
        "WHERE unmerged_fresh_content IS NOT NULL AND length(unmerged_fresh_content) > 0 " +
        "ORDER BY updated_at ASC",
      ).all();
      const result = await runMergeFold(db, packMergeChunks(rows, 100), "base", [], DEFAULT_CONFIG);

      expect(result.processedChunks).toBe(2);
      // Between chunks: the fold holds the LLM-busy flag, and the handler's
      // merge-in-progress flag is still set for the whole run.
      expect(between.busy).toBe(true);
      expect(between.inProgress).toBe(true);
      // After the run: the fold's finally released the busy flag.
      expect(G.__sessionRecallLlmBusy__).toBe(false);
    } finally {
      G.__sessionRecallMergeInProgress__ = false; // handler's finally — mimicked by the test
      db.close();
    }
  });
});
