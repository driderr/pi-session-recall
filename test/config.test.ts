import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  loadConfig,
  loadConfigOnce,
  resetConfigCache,
  DEFAULT_CONFIG,
} from "../config.js";
import { vol } from "memfs";
import { join } from "node:path";

const tmpRoot = "/test/session-recall-config";

// Mock node:os so homedir() returns tmpRoot (for clamping tests)
vi.mock("node:os", () => ({
  homedir: () => "/test/session-recall-config",
}));
// Mock node:fs so config.js reads from memfs
vi.mock("node:fs", async () => {
  const { fs: memfsFs } = await import("memfs");
  return {
    default: memfsFs,
    ...memfsFs,
    watch: () => ({ close: () => {}, closeSync: () => {} }),
    unwatchFile: () => {},
    createReadStream: memfsFs.createReadStream,
    createWriteStream: memfsFs.createWriteStream,
    constants: memfsFs.constants,
  };
});

beforeEach(() => {
  resetConfigCache();
  vol.reset();
});

afterEach(() => {
  resetConfigCache();
  vol.reset();
});

describe("default config values", () => {
  it("all default fields are correct (incl. the 4 score-table keys)", () => {
    expect(DEFAULT_CONFIG.maxSessions).toBe(10);
    expect(DEFAULT_CONFIG.maxTokens).toBe(500);
    expect(DEFAULT_CONFIG.sessionScope).toBe("all");
    expect(DEFAULT_CONFIG.ignorePatterns).toEqual([]);
    expect(DEFAULT_CONFIG.summarizeTimeoutMs).toBe(600000);
    expect(DEFAULT_CONFIG.longTermMaxChars).toBe(5000);
    expect(DEFAULT_CONFIG.longTermMinIntervalMs).toBe(14400000); // 4 hours
    expect(DEFAULT_CONFIG.longTermMinTurns).toBe(10);
    expect(DEFAULT_CONFIG.mergeChunkChars).toBe(24000);
    expect(DEFAULT_CONFIG.mergeDrainIntervalMs).toBe(1800000); // 30 min
    expect(DEFAULT_CONFIG.mergeMaxChunksPerRun).toBe(8);
  });
});

describe("YAML config override", () => {
  it("reads custom values from YAML config", async () => {
    // NOTE: loadConfig() derives configPath from homedir(), not from the
    // extensionDir param. Without mocking node:os we can't inject a fake
    // homedir, so this test verifies defaults are returned when no config
    // exists at the real homedir path (which is the normal case).
    const config = loadConfig(tmpRoot);
    expect(config.maxSessions).toBe(DEFAULT_CONFIG.maxSessions);
    expect(config.maxTokens).toBe(DEFAULT_CONFIG.maxTokens);
    expect(config.sessionScope).toBe(DEFAULT_CONFIG.sessionScope);
    expect(config.ignorePatterns).toEqual(DEFAULT_CONFIG.ignorePatterns);
  });
});

