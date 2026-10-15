// Pure units for embeddings.ts (rowstore-embeddings design §8.1).
// memfs models.json template = test/get-primary-model.test.ts:6-43; the global fetch is
// stubbed per case (embeddings.ts reads only .ok/.status/.json off the response).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vol } from "memfs";
import { createFsMock } from "./mocks/fs.js";
// Fresh per-test logger instance (resetModules below re-evaluates modules — the spy must
// target the same instance the freshly imported ../embeddings.js binds to).
let logger: typeof import("../logger.js");

vi.doMock("node:fs", async () => createFsMock());

// Module-level mutable test home — no circular import
let _testHome = "/test/home";

vi.doMock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: () => _testHome,
  };
});

const AGENT_DIR = "/test/home/.pi/agent";
const MODELS_PATH = `${AGENT_DIR}/models.json`;

function setupModels(data: unknown) {
  vol.mkdirSync(AGENT_DIR, { recursive: true });
  vol.writeFileSync(MODELS_PATH, JSON.stringify(data));
}

/** llamacpp-embed-shaped provider + model (the real models.json entry shape). */
const EMBED_PROVIDER = {
  api: "openai-embeddings",
  baseUrl: "http://127.0.0.1:5002/v1",
  apiKey: "none",
  models: [
    { id: "nomic-embed-text-v1.5", name: "Nomic Embed Text", embedding: true, dimensions: 768 },
  ],
};

type FetchCall = [string, { body?: string; headers?: Record<string, string>; signal?: AbortSignal }];

function okFetch(vector: number[]): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: vector }] }) }));
}

