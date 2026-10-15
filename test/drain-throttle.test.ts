// Drain-interval throttle (design §2.4, pin B) — pure core + I/O seam, no DB.
// Spec: Drain-Interval Throttle.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DEFAULT_CONFIG, type SessionRecallConfig } from "../config.js";
import {
  shouldSkipByTimeCore,
  effectiveMergeIntervalMs,
  shouldSkipByTimeForLongTerm,
  type LongTermSummary,
} from "../summarizer.js";
import * as logger from "../logger.js";

const DRAIN = 1_800_000; // 30 min — default mergeDrainIntervalMs
const NORMAL = 14_400_000; // 4 h — default longTermMinIntervalMs
const NOW = 1_758_000_000_000; // fixed epoch — deterministic arithmetic

function longTermWithTimestamp(timestamp: string): LongTermSummary {
  return { timestamp, summary: "s", charCount: 1, sessionCount: 0, mergedSessions: [] };
}

describe("shouldSkipByTimeCore (pure decision)", () => {
  it("unmerged rows remain — skip inside drain interval (10 min ago < 30 min effective)", () => {
    expect(shouldSkipByTimeCore(NOW - 10 * 60_000, DRAIN, 5, NOW)).toBe(true);
  });

  it("unmerged rows remain — proceed after drain interval elapsed (31 min >= 30 min)", () => {
    expect(shouldSkipByTimeCore(NOW - 31 * 60_000, DRAIN, 5, NOW)).toBe(false);
  });

  it("boundary: exactly the drain interval is NOT a skip; 1ms before IS", () => {
    expect(shouldSkipByTimeCore(NOW - DRAIN, DRAIN, 5, NOW)).toBe(false);
    expect(shouldSkipByTimeCore(NOW - (DRAIN - 1), DRAIN, 5, NOW)).toBe(true);
  });

  it("full drain (0 unmerged) resumes the normal 4-hour gate", () => {
    expect(shouldSkipByTimeCore(NOW - 3_600_000, NORMAL, 0, NOW)).toBe(true); // 1h < 4h
    expect(shouldSkipByTimeCore(NOW - 5 * 3_600_000, NORMAL, 0, NOW)).toBe(false); // 5h >= 4h
  });

  it("never merged before (null timestamp) — no skip", () => {
    expect(shouldSkipByTimeCore(null, DRAIN, 5, NOW)).toBe(false);
    expect(shouldSkipByTimeCore(null, NORMAL, 0, NOW)).toBe(false);
  });

  it("unmergedCount is accepted but not decision-relevant when the caller passes the same effective interval (pin B)", () => {
    const t = NOW - 10 * 60_000;
    expect(shouldSkipByTimeCore(t, DRAIN, 5, NOW)).toBe(shouldSkipByTimeCore(t, DRAIN, 0, NOW));
    expect(shouldSkipByTimeCore(t, NORMAL, 5, NOW)).toBe(shouldSkipByTimeCore(t, NORMAL, 0, NOW));
  });

  it("triangulation: ±1ms boundary at the normal interval", () => {
    expect(shouldSkipByTimeCore(NOW - NORMAL, NORMAL, 0, NOW)).toBe(false);
    expect(shouldSkipByTimeCore(NOW - (NORMAL - 1), NORMAL, 0, NOW)).toBe(true);
    expect(shouldSkipByTimeCore(NOW - (NORMAL + 1), NORMAL, 0, NOW)).toBe(false);
  });
});

describe("effectiveMergeIntervalMs", () => {
  it("is min(drain, normal) while unmerged rows remain", () => {
    const config: SessionRecallConfig = { ...DEFAULT_CONFIG, mergeDrainIntervalMs: 28_800_000 }; // 8h drain
    expect(effectiveMergeIntervalMs(config, 3)).toBe(14_400_000); // min(8h, 4h) = 4h
    expect(effectiveMergeIntervalMs(DEFAULT_CONFIG, 3)).toBe(1_800_000); // min(30m, 4h) = 30m
  });

  it("resumes the normal gate after full drain", () => {
    expect(effectiveMergeIntervalMs(DEFAULT_CONFIG, 0)).toBe(14_400_000);
  });
});

describe("shouldSkipByTimeForLongTerm (I/O seam between readLongTerm and the pure core)", () => {
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation(m => messages.push(m));
  });
  afterEach(() => { logSpy.mockRestore(); });

  it("corrupt timestamp — no skip + warning logged", () => {
    const result = shouldSkipByTimeForLongTerm(longTermWithTimestamp("not-a-date"), DEFAULT_CONFIG, 5, NOW);
    expect(result).toBe(false);
    expect(messages.join("\n")).toContain("corrupted long-term timestamp");
  });

  it("empty timestamp / null longTerm — no skip, no corrupt warning", () => {
    expect(shouldSkipByTimeForLongTerm(longTermWithTimestamp(""), DEFAULT_CONFIG, 5, NOW)).toBe(false);
    expect(shouldSkipByTimeForLongTerm(null, DEFAULT_CONFIG, 5, NOW)).toBe(false);
    expect(messages.join("\n")).not.toContain("corrupted long-term timestamp");
  });

  it("applies the drain-aware effective interval end to end (spec: min(8h,4h)=4h, 3h ago -> skip; 5h ago -> proceed)", () => {
    const config: SessionRecallConfig = { ...DEFAULT_CONFIG, mergeDrainIntervalMs: 28_800_000 }; // 8h
    const threeHoursAgo = new Date(NOW - 3 * 3_600_000).toISOString();
    expect(shouldSkipByTimeForLongTerm(longTermWithTimestamp(threeHoursAgo), config, 3, NOW)).toBe(true);
    const fiveHoursAgo = new Date(NOW - 5 * 3_600_000).toISOString();
    expect(shouldSkipByTimeForLongTerm(longTermWithTimestamp(fiveHoursAgo), config, 3, NOW)).toBe(false);
  });
});