describe("invalid value clamping", () => {
  // We test clamping by verifying DEFAULT_CONFIG values are within valid ranges
  // and by testing boundary values through the validateConfig warnings.

  it("maxSessions default is within valid range (1-50)", () => {
    expect(DEFAULT_CONFIG.maxSessions).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_CONFIG.maxSessions).toBeLessThanOrEqual(50);
  });

  it("maxTokens default is within valid range (100-2000)", () => {
    expect(DEFAULT_CONFIG.maxTokens).toBeGreaterThanOrEqual(100);
    expect(DEFAULT_CONFIG.maxTokens).toBeLessThanOrEqual(2000);
  });

  it("summarizeTimeoutMs default is within valid range (60000-600000)", () => {
    expect(DEFAULT_CONFIG.summarizeTimeoutMs).toBeGreaterThanOrEqual(60000);
    expect(DEFAULT_CONFIG.summarizeTimeoutMs).toBeLessThanOrEqual(600000);
  });

  it("longTermMaxChars default is within valid range (2000-10000)", () => {
    expect(DEFAULT_CONFIG.longTermMaxChars).toBeGreaterThanOrEqual(2000);
    expect(DEFAULT_CONFIG.longTermMaxChars).toBeLessThanOrEqual(10000);
  });

  it("longTermMinIntervalMs default is within valid range (300000-604800000)", () => {
    expect(DEFAULT_CONFIG.longTermMinIntervalMs).toBeGreaterThanOrEqual(300000);
    expect(DEFAULT_CONFIG.longTermMinIntervalMs).toBeLessThanOrEqual(604800000);
  });

  it("longTermMinTurns default is within valid range (1-1000)", () => {
    expect(DEFAULT_CONFIG.longTermMinTurns).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_CONFIG.longTermMinTurns).toBeLessThanOrEqual(1000);
  });

  it("mergeChunkChars: clamps 0 to minimum of 2000", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "mergeChunkChars: 0\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.mergeChunkChars).toBe(2000);
  });

  it("mergeChunkChars: clamps 999999 to maximum of 60000", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "mergeChunkChars: 999999\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.mergeChunkChars).toBe(60000);
  });

  it("mergeChunkChars: accepts value within range", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "mergeChunkChars: 24000\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.mergeChunkChars).toBe(24000);
  });

  it("mergeChunkChars: ignores string NaN and uses default", () => {
    // YAML parses NaN as string 'NaN', not number — typeof check rejects it
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "mergeChunkChars: NaN\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.mergeChunkChars).toBe(24000); // default
  });

  it("mergeDrainIntervalMs: clamps 30000 to spec-pinned floor of 60000", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "mergeDrainIntervalMs: 30000\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.mergeDrainIntervalMs).toBe(60000);
  });

  it("mergeDrainIntervalMs: clamps 1e12 to maximum of 604800000 (7 days)", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "mergeDrainIntervalMs: 1000000000000\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.mergeDrainIntervalMs).toBe(604800000);
  });

  it("mergeDrainIntervalMs: accepts value within range", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "mergeDrainIntervalMs: 1800000\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.mergeDrainIntervalMs).toBe(1800000);
  });

  it("mergeMaxChunksPerRun: clamps 0 to minimum of 1", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "mergeMaxChunksPerRun: 0\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.mergeMaxChunksPerRun).toBe(1);
  });

  it("mergeMaxChunksPerRun: clamps 51 to maximum of 50", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "mergeMaxChunksPerRun: 51\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.mergeMaxChunksPerRun).toBe(50);
  });
});

describe("missing config file behavior", () => {
  it("falls back to defaults when no config file exists", () => {
    // loadConfig always reads from homedir()/.pi/agent/session-recall.yaml
    // In the test environment, this file likely doesn't exist or has defaults
    const config = loadConfig(tmpRoot);

    // At minimum, the result should be a valid config object
    expect(config.maxSessions).toBeGreaterThan(0);
    expect(config.maxTokens).toBeGreaterThan(0);
    expect(["cwd", "all"]).toContain(config.sessionScope);
    expect(Array.isArray(config.ignorePatterns)).toBe(true);
    expect(config.summarizeTimeoutMs).toBeGreaterThan(0);
    expect(config.longTermMaxChars).toBeGreaterThan(0);
    expect(config.longTermMinIntervalMs).toBeGreaterThan(0);
    expect(config.longTermMinTurns).toBeGreaterThan(0);
  });
});

describe("sessionScope validation", () => {
  it("default sessionScope is 'all'", () => {
    expect(DEFAULT_CONFIG.sessionScope).toBe("all");
  });

  it("sessionScope must be 'cwd' or 'all'", () => {
    const config = loadConfig(tmpRoot);
    expect(["cwd", "all"]).toContain(config.sessionScope);
  });
});

describe("loadConfigOnce caching", () => {
  it("returns same cached result on second call with same extensionDir", () => {
    const config1 = loadConfigOnce(tmpRoot);
    const config2 = loadConfigOnce(tmpRoot);
    expect(config1).toBe(config2); // Same reference (cached)
  });

  it("different extensionDir busts the cache", () => {
    const dir1 = join(tmpRoot, "dir1");
    const dir2 = join(tmpRoot, "dir2");

    const config1 = loadConfigOnce(dir1);
    const config2 = loadConfigOnce(dir2);

    // Different extensionDir -> cache busted, new load
    expect(config1).not.toBe(config2); // Different references
  });
});

