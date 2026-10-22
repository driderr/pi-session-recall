import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import defaultExport from "../index.js";

// The factory's load-time self-test calls the real openCacheDb, whose SQLITE_PATH is
// baked from the real homedir at module load — before the HOME stub below takes effect.
// Returning null keeps the self-test honest (it logs a WARN) without ever opening the
// operator's live session-index.sqlite. Every other summarizer export stays real.
vi.mock("../summarizer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../summarizer.js")>();
  return { ...actual, openCacheDb: vi.fn(async () => null) };
});
import { getSessionModel, getPrimaryModel, clearSessionModel } from "../summarizer.js";
import { G } from "../types.js";

// Fix 1 wiring (2026-10-22): index.ts must feed the session's live model into
// the summarizer's capture, so the memory fold follows a /model switch instead
// of the first entry of models.json. Hermetic home stub follows
// test/session-start-merge-flow.test.ts (clean-machine fix, 2026-10-15).

const REAL_HOME_ENV = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let stubHome: string;

beforeAll(() => {
  stubHome = mkdtempSync(join(tmpdir(), "sr-sessmodel-"));
  mkdirSync(join(stubHome, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(stubHome, ".pi", "agent", "models.json"),
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
  process.env.HOME = stubHome;
  process.env.USERPROFILE = stubHome;
});

afterAll(() => {
  process.env.HOME = REAL_HOME_ENV.HOME;
  process.env.USERPROFILE = REAL_HOME_ENV.USERPROFILE;
  clearSessionModel();
});

const STRATA = {
  provider: "strata",
  id: "qwen3.8-flash-next-iq3_s",
  name: "Qwen3.8 Flash",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:8080/v1",
  reasoning: true,
};

function register() {
  G.__sessionRecallLoaded__ = false; // the loaded guard otherwise skips re-registration
  const handlers: Record<string, (...args: any[]) => any> = {};
  defaultExport({
    on: (name: string, cb: (...args: any[]) => any) => {
      handlers[name] = cb;
      return () => {};
    },
    registerTool: () => {},
    registerCommand: () => {},
  } as any);
  return handlers;
}

const CTX: any = {
  sessionManager: { getSessionFile: () => "/test/sr/2026-10-22T00-00-00-000Z_deadbeef.jsonl" },
  cwd: "/test/sr",
  model: STRATA,
  modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-live" }) },
};

describe("index.ts feeds the live session model to the fold", () => {
  it("model_select moves the fold onto the newly selected model", async () => {
    const handlers = register();
    expect(handlers["model_select"], "index.ts must subscribe to model_select").toBeTypeOf("function");

    clearSessionModel();
    // With no capture the models.json fallback still applies (the live vehicles
    // depend on it): the dead first provider is what gets discovered.
    expect(getPrimaryModel()!.baseUrl).toBe("http://127.0.0.1:5001/v1");

    await handlers["model_select"](
      { type: "model_select", model: STRATA, previousModel: undefined, source: "set" },
      CTX,
    );

    expect(getSessionModel()!.provider).toBe("strata");
    expect(getPrimaryModel()!.baseUrl).toBe("http://127.0.0.1:8080/v1");
  });

  it("session_start refreshes the capture from ctx.model before the merge runs", async () => {
    const handlers = register();
    clearSessionModel();
    expect(getSessionModel()).toBeNull();

    // reason=reload returns at the reload guard, so the handler is observed
    // without starting the merge machinery (no DB, no embed server spawn).
    await handlers["session_start"]({ reason: "reload" }, CTX);

    expect(getSessionModel()!.provider).toBe("strata");
    expect(getPrimaryModel()!.baseUrl).toBe("http://127.0.0.1:8080/v1");
  });
});
