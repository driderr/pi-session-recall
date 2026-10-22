// Fix 2 (2026-10-22): the pre-fold readiness wait must not pay 90 seconds for
// an address that cannot answer.
//
// What the 2026-10-07 wait was for: this box's llama-server has a crash/wobble
// history, and pi's LLM client retries nothing, so one brief connection failure
// at fold start used to kill the whole fold. A REFUSED connection is exactly
// that wobble signature, so a refusal is deliberately still retried — dropping
// it would remove the protection the wait exists to give. The cost that is real
// and removable:
//   1. A server that answers but does not implement GET /models (HTTP 404) used
//      to burn the whole window and then run anyway. Something is listening, so
//      it is ready — answer at once.
//   2. An address that cannot be resolved or reached (ENOTFOUND, EHOSTUNREACH…)
//      will not start listening inside the window. Fail at once.
//   3. A refusal is capped to a shorter window (15 s) instead of 90 s: a full
//      llama-server restart (model load) is never absorbed by 90 s anyway, so
//      the window only ever covered a brief blip or a mid-startup port.
//   4. Three fold entry points could each pay the wait in one session start.
//      A failure for the same URL is remembered briefly so the second caller
//      does not re-pay.
import { describe, it, expect, vi } from "vitest";
import {
  waitForLlmEndpointReady,
  clearLlmReadyMemo,
  FOLD_LLM_READY_TIMEOUT_MS,
  FOLD_LLM_READY_POLL_MS,
  FOLD_LLM_READY_REFUSED_TIMEOUT_MS,
} from "../summarizer.js";

// Test hygiene (2026-10-22): the real logger appends to the LIVE extension log
// (~/.pi/agent/extensions/session-recall/log-<UTC date>.txt). This suite calls
// waitForLlmEndpointReady directly, so its LLM-WAIT lines were landing in the
// operator's log - one carried a fake-clock age of -90000ms. Capture instead.
const logged: string[] = [];
vi.mock("../logger.js", () => ({
  getLogPath: () => "/test/log.txt",
  rotateLogs: () => {},
  log: (msg: string) => { logged.push(msg); },
  getRecentLogLines: (count: number) => logged.slice(-count),
}));

const BASE_URL = "http://127.0.0.1:5001/v1";
type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Network error in the shape undici/node fetch actually throws. */
function fetchFailed(code: string): TypeError {
  const err = new TypeError("fetch failed") as TypeError & { cause: unknown };
  err.cause = Object.assign(new Error(code), { code });
  return err;
}

const statusResponse = (status: number): Response =>
  ({ ok: status < 400, status }) as Response;

/** Clock that advances one poll per probe, so a bounded window can expire. */
function tickingClock(start = 0) {
  let t = start;
  return { now: () => t, advancePoll: () => { t += FOLD_LLM_READY_POLL_MS; } };
}

