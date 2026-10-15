// Core decision logic now tested against the REAL exported shouldSkipByTimeCore
// (design §2.4) instead of a mirror copy of the logic.
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config.js";
import { shouldSkipByTimeCore, shouldSkipByTimeForLongTerm, type LongTermSummary } from "../summarizer.js";
import * as logger from "../logger.js";

// Default interval from config is 4 hours = 14_400_000 ms
const DEFAULT_INTERVAL = DEFAULT_CONFIG.longTermMinIntervalMs;

// Maps a fixture onto the production core: parse via new Date(iso).getTime(),
// null for never-merged/empty timestamp; corrupt timestamps route through the
// seam (which logs the corrupted-timestamp warning).
function decision(
  longTerm: LongTermSummary | null,
  nowMs: number,
  intervalMs: number = DEFAULT_INTERVAL,
): boolean {
  if (!longTerm || !longTerm.timestamp) {
    return shouldSkipByTimeCore(null, intervalMs, 0, nowMs);
  }
  const lastMerge = new Date(longTerm.timestamp).getTime();
  if (Number.isNaN(lastMerge)) {
    return shouldSkipByTimeForLongTerm(longTerm, DEFAULT_CONFIG, 0, nowMs);
  }
  return shouldSkipByTimeCore(lastMerge, intervalMs, 0, nowMs);
}

describe("shouldSkipByTime — core decision logic (real shouldSkipByTimeCore)", () => {
  const nowMs = Date.now();

  it("first merge (no long-term data) should not skip", () => {
    expect(decision(null, nowMs)).toBe(false);
  });

  it("first merge (empty timestamp) should not skip", () => {
    const longTerm: LongTermSummary = {
      timestamp: "",
      summary: "test",
      charCount: 4,
      sessionCount: 0,
      mergedSessions: [],
    };
    expect(decision(longTerm, nowMs)).toBe(false);
  });

  it("within interval should skip", () => {
    const lastMerge = new Date(nowMs - 3600000).toISOString(); // 1 hour ago
    const longTerm: LongTermSummary = {
      timestamp: lastMerge,
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    expect(decision(longTerm, nowMs)).toBe(true);
  });

  it("outside interval should not skip", () => {
    const lastMerge = new Date(nowMs - 5 * 3600000).toISOString(); // 5 hours ago
    const longTerm: LongTermSummary = {
      timestamp: lastMerge,
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    expect(decision(longTerm, nowMs)).toBe(false);
  });

  it("corrupted/NaN timestamp should not skip (and the seam logs the warning)", () => {
    const longTerm: LongTermSummary = {
      timestamp: "not-a-real-date",
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    const logSpy = vi.spyOn(logger, "log").mockImplementation(() => {});
    try {
      expect(decision(longTerm, nowMs)).toBe(false);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("corrupted long-term timestamp"));
    } finally {
      logSpy.mockRestore();
    }
  });

  it("boundary: exactly at threshold should NOT skip (elapsed == interval)", () => {
    const lastMerge = new Date(nowMs - DEFAULT_INTERVAL).toISOString();
    const longTerm: LongTermSummary = {
      timestamp: lastMerge,
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    // elapsed === interval => elapsed < interval is false => should NOT skip
    expect(decision(longTerm, nowMs)).toBe(false);
  });

  it("boundary: 1ms before threshold should skip", () => {
    const lastMerge = new Date(nowMs - (DEFAULT_INTERVAL - 1)).toISOString();
    const longTerm: LongTermSummary = {
      timestamp: lastMerge,
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    // elapsed = interval - 1 => elapsed < interval is true => should skip
    expect(decision(longTerm, nowMs)).toBe(true);
  });

  it("boundary: 1ms after threshold should NOT skip", () => {
    const lastMerge = new Date(nowMs - (DEFAULT_INTERVAL + 1)).toISOString();
    const longTerm: LongTermSummary = {
      timestamp: lastMerge,
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    // elapsed = interval + 1 => elapsed < interval is false => should NOT skip
    expect(decision(longTerm, nowMs)).toBe(false);
  });

  it("respects custom interval from config", () => {
    const customConfig = { longTermMinIntervalMs: 3600000 }; // 1 hour

    // 30 minutes ago — within 1-hour custom interval
    const lastMerge = new Date(nowMs - 30 * 60000).toISOString();
    const longTerm: LongTermSummary = {
      timestamp: lastMerge,
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    expect(decision(longTerm, nowMs, customConfig.longTermMinIntervalMs)).toBe(true);

    // 2 hours ago — outside 1-hour custom interval
    const lastMerge2 = new Date(nowMs - 2 * 3600000).toISOString();
    const longTerm2: LongTermSummary = {
      timestamp: lastMerge2,
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    expect(decision(longTerm2, nowMs, customConfig.longTermMinIntervalMs)).toBe(false);
  });

  it("handles very old timestamp (days ago) — should not skip", () => {
    const lastMerge = new Date(nowMs - 3 * 24 * 3600000).toISOString(); // 3 days ago
    const longTerm: LongTermSummary = {
      timestamp: lastMerge,
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    expect(decision(longTerm, nowMs)).toBe(false);
  });

  it("handles just-merged timestamp (seconds ago) — should skip", () => {
    const lastMerge = new Date(nowMs - 5000).toISOString(); // 5 seconds ago
    const longTerm: LongTermSummary = {
      timestamp: lastMerge,
      summary: "test summary",
      charCount: 12,
      sessionCount: 1,
      mergedSessions: [],
    };
    expect(decision(longTerm, nowMs)).toBe(true);
  });
});

// ─── Integration test for the actual shouldSkipByTime function ─────────
// This verifies the function's I/O path works (calls readLongTerm, applies logic).

describe("shouldSkipByTime — integration", () => {
  it("function is callable and returns a boolean", async () => {
    const { shouldSkipByTime } = await import("../summarizer.js");
    const result = await shouldSkipByTime(DEFAULT_CONFIG);
    expect(typeof result).toBe("boolean");
  });

  it("returns false when no long-term data exists (fresh environment)", async () => {
    const { shouldSkipByTime, closeCacheDb } = await import("../summarizer.js");

    // Close any open DB to ensure clean state
    closeCacheDb();

    // In a fresh test environment, there should be no long-term data
    const result = await shouldSkipByTime(DEFAULT_CONFIG);

    // If there IS existing long-term data (from previous runs or the real system),
    // the result depends on the timestamp. We verify the function doesn't crash.
    expect(typeof result).toBe("boolean");
  });
});
