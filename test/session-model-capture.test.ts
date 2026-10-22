import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vol } from "memfs";
import { createFsMock } from "./mocks/fs.js";

// Fix 1 (2026-10-22): the memory fold must use the model THIS session is using,
// not the first entry of ~/.pi/agent/models.json. Live symptom: the session ran
// `strata` on 127.0.0.1:8080 while the fold probed `llamacpp` on 127.0.0.1:5001
// for 90 seconds per attempt and then failed every lesson
// (log-2026-10-22.txt: "row-store fold complete: 4 lesson(s), 0 session(s)
// marked, 4 failed").
//
// Harness copied from test/get-primary-model.test.ts (memfs home + seeded
// models.json), so both files exercise the same discovery code path.

vi.doMock("node:fs", async () => createFsMock());

let _testHome = "/test/home";

vi.doMock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => _testHome,
  };
});

const AGENT_DIR = "/test/home/.pi/agent";
const MODELS_PATH = `${AGENT_DIR}/models.json`;

/** models.json whose FIRST provider is a server nobody is running. */
function setupDeadFirstProvider() {
  vol.mkdirSync(AGENT_DIR, { recursive: true });
  vol.writeFileSync(
    MODELS_PATH,
    JSON.stringify({
      providers: {
        llamacpp: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:5001/v1",
          apiKey: "none",
          models: [{ id: "qwen3.6-27b-nvfp4" }],
        },
      },
    }),
  );
}

/** The shape Pi hands extensions as `ctx.model` (pi Model, structurally). */
const STRATA = {
  provider: "strata",
  id: "qwen3.8-flash-next-iq3_s",
  name: "Qwen3.8 Flash",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:8080/v1",
  reasoning: true,
  input: ["text"] as ("text" | "image")[],
  maxTokens: 4096,
  contextWindow: 131072,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function mod() {
  return await import("../summarizer.js");
}

describe("session model capture (the fold follows the session's model)", () => {
  beforeEach(() => {
    vi.resetModules();
    vol.reset();
    _testHome = "/test/home";
    vol.mkdirSync(AGENT_DIR, { recursive: true });
  });

  afterEach(async () => {
    const m = await mod();
    m.clearSessionModel();
    vol.reset();
    vi.resetModules();
  });

  it("captureSessionModel maps ctx.model into the model info the fold uses", async () => {
    const m = await mod();
    const info = await m.captureSessionModel({ model: STRATA });
    expect(info).not.toBeNull();
    expect(info!.provider).toBe("strata");
    expect(info!.modelId).toBe("qwen3.8-flash-next-iq3_s");
    expect(info!.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(m.getSessionModel()).not.toBeNull();
  });

  it("getPrimaryModel returns the session model even when models.json lists another first", async () => {
    setupDeadFirstProvider();
    const m = await mod();
    await m.captureSessionModel({ model: STRATA });
    const result = m.getPrimaryModel();
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("strata");
    expect(result!.baseUrl).toBe("http://127.0.0.1:8080/v1");
  });

  it("with no session model captured, the models.json path is unchanged", async () => {
    setupDeadFirstProvider();
    const m = await mod();
    const result = m.getPrimaryModel();
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("llamacpp");
    expect(result!.baseUrl).toBe("http://127.0.0.1:5001/v1");
  });

  it("clearSessionModel puts the models.json path back", async () => {
    setupDeadFirstProvider();
    const m = await mod();
    await m.captureSessionModel({ model: STRATA });
    m.clearSessionModel();
    expect(m.getSessionModel()).toBeNull();
    expect(m.getPrimaryModel()!.provider).toBe("llamacpp");
  });

  it("captureSessionModel returns null and clears the capture when ctx has no model", async () => {
    const m = await mod();
    await m.captureSessionModel({ model: STRATA });
    const result = await m.captureSessionModel({ model: undefined });
    expect(result).toBeNull();
    expect(m.getSessionModel()).toBeNull();
  });

  it("the key comes from Pi's model registry when one is present", async () => {
    const m = await mod();
    const calls: unknown[] = [];
    const ctx = {
      model: STRATA,
      modelRegistry: {
        getApiKeyAndHeaders: async (model: unknown) => {
          calls.push(model);
          return { ok: true, apiKey: "sk-from-registry" };
        },
      },
    };
    const info = await m.captureSessionModel(ctx);
    expect(calls.length).toBe(1);
    expect(info!.apiKey).toBe("sk-from-registry");
    const pair = m.buildMergeModelPair();
    expect(pair).not.toBeNull();
    expect(pair!.apiKey).toBe("sk-from-registry");
  });

  it("a rejecting registry still captures the model, with the sk-none fallback", async () => {
    const m = await mod();
    const ctx = {
      model: STRATA,
      modelRegistry: {
        getApiKeyAndHeaders: async () => {
          throw new Error("registry offline");
        },
      },
    };
    const info = await m.captureSessionModel(ctx);
    expect(info).not.toBeNull();
    expect(info!.baseUrl).toBe("http://127.0.0.1:8080/v1");
    const pair = m.buildMergeModelPair();
    expect(pair!.apiKey).toBe("sk-none");
  });

  it("buildMergeModelPair with no argument uses the session model", async () => {
    setupDeadFirstProvider();
    const m = await mod();
    await m.captureSessionModel({ model: STRATA });
    const pair = m.buildMergeModelPair();
    expect(pair).not.toBeNull();
    expect((pair!.modelObj as { baseUrl: string }).baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect((pair!.modelObj as { id: string }).id).toBe("qwen3.8-flash-next-iq3_s");
  });

  it("an explicit discovered model still beats the session capture", async () => {
    const m = await mod();
    await m.captureSessionModel({ model: STRATA });
    const discovered = {
      provider: "explicit",
      modelId: "chosen",
      name: "chosen",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "k",
      reasoning: true,
      input: ["text"] as ("text" | "image")[],
      maxTokens: 4096,
      contextWindow: 131072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const pair = m.buildMergeModelPair(discovered);
    expect((pair!.modelObj as { baseUrl: string }).baseUrl).toBe("http://127.0.0.1:9999/v1");
  });

  it("a session model's own compat is kept; one without compat keeps the llama.cpp qwen default", async () => {
    const m = await mod();
    await m.captureSessionModel({ model: { ...STRATA, compat: { thinkingFormat: "chatml" } } });
    const withOwn = m.buildMergeModelPair()!;
    expect((withOwn.modelObj as { compat: unknown }).compat).toEqual({ thinkingFormat: "chatml" });

    await m.captureSessionModel({ model: STRATA });
    const without = m.buildMergeModelPair()!;
    expect((without.modelObj as { compat: unknown }).compat).toEqual({ thinkingFormat: "qwen-chat-template" });
    // R1 pin: reasoning stays true so buildParams() sends enable_thinking for the merge.
    expect((without.modelObj as { reasoning: boolean }).reasoning).toBe(true);
  });
});