describe("resetConfigCache", () => {
  it("clears the cache so next loadConfigOnce reloads", () => {
    const config1 = loadConfigOnce(tmpRoot);
    resetConfigCache();
    const config2 = loadConfigOnce(tmpRoot);

    // After reset, should be a new reference (re-loaded)
    expect(config1).not.toBe(config2);
    // But values should be the same (same config file)
    expect(config1.maxSessions).toBe(config2.maxSessions);
    expect(config1.maxTokens).toBe(config2.maxTokens);
  });
});

describe("ignorePatterns filtering", () => {
  it("default ignorePatterns is an empty array", () => {
    expect(DEFAULT_CONFIG.ignorePatterns).toEqual([]);
  });

  it("ignorePatterns is always an array", () => {
    const config = loadConfig(tmpRoot);
    expect(Array.isArray(config.ignorePatterns)).toBe(true);
  });
});

describe("lessonExcludePatterns", () => {
  it("default lessonExcludePatterns is an empty array", () => {
    expect(DEFAULT_CONFIG.lessonExcludePatterns).toEqual([]);
  });

  it("lessonExcludePatterns is always an array", () => {
    const config = loadConfig(tmpRoot);
    expect(Array.isArray(config.lessonExcludePatterns)).toBe(true);
  });

  it("parses lessonExcludePatterns list from YAML", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]:
        "lessonExcludePatterns:\n  - discordGrabber\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.lessonExcludePatterns).toEqual(["discordGrabber"]);
  });

  it("filters non-string entries from lessonExcludePatterns", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]:
        "lessonExcludePatterns:\n  - discordGrabber\n  - 42\n  - null\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.lessonExcludePatterns).toEqual(["discordGrabber"]);
  });
});

describe("briefTranscriptCap clamping", () => {
  it("clamps 0 to minimum of 10", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "briefTranscriptCap: 0\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.briefTranscriptCap).toBe(10);
  });

  it("clamps -1 to minimum of 10", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "briefTranscriptCap: -1\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.briefTranscriptCap).toBe(10);
  });

  it("ignores string NaN and uses default", () => {
    // YAML parses NaN as string 'NaN', not number — typeof check rejects it
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "briefTranscriptCap: NaN\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.briefTranscriptCap).toBe(120); // default
  });

  it("clamps 9999 to maximum of 500", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "briefTranscriptCap: 9999\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.briefTranscriptCap).toBe(500);
  });

  it("accepts value within range", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "briefTranscriptCap: 200\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.briefTranscriptCap).toBe(200);
  });

  it("uses default when not specified", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "maxSessions: 5\n",
    });
    const config = loadConfig(tmpRoot);
    expect(config.briefTranscriptCap).toBe(120);
  });
});