describe("pre-fold readiness wait — fail fast for a dead address (fix 2)", () => {
  it("an endpoint that answers HTTP 404 is listening — ready after ONE probe, no window", async () => {
    clearLlmReadyMemo();
    const sleep = vi.fn(async () => {});
    const fetch: FetchImpl = async () => statusResponse(404);
    const clock = tickingClock();
    const ready = await waitForLlmEndpointReady(BASE_URL, { sleep, now: clock.now, fetchImpl: fetch });
    expect(ready).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("an endpoint that answers HTTP 500 is listening — ready after ONE probe", async () => {
    clearLlmReadyMemo();
    const sleep = vi.fn(async () => {});
    const fetch: FetchImpl = async () => statusResponse(500);
    const ready = await waitForLlmEndpointReady(BASE_URL, { sleep, now: () => 0, fetchImpl: fetch });
    expect(ready).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("ECONNREFUSED is still absorbed (the crash/wobble case) — but the window is the short one", async () => {
    clearLlmReadyMemo();
    const sleep = vi.fn(async () => {});
    const fetch: FetchImpl = async () => {
      throw fetchFailed("ECONNREFUSED");
    };
    const clock = tickingClock();
    const ready = await waitForLlmEndpointReady(BASE_URL, {
      sleep: async () => {
        clock.advancePoll();
        await sleep();
      },
      now: clock.now,
      fetchImpl: fetch,
    });
    expect(ready).toBe(false);
    // 15 s / 3 s = 5 probes, and the 90 s window was never reached.
    expect(sleep).toHaveBeenCalledTimes(FOLD_LLM_READY_REFUSED_TIMEOUT_MS / FOLD_LLM_READY_POLL_MS);
    expect(FOLD_LLM_READY_REFUSED_TIMEOUT_MS).toBeLessThan(FOLD_LLM_READY_TIMEOUT_MS);
    expect(logged.some(m => m.includes('shortening the wait to'))).toBe(true);
  });

  it("ENOTFOUND (no such address) fails immediately — one probe, zero sleeps", async () => {
    clearLlmReadyMemo();
    const sleep = vi.fn(async () => {});
    let probes = 0;
    const fetch: FetchImpl = async () => {
      probes++;
      throw fetchFailed("ENOTFOUND");
    };
    const ready = await waitForLlmEndpointReady(BASE_URL, { sleep, now: () => 0, fetchImpl: fetch });
    expect(ready).toBe(false);
    expect(probes).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logged.some(m => m.includes('unreachable'))).toBe(true);
  });

  it("EHOSTUNREACH fails immediately too (an unroutable host will not appear)", async () => {
    clearLlmReadyMemo();
    const sleep = vi.fn(async () => {});
    let probes = 0;
    const fetch: FetchImpl = async () => {
      probes++;
      throw fetchFailed("EHOSTUNREACH");
    };
    const ready = await waitForLlmEndpointReady(BASE_URL, { sleep, now: () => 0, fetchImpl: fetch });
    expect(ready).toBe(false);
    expect(probes).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("an unknown failure class keeps the full 90 s window (unchanged wobble behaviour)", async () => {
    clearLlmReadyMemo();
    const sleep = vi.fn(async () => {});
    const fetch: FetchImpl = async () => {
      throw new TypeError("fetch failed"); // no cause — not classifiable
    };
    const clock = tickingClock();
    const ready = await waitForLlmEndpointReady(BASE_URL, {
      sleep: async () => {
        clock.advancePoll();
        await sleep();
      },
      now: clock.now,
      fetchImpl: fetch,
    });
    expect(ready).toBe(false);
    expect(sleep).toHaveBeenCalledTimes(FOLD_LLM_READY_TIMEOUT_MS / FOLD_LLM_READY_POLL_MS);
  });

  it("a failed wait for the same URL is remembered — the next caller pays one probe at most, not another window", async () => {
    let probes = 0;
    const fetch: FetchImpl = async () => {
      probes++;
      throw fetchFailed("ECONNREFUSED");
    };
    clearLlmReadyMemo();
    const clock = tickingClock();
    const sleep = vi.fn(async () => {});
    const first = await waitForLlmEndpointReady(BASE_URL, {
      sleep: async () => {
        clock.advancePoll();
        await sleep();
      },
      now: clock.now,
      fetchImpl: fetch,
    });
    expect(first).toBe(false);
    const probesAfterFirst = probes;
    const second = await waitForLlmEndpointReady(BASE_URL, { sleep, now: clock.now, fetchImpl: fetch });
    expect(second).toBe(false);
    // The memo path pays exactly ONE probe (a restarted server is detected
    // immediately); it never re-runs the window.
    expect(probes, "the second fold entry point must not re-run the window").toBe(probesAfterFirst + 1);
  });

  it("a ready endpoint clears the failure memory, so a later fold probes again normally", async () => {
    clearLlmReadyMemo();
    const clock = tickingClock();
    const failing: FetchImpl = async () => {
      throw fetchFailed("ECONNREFUSED");
    };
    const first = await waitForLlmEndpointReady(BASE_URL, {
      sleep: async () => {
        clock.advancePoll();
      },
      now: clock.now,
      fetchImpl: failing,
    });
    expect(first).toBe(false);
    let probes = 0;
    const working: FetchImpl = async () => {
      probes++;
      return statusResponse(200);
    };
    const second = await waitForLlmEndpointReady(BASE_URL, { sleep: async () => {}, now: clock.now, fetchImpl: working });
    expect(second).toBe(true);
    expect(probes).toBe(1);
  });
});
