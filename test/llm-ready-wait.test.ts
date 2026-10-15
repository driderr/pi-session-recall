// waitForLlmEndpointReady (summarizer.ts, 2026-10-07) — the bounded pre-fold
// readiness wait that absorbs the local llama-server (5001) startup/wobble
// window before any fold work. The pi 1.0.x zero-retry LLM client makes one
// fold-start TCP blip fatal, so the fold call sites wait (bounded) first.
//
// Hermetic: every clock and network path is injected via LlmReadyWaitIo — the
// suite never probes a real endpoint and never sleeps wall-clock (the per-probe
// 5s abort watchdog is constant-covered, not timer-tested, to keep the suite fast).

import { describe, it, expect, vi } from "vitest";
import {
  waitForLlmEndpointReady,
  FOLD_LLM_READY_TIMEOUT_MS,
  FOLD_LLM_READY_POLL_MS,
} from "../summarizer.js";

const BASE_URL = "http://127.0.0.1:5001/v1";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const okResponse = (): Response => ({ ok: true, status: 200 }) as Response;

/** A fetch that fails the first `fails` calls, then answers 200. */
function scriptedFetch(fails: number): { fetch: FetchImpl; calls: () => number; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fetch: FetchImpl = async (url) => {
    urls.push(url);
    i++;
    if (i <= fails) throw new TypeError("fetch failed"); // ECONNREFUSED-class network error
    return okResponse();
  };
  return { fetch, calls: () => i, urls };
}

const instantIo = (fetch: FetchImpl) => ({
  sleep: async () => {}, // no wall-clock sleep; now() is frozen below
  now: () => 0,          // frozen clock — the deadline can never expire mid-test
  fetchImpl: fetch,
});

describe("waitForLlmEndpointReady (pre-fold bounded wait)", () => {
  it("first probe 200 → true immediately; exactly one probe, zero sleeps (silent steady state)", async () => {
    const { fetch, calls } = scriptedFetch(0);
    const sleep = vi.fn(async () => {});
    const result = await waitForLlmEndpointReady(BASE_URL, { ...instantIo(fetch), sleep });

    expect(result).toBe(true);
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("network failures then recovery → true; one sleep per failed probe, at the poll cadence", async () => {
    const { fetch, calls } = scriptedFetch(2);
    const sleep = vi.fn(async () => {});
    const result = await waitForLlmEndpointReady(BASE_URL, { ...instantIo(fetch), sleep });

    expect(result).toBe(true);
    expect(calls()).toBe(3); // two failures, then the recovery probe
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, FOLD_LLM_READY_POLL_MS);
  });

  it("non-200 (404) is NOT ready — keeps polling until a 200", async () => {
    const urls: string[] = [];
    let i = 0;
    const fetch: FetchImpl = async (url) => {
      urls.push(url);
      i++;
      return i === 1 ? ({ ok: false, status: 404 } as Response) : okResponse();
    };
    const result = await waitForLlmEndpointReady(BASE_URL, instantIo(fetch));

    expect(result).toBe(true);
    expect(i).toBe(2);
  });

  it("always-failing endpoint → false at the deadline; probes at 0, 3s, … 87s (30 probes), no probe past the deadline", async () => {
    let t = 0;
    const probeTimes: number[] = [];
    const fetch: FetchImpl = async () => {
      probeTimes.push(t);
      throw new TypeError("fetch failed");
    };
    const io = {
      sleep: async (ms: number) => { t += ms; },
      now: () => t,
      fetchImpl: fetch,
    };
    const result = await waitForLlmEndpointReady(BASE_URL, io);

    expect(result).toBe(false);
    expect(probeTimes).toHaveLength(FOLD_LLM_READY_TIMEOUT_MS / FOLD_LLM_READY_POLL_MS); // 90s / 3s = 30
    expect(probeTimes[0]).toBe(0);
    expect(probeTimes[probeTimes.length - 1]).toBe(FOLD_LLM_READY_TIMEOUT_MS - FOLD_LLM_READY_POLL_MS); // 87s — none at/after 90s
  });

  it("no baseUrl (no model discovered) → true immediately, zero probes (the engine's no-model path owns that case)", async () => {
    const fetch: FetchImpl = async () => { throw new Error("must not be called"); };
    await expect(waitForLlmEndpointReady(undefined, instantIo(fetch))).resolves.toBe(true);
    await expect(waitForLlmEndpointReady("", instantIo(fetch))).resolves.toBe(true);
  });

  it("trailing slash in baseUrl is normalized — probes {baseUrl}/models exactly once", async () => {
    const { fetch, urls } = scriptedFetch(0);
    await waitForLlmEndpointReady(`${BASE_URL}/`, instantIo(fetch));
    expect(urls).toEqual([`${BASE_URL}/models`]);
  });
});