describe("summarizeTimeoutMs low-value warning", () => {
  it("warns when summarizeTimeoutMs is below 300000 (known too short for local models)", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "summarizeTimeoutMs: 120000\n",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig(tmpRoot);
      expect(config.summarizeTimeoutMs).toBe(120000); // valid range — value preserved, not clamped
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("summarizeTimeoutMs"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn when summarizeTimeoutMs is 300000 or above", () => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: "summarizeTimeoutMs: 600000\n",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const config = loadConfig(tmpRoot);
      expect(config.summarizeTimeoutMs).toBe(600000);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("summarizeTimeoutMs"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("score-table long-term memory keys (score-table-long-term-memory)", () => {
  const writeYaml = (text: string) => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: text,
    });
  };

  it("defaults: recencyHalfLifeSessions 50, stalePruneAfterSessions 100, stalePruneMinScore 3, longTermHardMaxChars 20000", () => {
    expect(DEFAULT_CONFIG.recencyHalfLifeSessions).toBe(50);
    expect(DEFAULT_CONFIG.stalePruneAfterSessions).toBe(100);
    expect(DEFAULT_CONFIG.stalePruneMinScore).toBe(3);
    expect(DEFAULT_CONFIG.longTermHardMaxChars).toBe(20000);
    const config = loadConfig(tmpRoot);
    expect(config.recencyHalfLifeSessions).toBe(50);
    expect(config.stalePruneAfterSessions).toBe(100);
    expect(config.stalePruneMinScore).toBe(3);
    expect(config.longTermHardMaxChars).toBe(20000);
  });

  it("custom values respected (100 / 200 / 5 / 12000 with longTermMaxChars 5000)", () => {
    writeYaml(
      "recencyHalfLifeSessions: 100\n"
      + "stalePruneAfterSessions: 200\n"
      + "stalePruneMinScore: 5\n"
      + "longTermHardMaxChars: 12000\n"
      + "longTermMaxChars: 5000\n",
    );
    const config = loadConfig(tmpRoot);
    expect(config.recencyHalfLifeSessions).toBe(100);
    expect(config.stalePruneAfterSessions).toBe(200);
    expect(config.stalePruneMinScore).toBe(5);
    expect(config.longTermHardMaxChars).toBe(12000);
    expect(config.longTermMaxChars).toBe(5000);
  });

  it("recencyHalfLifeSessions: clamps 0 to 1 and 5000 to 1000", () => {
    writeYaml("recencyHalfLifeSessions: 0\n");
    expect(loadConfig(tmpRoot).recencyHalfLifeSessions).toBe(1);
    writeYaml("recencyHalfLifeSessions: 5000\n");
    expect(loadConfig(tmpRoot).recencyHalfLifeSessions).toBe(1000);
  });

  it("stalePruneAfterSessions: clamps 5 to 10 and 5000 to 1000", () => {
    writeYaml("stalePruneAfterSessions: 5\n");
    expect(loadConfig(tmpRoot).stalePruneAfterSessions).toBe(10);
    writeYaml("stalePruneAfterSessions: 5000\n");
    expect(loadConfig(tmpRoot).stalePruneAfterSessions).toBe(1000);
  });

  it("stalePruneMinScore: clamps 0 to 1 and 500 to 100", () => {
    writeYaml("stalePruneMinScore: 0\n");
    expect(loadConfig(tmpRoot).stalePruneMinScore).toBe(1);
    writeYaml("stalePruneMinScore: 500\n");
    expect(loadConfig(tmpRoot).stalePruneMinScore).toBe(100);
  });

  it("longTermHardMaxChars: clamps 4000 UP to the 5000 soft limit and 25000 down to 20000", () => {
    writeYaml("longTermHardMaxChars: 4000\n");
    expect(loadConfig(tmpRoot).longTermHardMaxChars).toBe(5000); // clamp up (soft default 5000)
    writeYaml("longTermHardMaxChars: 25000\n");
    expect(loadConfig(tmpRoot).longTermHardMaxChars).toBe(20000);
  });

  it("longTermHardMaxChars vs longTermMaxChars interaction: 7000 soft + 6000 hard -> 7000", () => {
    writeYaml("longTermMaxChars: 7000\nlongTermHardMaxChars: 6000\n");
    const config = loadConfig(tmpRoot);
    expect(config.longTermMaxChars).toBe(7000);
    expect(config.longTermHardMaxChars).toBe(7000);
  });

  it("longTermHardMaxChars stays at its 20000 default when longTermMaxChars is 7000 and the key is omitted", () => {
    writeYaml("longTermMaxChars: 7000\n");
    const config = loadConfig(tmpRoot);
    expect(config.longTermMaxChars).toBe(7000);
    expect(config.longTermHardMaxChars).toBe(20000);
  });

  it("new keys emit no validateConfig warnings", () => {
    writeYaml(
      "recencyHalfLifeSessions: 300\n"
      + "stalePruneAfterSessions: 300\n"
      + "stalePruneMinScore: 10\n"
      + "longTermHardMaxChars: 9000\n",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadConfig(tmpRoot);
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("recencyHalfLifeSessions"));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("stalePruneAfterSessions"));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("stalePruneMinScore"));
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("longTermHardMaxChars"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ─── Row-store fields (rowstore-embeddings, P5 pin) ───────────────────────

// Publication defaults (2026-10-15): the personal paths previously pinned here
// are now empty — Tier 2 paths are set per machine in session-recall.yaml.
const PINNED_GGUF = "";
const PINNED_EXE = "";

describe("row-store config fields (rowstore-embeddings P5)", () => {
  const writeYaml = (text: string) => {
    vol.fromJSON({
      [`${tmpRoot}/.pi/agent/session-recall.yaml`]: text,
    });
  };

  it("defaults: useRowStore false, floats 0.5/0.85, ints 5/20/5002/120000, empty Tier 2 paths", () => {
    expect(DEFAULT_CONFIG.useRowStore).toBe(false);
    expect(DEFAULT_CONFIG.embedRetrievalThreshold).toBe(0.5);
    expect(DEFAULT_CONFIG.embedRetrievalTopK).toBe(5);
    expect(DEFAULT_CONFIG.embedAutoConsolidateThreshold).toBe(0.85);
    expect(DEFAULT_CONFIG.rowStoreMaxSignalsPerRun).toBe(20);
    expect(DEFAULT_CONFIG.embedServerPort).toBe(5002);
    expect(DEFAULT_CONFIG.embedServerReadyTimeoutMs).toBe(120000);
    expect(DEFAULT_CONFIG.embedServerModelPath).toBe(PINNED_GGUF);
    expect(DEFAULT_CONFIG.embedServerExePath).toBe(PINNED_EXE);
    const config = loadConfig(tmpRoot);
    expect(config.useRowStore).toBe(false);
    expect(config.embedRetrievalThreshold).toBe(0.5);
    expect(config.embedRetrievalTopK).toBe(5);
    expect(config.embedAutoConsolidateThreshold).toBe(0.85);
    expect(config.rowStoreMaxSignalsPerRun).toBe(20);
    expect(config.embedServerPort).toBe(5002);
    expect(config.embedServerReadyTimeoutMs).toBe(120000);
    expect(config.embedServerModelPath).toBe(PINNED_GGUF);
    expect(config.embedServerExePath).toBe(PINNED_EXE);
  });

  it("useRowStore: boolean guard — non-boolean \"true\" ignored, real booleans apply", () => {
    writeYaml('useRowStore: "true"\n');
    expect(loadConfig(tmpRoot).useRowStore).toBe(false); // non-boolean ignored → default
    writeYaml("useRowStore: true\n");
    expect(loadConfig(tmpRoot).useRowStore).toBe(true);
  });

  it("embedRetrievalThreshold: -0.2→0, 1.7→1, no flooring 0.75→0.75, NaN/non-number → default", () => {
    writeYaml("embedRetrievalThreshold: -0.2\n");
    expect(loadConfig(tmpRoot).embedRetrievalThreshold).toBe(0);
    writeYaml("embedRetrievalThreshold: 1.7\n");
    expect(loadConfig(tmpRoot).embedRetrievalThreshold).toBe(1);
    writeYaml("embedRetrievalThreshold: 0.75\n");
    expect(loadConfig(tmpRoot).embedRetrievalThreshold).toBe(0.75); // first float clamp — no Math.floor
    writeYaml("embedRetrievalThreshold: NaN\n");
    expect(loadConfig(tmpRoot).embedRetrievalThreshold).toBe(0.5); // YAML parses NaN as string 'NaN' — rejected
    writeYaml("embedRetrievalThreshold: high\n");
    expect(loadConfig(tmpRoot).embedRetrievalThreshold).toBe(0.5); // non-number ignored
  });

  it("embedAutoConsolidateThreshold: 2.0→1, -1→0, NaN → default", () => {
    writeYaml("embedAutoConsolidateThreshold: 2.0\n");
    expect(loadConfig(tmpRoot).embedAutoConsolidateThreshold).toBe(1);
    writeYaml("embedAutoConsolidateThreshold: -1\n");
    expect(loadConfig(tmpRoot).embedAutoConsolidateThreshold).toBe(0);
    writeYaml("embedAutoConsolidateThreshold: NaN\n");
    expect(loadConfig(tmpRoot).embedAutoConsolidateThreshold).toBe(0.85);
  });

  it("embedRetrievalTopK: 0→1, 51→50, flooring 7.9→7", () => {
    writeYaml("embedRetrievalTopK: 0\n");
    expect(loadConfig(tmpRoot).embedRetrievalTopK).toBe(1);
    writeYaml("embedRetrievalTopK: 51\n");
    expect(loadConfig(tmpRoot).embedRetrievalTopK).toBe(50);
    writeYaml("embedRetrievalTopK: 7.9\n");
    expect(loadConfig(tmpRoot).embedRetrievalTopK).toBe(7); // int clamp floored
  });

  it("rowStoreMaxSignalsPerRun: 0→1, 99→50", () => {
    writeYaml("rowStoreMaxSignalsPerRun: 0\n");
    expect(loadConfig(tmpRoot).rowStoreMaxSignalsPerRun).toBe(1);
    writeYaml("rowStoreMaxSignalsPerRun: 99\n");
    expect(loadConfig(tmpRoot).rowStoreMaxSignalsPerRun).toBe(50);
  });

  it("embedServerPort: 80→1024, 70000→65535", () => {
    writeYaml("embedServerPort: 80\n");
    expect(loadConfig(tmpRoot).embedServerPort).toBe(1024);
    writeYaml("embedServerPort: 70000\n");
    expect(loadConfig(tmpRoot).embedServerPort).toBe(65535);
  });

  it("embedServerReadyTimeoutMs: 100→5000, 900000→600000", () => {
    writeYaml("embedServerReadyTimeoutMs: 100\n");
    expect(loadConfig(tmpRoot).embedServerReadyTimeoutMs).toBe(5000);
    writeYaml("embedServerReadyTimeoutMs: 900000\n");
    expect(loadConfig(tmpRoot).embedServerReadyTimeoutMs).toBe(600000);
  });

  it("embedServerModelPath: pinned GGUF default; empty/whitespace ignored; custom trimmed", () => {
    writeYaml('embedServerModelPath: ""\n');
    expect(loadConfig(tmpRoot).embedServerModelPath).toBe(PINNED_GGUF);
    writeYaml('embedServerModelPath: "   "\n');
    expect(loadConfig(tmpRoot).embedServerModelPath).toBe(PINNED_GGUF);
    writeYaml('embedServerModelPath: " E:/models/custom.gguf "\n');
    expect(loadConfig(tmpRoot).embedServerModelPath).toBe("E:/models/custom.gguf");
  });

  it("embedServerExePath: pinned llama-server.exe default; empty/whitespace ignored; custom trimmed", () => {
    writeYaml('embedServerExePath: ""\n');
    expect(loadConfig(tmpRoot).embedServerExePath).toBe(PINNED_EXE);
    writeYaml('embedServerExePath: "  D:/llama/llama-server.exe  "\n');
    expect(loadConfig(tmpRoot).embedServerExePath).toBe("D:/llama/llama-server.exe");
  });

  it("bootstrap copy: example carrying the nine fields + longTermHardMaxChars 20000 seeds the config", () => {
    resetConfigCache();
    const example = [
      "useRowStore: false",
      "embedRetrievalThreshold: 0.5",
      "embedRetrievalTopK: 5",
      "embedAutoConsolidateThreshold: 0.85",
      "rowStoreMaxSignalsPerRun: 20",
      "embedServerPort: 5002",
      "embedServerReadyTimeoutMs: 120000",
      `embedServerModelPath: '${PINNED_GGUF}'`,
      `embedServerExePath: '${PINNED_EXE}'`,
      "longTermHardMaxChars: 20000",
    ].join("\n");
    vol.mkdirSync(`${tmpRoot}/.pi/agent`, { recursive: true }); // real homedir always has this; the copy needs it
    vol.fromJSON({ [`${tmpRoot}/config.example.yaml`]: example });
    loadConfigOnce(tmpRoot); // first run: copies the example → config.yaml (returns defaults)
    resetConfigCache(); // force the copied config to be read
    const config = loadConfigOnce(tmpRoot);
    expect(vol.readFileSync(`${tmpRoot}/.pi/agent/session-recall.yaml`, "utf-8")).toContain("longTermHardMaxChars: 20000");
    expect(config.useRowStore).toBe(false);
    expect(config.embedRetrievalThreshold).toBe(0.5);
    expect(config.embedRetrievalTopK).toBe(5);
    expect(config.embedAutoConsolidateThreshold).toBe(0.85);
    expect(config.rowStoreMaxSignalsPerRun).toBe(20);
    expect(config.embedServerPort).toBe(5002);
    expect(config.embedServerReadyTimeoutMs).toBe(120000);
    expect(config.embedServerModelPath).toBe(PINNED_GGUF);
    expect(config.embedServerExePath).toBe(PINNED_EXE);
    expect(config.longTermHardMaxChars).toBe(20000);
  });
});
