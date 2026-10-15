import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { vol } from "memfs";
import { createFsMock } from "./mocks/fs.js";

// Mock node:fs so summarizer reads from memfs
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

describe("getPrimaryModel", () => {
  beforeEach(() => {
    vi.resetModules();
    vol.reset();
    _testHome = "/test/home";
    vol.mkdirSync(AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    vol.reset();
    vi.resetModules();
  });

  it("returns null when models.json does not exist", async () => {
    const { getPrimaryModel } = await import("../summarizer.js");
    const result = getPrimaryModel();
    expect(result).toBeNull();
  });

  it("returns null when providers object is empty", async () => {
    setupModels({ providers: {} });

    const { getPrimaryModel } = await import("../summarizer.js");
    const result = getPrimaryModel();
    expect(result).toBeNull();
  });

  it("returns null when first provider has no models", async () => {
    setupModels({
      providers: {
        testProvider: {
          api: "openai",
          baseUrl: "https://api.test.com",
          apiKey: "key123",
          models: [],
        },
      },
    });

    const { getPrimaryModel } = await import("../summarizer.js");
    const result = getPrimaryModel();
    expect(result).toBeNull();
  });

  it("returns correct model info when one provider with one model exists", async () => {
    setupModels({
      providers: {
        myProvider: {
          api: "openai",
          baseUrl: "https://api.test.com/v1",
          apiKey: "sk-test123",
          models: [
            {
              id: "gpt-4",
              name: "GPT-4",
              maxTokens: 8192,
              reasoning: true,
              input: ["text", "image"] as const,
              contextWindow: 131072,
              cost: { input: 0.01, output: 0.03, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    });

    const { getPrimaryModel } = await import("../summarizer.js");
    const result = getPrimaryModel();
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("myProvider");
    expect(result!.modelId).toBe("gpt-4");
    expect(result!.name).toBe("GPT-4");
    expect(result!.api).toBe("openai");
    expect(result!.baseUrl).toBe("https://api.test.com/v1");
    expect(result!.apiKey).toBe("sk-test123");
    expect(result!.reasoning).toBe(true);
    expect(result!.input).toEqual(["text", "image"]);
    expect(result!.maxTokens).toBe(8192);
    expect(result!.contextWindow).toBe(131072);
    expect(result!.cost).toEqual({ input: 0.01, output: 0.03, cacheRead: 0, cacheWrite: 0 });
  });

  it("picks first provider when multiple exist", async () => {
    setupModels({
      providers: {
        firstProvider: {
          api: "openai",
          baseUrl: "https://first.com",
          apiKey: "key1",
          models: [
            { id: "model-a", name: "Model A" },
          ],
        },
        secondProvider: {
          api: "openai",
          baseUrl: "https://second.com",
          apiKey: "key2",
          models: [
            { id: "model-b", name: "Model B" },
          ],
        },
      },
    });

    const { getPrimaryModel } = await import("../summarizer.js");
    const result = getPrimaryModel();
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("firstProvider");
    expect(result!.modelId).toBe("model-a");
  });

  it("picks first model when multiple exist", async () => {
    setupModels({
      providers: {
        provider1: {
          api: "openai",
          baseUrl: "https://api.com",
          apiKey: "key1",
          models: [
            { id: "model-1", name: "First Model" },
            { id: "model-2", name: "Second Model" },
            { id: "model-3", name: "Third Model" },
          ],
        },
      },
    });

    const { getPrimaryModel } = await import("../summarizer.js");
    const result = getPrimaryModel();
    expect(result).not.toBeNull();
    expect(result!.modelId).toBe("model-1");
    expect(result!.name).toBe("First Model");
  });

  it("defaults maxTokens to 4096 and contextWindow to 128000 when not specified", async () => {
    setupModels({
      providers: {
        p: {
          api: "openai",
          baseUrl: "https://api.com",
          apiKey: "k",
          models: [
            { id: "m", name: "M" },
          ],
        },
      },
    });

    const { getPrimaryModel } = await import("../summarizer.js");
    const result = getPrimaryModel();
    expect(result).not.toBeNull();
    expect(result!.maxTokens).toBe(4096);
    expect(result!.contextWindow).toBe(128000);
  });

  it("defaults input to ['text'] when not specified", async () => {
    setupModels({
      providers: {
        p: {
          api: "openai",
          baseUrl: "https://api.com",
          apiKey: "k",
          models: [
            { id: "m", name: "M" },
          ],
        },
      },
    });

    const { getPrimaryModel } = await import("../summarizer.js");
    const result = getPrimaryModel();
    expect(result).not.toBeNull();
    expect(result!.input).toEqual(["text"]);
  });

  it("defaults cost to zeros when not specified", async () => {
    setupModels({
      providers: {
        p: {
          api: "openai",
          baseUrl: "https://api.com",
          apiKey: "k",
          models: [
            { id: "m", name: "M" },
          ],
        },
      },
    });

    const { getPrimaryModel } = await import("../summarizer.js");
    const result = getPrimaryModel();
    expect(result).not.toBeNull();
    expect(result!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
