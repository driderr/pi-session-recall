// Gated live embedding test (rowstore-embeddings design §8.1 Q9) — runs ONLY with EMBED_LIVE=1.
//
// Mirrors the LT_LIVE gating of test/lt-conversion-live.test.ts: the describe is
// registered via describe.runIf, so the default `npx vitest run` skips the whole
// suite (baseline unchanged). No fs/os mocks: real homedir → real models.json +
// the real llama-server on the configured port. Real ../embeddings.js imported
// directly (embeddings.ts has no pi-ai dependency → nothing for the alias to bypass).
// The four assertions are the Q9 pinned set; parent task 6.6 runs this live.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as logger from "../logger.js";
import { EXTENSION_DIR, loadConfigOnce } from "../config.js";
import {
  embedText,
  cosineSimilarity,
  ensureEmbedServer,
  EMBED_MODEL_ID,
  type EmbedServerIo,
} from "../embeddings.js";

describe.runIf(process.env.EMBED_LIVE === "1")("embeddings live (EMBED_LIVE=1) — design §8.1 Q9", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const messages: string[] = [];

  beforeEach(() => {
    messages.length = 0;
    logSpy = vi.spyOn(logger, "log").mockImplementation((m: string) => { messages.push(m); });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("(1) GET /v1/models contains nomic-embed-text-v1.5", { timeout: 60_000 }, async () => {
    const config = loadConfigOnce(EXTENSION_DIR);
    const res = await fetch(`http://127.0.0.1:${config.embedServerPort}/v1/models`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(EMBED_MODEL_ID);
  });

  it("(2) embedText returns exactly 768 finite numbers", { timeout: 120_000 }, async () => {
    const vec = await embedText("the session-recall extension folds long-term memory", "query");
    expect(vec, "embedText must resolve (live server reachable + model discovered)").not.toBeNull();
    expect(vec!.length).toBe(768);
    for (const n of vec!) expect(Number.isFinite(n)).toBe(true);
  });

  it("(3) same text, query vs document prefixes → cosine < 1 (prefix reaches the server)", { timeout: 240_000 }, async () => {
    const t = "prefixes change the embedded text";
    const a = await embedText(t, "query");
    const b = await embedText(t, "document");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Identical raw text with different Nomic prefixes (P3) embeds differently:
    // an unprefixed (or same-prefix) embedding pair would give cosine ≈ 1.
    expect(cosineSimilarity(a!, b!)).toBeLessThan(1);
  });

  it("(4) probe-already-ready → READY source=probe, zero spawn attempts", { timeout: 60_000 }, async () => {
    const config = loadConfigOnce(EXTENSION_DIR);
    const spawnStub: NonNullable<EmbedServerIo["spawn"]> = () => {
      throw new Error("spawn must not be attempted (server already ready)");
    };

    const status = await ensureEmbedServer(config, { spawn: spawnStub });

    expect(status).toEqual({ status: "ready", source: "probe", port: config.embedServerPort });
    expect(messages).toContain(`LTROW-SRV READY port=${config.embedServerPort} source=probe`);
  });
});
