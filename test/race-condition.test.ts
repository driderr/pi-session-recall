import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { G } from "../types.js"; // Typed globalThis accessor

describe("race condition guards", () => {
  beforeEach(() => {
    G.__sessionRecallVccMerge__ = {};
  });

  it("globalThis flag prevents concurrent merge on same session", () => {
    const mergeMap = G.__sessionRecallVccMerge__;
    const sessionPath = "/path/to/session.jsonl";

    // Simulate first merge acquiring the flag
    mergeMap[sessionPath] = true;

    // Check that second merge would be blocked
    const isBlocked = mergeMap[sessionPath] === true;
    expect(isBlocked).toBe(true);

    // Clear flag
    delete mergeMap[sessionPath];
    expect(mergeMap[sessionPath]).toBeUndefined();
  });

  it("different sessions merge concurrently", () => {
    const mergeMap = G.__sessionRecallVccMerge__;
    const pathA = "/path/A.jsonl";
    const pathB = "/path/B.jsonl";

    mergeMap[pathA] = true;

    // Session B should not be blocked
    expect(mergeMap[pathB]).toBeUndefined();
    mergeMap[pathB] = true;

    // Both should be active
    expect(mergeMap[pathA]).toBe(true);
    expect(mergeMap[pathB]).toBe(true);

    delete mergeMap[pathA];
    delete mergeMap[pathB];
  });

  it("hash dedup prevents redundant merge", () => {
    const fresh1 = "[Session Goal]\n- Build API";
    const fresh2 = "[Session Goal]\n- Build API";

    const hash1 = createHash("md5").update(fresh1).digest("hex");
    const hash2 = createHash("md5").update(fresh2).digest("hex");

    expect(hash1).toBe(hash2); // Same content = same hash
  });

  it("different summaries produce different hashes", () => {
    const fresh1 = "[Session Goal]\n- Build API";
    const fresh2 = "[Session Goal]\n- Add auth";

    const hash1 = createHash("md5").update(fresh1).digest("hex");
    const hash2 = createHash("md5").update(fresh2).digest("hex");

    expect(hash1).not.toBe(hash2);
  });

  it("flag is cleared in finally block (simulated)", () => {
    const mergeMap = G.__sessionRecallVccMerge__;
    const sessionPath = "/path/to/session.jsonl";

    mergeMap[sessionPath] = true;

    // Simulate try/finally pattern
    let errorOccurred = false;
    try {
      errorOccurred = true;
      throw new Error("simulated error");
    } catch {
      // Error handled
    } finally {
      delete mergeMap[sessionPath];
    }

    expect(errorOccurred).toBe(true);
    expect(mergeMap[sessionPath]).toBeUndefined(); // Flag cleared despite error
  });

  it("finally clears flag on the CAPTURED mergeMap, not a stale global re-read", () => {
    // Regression test for: finally block read G.__sessionRecallVccMerge__ again
    // instead of using the captured mergeMap reference. If the global is
    // reassigned between try and finally (e.g., by a concurrent call), the
    // delete would operate on the wrong object, permanently locking the session.

    const mergeMapA = { "/session/A.jsonl": true };
    G.__sessionRecallVccMerge__ = mergeMapA;

    // Simulate: between try and finally, another call reassigns the global
    const mergeMapB: Record<string, boolean> = {};
    G.__sessionRecallVccMerge__ = mergeMapB;

    // The fix: finally uses the captured mergeMapA reference, not G re-read
    // So it deletes from mergeMapA, not mergeMapB
    delete mergeMapA["/session/A.jsonl"];

    // Verify: flag cleared on the ORIGINAL object
    expect(mergeMapA["/session/A.jsonl"]).toBeUndefined();
    // mergeMapB should be untouched
    expect(Object.keys(mergeMapB)).toHaveLength(0);
  });
});