describe("embeddings (rowstore-embeddings design §8.1)", () => {
  let messages: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    logger = await import("../logger.js"); // fresh instance — same one ../embeddings.js binds to
    vol.reset();
    _testHome = "/test/home";
    vol.mkdirSync(AGENT_DIR, { recursive: true });
    messages = [];
    logSpy = vi.spyOn(logger, "log").mockImplementation((m: string) => { messages.push(m); });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vol.reset();
    vi.resetModules();
    logSpy.mockRestore();
  });

  const embedLogs = (): string[] => messages.filter((m) => m.startsWith("embed:"));

  // ─── Discovery ─────────────────────────────────────────────────────────
  describe("getEmbeddingModel (discovery)", () => {
    it("resolves a llamacpp-embed-shaped entry (flat shape)", async () => {
      setupModels({ providers: { "llamacpp-embed": EMBED_PROVIDER } });
      const { getEmbeddingModel } = await import("../embeddings.js");
      expect(getEmbeddingModel()).toEqual({
        provider: "llamacpp-embed",
        modelId: "nomic-embed-text-v1.5",
        name: "Nomic Embed Text",
        api: "openai-embeddings",
        baseUrl: "http://127.0.0.1:5002/v1",
        apiKey: "none",
        dimensions: 768,
      });
    });

    it("multiple matches → first in stable Object.entries order + warning listing all", async () => {
      setupModels({ providers: {
        beta: { api: "openai-embeddings", baseUrl: "http://127.0.0.1:5002/v1", apiKey: "none", models: [{ id: "beta-embed", name: "Beta", embedding: true }] },
        alpha: { api: "openai-embeddings", baseUrl: "http://127.0.0.1:5003/v1", apiKey: "none", models: [{ id: "alpha-embed", name: "Alpha", embedding: true }] },
      } });
      const { getEmbeddingModel } = await import("../embeddings.js");
      const info = getEmbeddingModel();
      expect(info?.provider).toBe("beta"); // first in stable Object.entries order
      expect(info?.modelId).toBe("beta-embed");
      const warning = embedLogs().find((m) => m.includes("beta") && m.includes("alpha"));
      expect(warning, "a warning listing all matches").toBeTruthy();
    });

    it("no match → null + an embed: line", async () => {
      setupModels({ providers: { p: { api: "openai", baseUrl: "http://x", apiKey: "k", models: [{ id: "m", name: "M" }] } } });
      const { getEmbeddingModel } = await import("../embeddings.js");
      expect(getEmbeddingModel()).toBeNull();
      expect(embedLogs()).toHaveLength(1);
    });

    it("missing models.json → null", async () => {
      const { getEmbeddingModel } = await import("../embeddings.js");
      expect(getEmbeddingModel()).toBeNull();
    });

    it("non-openai-embeddings api → null (fail closed) + warning", async () => {
      setupModels({ providers: { p: { api: "openai", baseUrl: "http://x", apiKey: "k", models: [{ id: "m", name: "M", embedding: true }] } } });
      const { getEmbeddingModel } = await import("../embeddings.js");
      expect(getEmbeddingModel()).toBeNull();
      expect(embedLogs().some((m) => m.includes("p/m")), "a warning naming the refused model").toBe(true);
    });

    it("unparseable models.json → null", async () => {
      vol.writeFileSync(MODELS_PATH, "not json {");
      const { getEmbeddingModel } = await import("../embeddings.js");
      expect(getEmbeddingModel()).toBeNull();
    });
  });

  // ─── Cosine similarity ─────────────────────────────────────────────────
  describe("cosineSimilarity", () => {
    it("orthogonal vectors → 0", async () => {
      const { cosineSimilarity } = await import("../embeddings.js");
      expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    });

    it("identical non-zero vectors → 1", async () => {
      const { cosineSimilarity } = await import("../embeddings.js");
      expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    });

    it("zero vector → 0", async () => {
      const { cosineSimilarity } = await import("../embeddings.js");
      expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    });

    it("length mismatch → 0", async () => {
      const { cosineSimilarity } = await import("../embeddings.js");
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });
  });

  // ─── Prefix selection (P3) + null-on-failure ───────────────────────────
  describe("embedText (P3 prefixes + null-on-failure)", () => {
    function setupEmbedModel(apiKey: string = "none", dimensions?: number) {
      setupModels({ providers: {
        "llamacpp-embed": {
          api: "openai-embeddings",
          baseUrl: "http://127.0.0.1:5002/v1",
          apiKey,
          models: [{ id: "nomic-embed-text-v1.5", name: "Nomic", embedding: true, ...(dimensions !== undefined ? { dimensions } : {}) }],
        },
      } });
    }

    it("query kind sends the search_query prefix (byte-exact, trailing space included)", async () => {
      setupEmbedModel();
      const fetchStub = okFetch([0.1, 0.2, 0.3, 0.4]);
      vi.stubGlobal("fetch", fetchStub);
      const { embedText } = await import("../embeddings.js");
      const vec = await embedText("hello world", "query");
      expect(vec).toEqual([0.1, 0.2, 0.3, 0.4]);
      const [url, init] = fetchStub.mock.calls[0] as FetchCall;
      expect(url).toBe("http://127.0.0.1:5002/v1/embeddings");
      const body = JSON.parse(String(init.body));
      expect(body.input).toBe("search_query: hello world");
      expect(body.model).toBe("nomic-embed-text-v1.5");
    });

    it("document kind sends the search_document prefix (byte-exact, trailing space included)", async () => {
      setupEmbedModel();
      const fetchStub = okFetch([0.1, 0.2, 0.3, 0.4]);
      vi.stubGlobal("fetch", fetchStub);
      const { embedText } = await import("../embeddings.js");
      await embedText("hello world", "document");
      const body = JSON.parse(String((fetchStub.mock.calls[0] as FetchCall)[1].body));
      expect(body.input).toBe("search_document: hello world");
    });

    it("baseUrl trailing slash is normalized (no double slash before /embeddings)", async () => {
      setupModels({ providers: {
        "llamacpp-embed": { api: "openai-embeddings", baseUrl: "http://127.0.0.1:5002/v1/", apiKey: "none", models: [{ id: "nomic-embed-text-v1.5", name: "Nomic", embedding: true }] },
      } });
      const fetchStub = okFetch([0.1]);
      vi.stubGlobal("fetch", fetchStub);
      const { embedText } = await import("../embeddings.js");
      await embedText("t", "query");
      expect((fetchStub.mock.calls[0] as FetchCall)[0]).toBe("http://127.0.0.1:5002/v1/embeddings");
    });

    it("no Authorization header for apiKey \"none\"; Bearer for a real key", async () => {
      setupEmbedModel("none");
      const noneStub = okFetch([0.1]);
      vi.stubGlobal("fetch", noneStub);
      const { embedText } = await import("../embeddings.js");
      await embedText("t", "query");
      expect((noneStub.mock.calls[0] as FetchCall)[1].headers).not.toHaveProperty("authorization");

      setupEmbedModel("sk-live-key"); // models.json is re-read on every call (no cache)
      const keyStub = okFetch([0.1]);
      vi.stubGlobal("fetch", keyStub);
      await embedText("t", "query");
      expect((keyStub.mock.calls[0] as FetchCall)[1].headers?.authorization).toBe("Bearer sk-live-key");
    });

    it("HTTP error → null + embed: line, no throw", async () => {
      setupEmbedModel();
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
      const { embedText } = await import("../embeddings.js");
      await expect(embedText("t", "query")).resolves.toBeNull();
      expect(embedLogs().some((m) => m.includes("HTTP 500"))).toBe(true);
    });

    it("network error → null + embed: line, no throw", async () => {
      setupEmbedModel();
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNRESET 127.0.0.1:5002"); }));
      const { embedText } = await import("../embeddings.js");
      await expect(embedText("t", "query")).resolves.toBeNull();
      expect(embedLogs()).toHaveLength(1);
    });

    it("watchdog timeout → null + embed: line (fake timers), no throw", async () => {
      setupEmbedModel();
      vi.useFakeTimers();
      vi.stubGlobal("fetch", vi.fn((_url: string, init: FetchCall[1]) =>
        new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")));
        })));
      const { embedText, EMBED_CALL_WATCHDOG_MS } = await import("../embeddings.js");
      const pending = embedText("t", "query");
      const expectation = expect(pending).resolves.toBeNull(); // handler attached immediately (no unhandled rejection)
      expectation.catch(() => {}); // RED-skeleton rejection is expected; the await below still fails the test
      await vi.advanceTimersByTimeAsync(EMBED_CALL_WATCHDOG_MS);
      await expectation;
      expect(embedLogs().some((m) => m.includes("watchdog timeout"))).toBe(true);
    });

    it("malformed body (missing data / non-array embedding / non-finite values) → null + embed: line", async () => {
      setupEmbedModel();
      const { embedText } = await import("../embeddings.js");
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
      await expect(embedText("t", "query")).resolves.toBeNull();
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: "nope" }] }) })));
      await expect(embedText("t", "query")).resolves.toBeNull();
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, NaN] }] }) })));
      await expect(embedText("t", "query")).resolves.toBeNull();
      expect(embedLogs()).toHaveLength(3);
    });

    it("dimensions mismatch (declared 768, got 8) → null + embed: line", async () => {
      setupEmbedModel("none", 768);
      const vec8 = Array.from({ length: 8 }, (_, i) => i / 8);
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: vec8 }] }) })));
      const { embedText } = await import("../embeddings.js");
      await expect(embedText("t", "query")).resolves.toBeNull();
      expect(embedLogs().some((m) => m.includes("dimensions"))).toBe(true);
    });
  });

  // ─── Batch embedding (all-or-null) ─────────────────────────────────────
  describe("embedBatch (all-or-null)", () => {
    function setupEmbedModel() {
      setupModels({ providers: {
        "llamacpp-embed": { api: "openai-embeddings", baseUrl: "http://127.0.0.1:5002/v1", apiKey: "none", models: [{ id: "nomic-embed-text-v1.5", name: "Nomic", embedding: true }] },
      } });
    }

    it("success returns the 3 vectors in input order (one request, array input)", async () => {
      setupEmbedModel();
      const fetchStub = vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ data: [{ embedding: [1, 1] }, { embedding: [2, 2] }, { embedding: [3, 3] }] }),
      }));
      vi.stubGlobal("fetch", fetchStub);
      const { embedBatch } = await import("../embeddings.js");
      const out = await embedBatch(["a", "b", "c"], "document");
      expect(out).toEqual([[1, 1], [2, 2], [3, 3]]);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String((fetchStub.mock.calls[0] as FetchCall)[1].body));
      expect(body.input).toEqual(["search_document: a", "search_document: b", "search_document: c"]);
    });

    it("any failure → null (no partial results)", async () => {
      setupEmbedModel();
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ data: [{ embedding: [1, 1] }, { embedding: [2, 2] }] }), // 2 of 3
      })));
      const { embedBatch } = await import("../embeddings.js");
      await expect(embedBatch(["a", "b", "c"], "document")).resolves.toBeNull();
      expect(embedLogs()).toHaveLength(1);
    });
  });
});
