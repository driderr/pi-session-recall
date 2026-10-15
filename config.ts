import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

export interface SessionRecallConfig {
  maxSessions: number;
  maxTokens: number;
  sessionScope: "cwd" | "all";
  ignorePatterns: string[];
  lessonExcludePatterns: string[];   // Writer guard: sessions matching these paths never enter the unmerged pile (lesson extraction only; /recall reporting is ignorePatterns' job)
  // LLM summarization (long-term merge only)
  summarizeTimeoutMs: number;       // Max time for LLM merge call (ms)
  longTermMaxChars: number;         // Max chars for long-term summary (merge prompt + injection budget)
  longTermMinIntervalMs: number;    // Min ms between merges (default: 4h)
  longTermMinTurns: number;         // Min merge_count sum across unmerged sessions before merging (default: 10)
  // Long-term merge chunking (chunked fold)
  mergeChunkChars: number;        // Max rendered chars per merge chunk incl. headers + separators (default 24,000)
  mergeDrainIntervalMs: number;   // Time gate while unmerged rows remain (default 30 min)
  mergeMaxChunksPerRun: number;   // Max chunks processed per session_start fold run (default 8)
  // Score-table long-term memory (score-table-long-term-memory)
  recencyHalfLifeSessions: number;   // Recency half-life in sessions for LT injection ranking (default 50)
  stalePruneAfterSessions: number;   // Session-count gap after which a row is stale-prune eligible (default 100)
  stalePruneMinScore: number;        // Score below which a stale row is pruned by the merge prompt (default 3)
  longTermHardMaxChars: number;      // Post-merge validation ceiling; MUST be >= longTermMaxChars (default 20,000)
  // Row-store (rowstore-embeddings C1) — first boolean / float / free-form-string clamp shapes
  useRowStore: boolean;                   // Single row-store switch (default false; C4's one-time flip)
  injectShortTerm: boolean;   // Inject the short-term "Recent Signals" section at session start (default false — 2026-09-02)
  embedRetrievalThreshold: number;        // Cosine threshold below which a candidate row is not a match (0-1, no floor)
  embedRetrievalTopK: number;             // Max candidate rows returned per signal retrieval (1-50)
  embedAutoConsolidateThreshold: number;  // Near-duplicate threshold: C2 backfill log-only all-pairs dedup report (0-1, no floor); reserved for future auto-consolidation
  rowStoreMaxSignalsPerRun: number;       // Per-run cap on row-store signals processed (1-50) — dormant after C3.5 (zero spec break)
  lessonExtractMaxPerRun: number;         // Per-run cap on row-store EXTRACT calls (1-50) — the C3.5 selection leg
  embedServerPort: number;                // Local embed server port (1024-65535; floor keeps misconfig away from chat instances)
  embedServerReadyTimeoutMs: number;      // Readiness-poll bound after a spawn (5000-600000; 0 impossible)
  embedServerModelPath: string;           // GGUF model path for auto-spawn (trimmed, non-empty)
  embedServerExePath: string;             // llama-server executable path for auto-spawn (trimmed, non-empty)
  // Correction recency (correction-recency-injection D-9)
  correctionDetectionEnabled: boolean;    // Turn-end correction capture kill-switch (default true — D-7)
  correctionWindowDays: number;           // Base recency window in days (1-365, default 7)
  correctionMaxWindowDays: number;        // Widened window when < correctionMinItems rows fall in the base window (7-365, default 30)
  correctionMinItems: number;             // Min rows in base window before it widens (1-50, default 3)
  correctionMaxItems: number;             // Row cap for the RECENT CORRECTIONS section (1-50, default 5)
  correctionMarkerFormat: string;         // Marker sigil; trimmed, non-empty, exactly one ${timestamp} (default @@CORR ${timestamp}@@)
  // VCC brief transcript
  briefTranscriptCap: number;       // Max lines in Brief Transcript section (default: 120)
}

export const DEFAULT_CONFIG: SessionRecallConfig = {
  maxSessions: 10,
  maxTokens: 500,
  sessionScope: "all",
  ignorePatterns: [],
  lessonExcludePatterns: [],
  summarizeTimeoutMs: 600000, // 10 min — async merge competes with main agent
  longTermMaxChars: 5000,     // ~1250 tokens for long-term summary
  longTermMinIntervalMs: 14400000, // 4 hours between merges
  longTermMinTurns: 10,       // minimum merge_count sum before merging
  mergeChunkChars: 24000,        // ~6K tokens per chunk — ≪ 60K-token per-call budget
  mergeDrainIntervalMs: 1800000, // 30 minutes — paces backlog drain across session starts
  mergeMaxChunksPerRun: 8,       // bounds one run to ~12–30 min of LLM slot hold
  recencyHalfLifeSessions: 50,   // 50 sessions old -> weight 0.5
  stalePruneAfterSessions: 100,  // D5
  stalePruneMinScore: 3,         // D5: stale AND Score < 3
  longTermHardMaxChars: 20000,   // hard ceiling > 5K soft limit (longTermMaxChars unchanged, D5)
  useRowStore: false,                     // C1 deploy state — C4's one-time flip
  injectShortTerm: false,     // short-term injection off by default (user decision 2026-09-02)
  embedRetrievalThreshold: 0.5,           // cosine-similarity match threshold [0,1], no floor
  embedRetrievalTopK: 5,                  // candidate rows per signal [1,50]
  embedAutoConsolidateThreshold: 0.85,    // near-duplicate threshold [0,1], no floor
  rowStoreMaxSignalsPerRun: 20,           // per-run signal cap [1,50] — dormant after C3.5 (zero spec break)
  lessonExtractMaxPerRun: 4,              // per-run EXTRACT-call cap [1,50] (C3.5 — the 24K-chunk slots)
  embedServerPort: 5002,                  // local embed server [1024,65535]
  embedServerReadyTimeoutMs: 120000,      // spawn readiness bound [5000,600000] (146MB model load headroom)
  embedServerModelPath: "",             // empty publication default — set in session-recall.yaml (Tier 2; nomic-embed-text-v1.5 GGUF)
  embedServerExePath: "",               // empty publication default — set in session-recall.yaml (Tier 2; llama.cpp llama-server)
  correctionDetectionEnabled: true,       // capture ON by default (D-7) — the kill-switch
  correctionWindowDays: 7,                // base recency window [1,365]
  correctionMaxWindowDays: 30,            // widened window when < correctionMinItems fall in the base [7,365]
  correctionMinItems: 3,                  // min rows in base window before widening [1,50]
  correctionMaxItems: 5,                  // RECENT CORRECTIONS section row cap [1,50]
  correctionMarkerFormat: "@@CORR ${timestamp}@@", // marker sigil — exactly one ${timestamp} placeholder
  briefTranscriptCap: 120,    // max lines in Brief Transcript section
};

export const EXTENSION_DIR = join(homedir(), ".pi", "agent", "extensions", "session-recall");
export const CACHE_DIR = join(EXTENSION_DIR, "cache");

export function loadConfig(extensionDir: string): SessionRecallConfig {
  // Config lives in ~/.pi/agent/, not the extension directory
  const configPath = join(homedir(), ".pi", "agent", "session-recall.yaml");
  const examplePath = join(extensionDir, "config.example.yaml");
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try { raw = parseYaml(readFileSync(configPath, "utf-8")) || {}; }
    catch (err) { console.warn(`[session-recall] Failed to parse config.yaml: ${err}. Using defaults.`); }
  } else if (existsSync(examplePath)) {
    try {
      writeFileSync(configPath, readFileSync(examplePath, "utf-8"));
      console.info("[session-recall] Copied config.example.yaml to config.yaml");
    } catch (err) { console.warn(`[session-recall] Failed to copy config.example.yaml: ${err}. Using defaults.`); }
  }
  const config: SessionRecallConfig = { ...DEFAULT_CONFIG };
  if (typeof raw.maxSessions === "number") {
    config.maxSessions = Math.max(1, Math.min(50, Math.floor(raw.maxSessions)));
  }
  if (typeof raw.maxTokens === "number") {
    config.maxTokens = Math.max(100, Math.min(2000, Math.floor(raw.maxTokens)));
  }
  if (raw.sessionScope === "cwd" || raw.sessionScope === "all") {
    config.sessionScope = raw.sessionScope as "cwd" | "all";
  } else if (raw.sessionScope !== undefined) {
    console.warn(`[session-recall] Invalid sessionScope "${raw.sessionScope}". Using default (${DEFAULT_CONFIG.sessionScope}).`);
  }
  if (Array.isArray(raw.ignorePatterns)) {
    config.ignorePatterns = raw.ignorePatterns.filter((p) => typeof p === "string");
  }
  if (Array.isArray(raw.lessonExcludePatterns)) {
    config.lessonExcludePatterns = raw.lessonExcludePatterns.filter((p) => typeof p === "string");
  }
  if (typeof raw.summarizeTimeoutMs === "number") {
    config.summarizeTimeoutMs = Math.max(60000, Math.min(600000, Math.floor(raw.summarizeTimeoutMs)));
  }
  if (typeof raw.longTermMaxChars === "number") {
    config.longTermMaxChars = Math.max(2000, Math.min(10000, Math.floor(raw.longTermMaxChars)));
  }
  if (typeof raw.longTermMinIntervalMs === "number") {
    config.longTermMinIntervalMs = Math.max(300000, Math.min(604800000, Math.floor(raw.longTermMinIntervalMs))); // 5min–7days
  }
  if (typeof raw.longTermMinTurns === "number") {
    config.longTermMinTurns = Math.max(1, Math.min(1000, Math.floor(raw.longTermMinTurns)));
  }
  if (typeof raw.mergeChunkChars === "number") {
    config.mergeChunkChars = Math.max(2000, Math.min(60000, Math.floor(raw.mergeChunkChars)));
  }
  if (typeof raw.mergeDrainIntervalMs === "number") {
    config.mergeDrainIntervalMs = Math.max(60000, Math.min(604800000, Math.floor(raw.mergeDrainIntervalMs)));
  }
  if (typeof raw.mergeMaxChunksPerRun === "number") {
    config.mergeMaxChunksPerRun = Math.max(1, Math.min(50, Math.floor(raw.mergeMaxChunksPerRun)));
  }
  if (typeof raw.recencyHalfLifeSessions === "number") {
    config.recencyHalfLifeSessions = Math.max(1, Math.min(1000, Math.floor(raw.recencyHalfLifeSessions)));
  }
  if (typeof raw.stalePruneAfterSessions === "number") {
    config.stalePruneAfterSessions = Math.max(10, Math.min(1000, Math.floor(raw.stalePruneAfterSessions)));
  }
  if (typeof raw.stalePruneMinScore === "number") {
    config.stalePruneMinScore = Math.max(1, Math.min(100, Math.floor(raw.stalePruneMinScore)));
  }
  if (typeof raw.longTermHardMaxChars === "number") {
    config.longTermHardMaxChars = Math.max(config.longTermMaxChars, Math.min(20000, Math.floor(raw.longTermHardMaxChars)));
  }
  if (typeof raw.briefTranscriptCap === "number") {
    config.briefTranscriptCap = Math.max(10, Math.min(500, Math.floor(raw.briefTranscriptCap)));
  }
  // Row-store fields (rowstore-embeddings C1) — P5 pin: Number.isFinite on ALL SEVEN number fields
  // (settled ruling 2026-08-28); float clamps have NO Math.floor; int clamps floored; strings trimmed.
  if (typeof raw.useRowStore === "boolean") {
    config.useRowStore = raw.useRowStore;
  }

  if (typeof raw.injectShortTerm === "boolean") {
    config.injectShortTerm = raw.injectShortTerm;
  }
  if (typeof raw.embedRetrievalThreshold === "number" && Number.isFinite(raw.embedRetrievalThreshold)) {
    config.embedRetrievalThreshold = Math.max(0, Math.min(1, raw.embedRetrievalThreshold)); // first float clamp — no floor
  }
  if (typeof raw.embedRetrievalTopK === "number" && Number.isFinite(raw.embedRetrievalTopK)) {
    config.embedRetrievalTopK = Math.max(1, Math.min(50, Math.floor(raw.embedRetrievalTopK)));
  }
  if (typeof raw.embedAutoConsolidateThreshold === "number" && Number.isFinite(raw.embedAutoConsolidateThreshold)) {
    config.embedAutoConsolidateThreshold = Math.max(0, Math.min(1, raw.embedAutoConsolidateThreshold)); // no floor
  }
  if (typeof raw.rowStoreMaxSignalsPerRun === "number" && Number.isFinite(raw.rowStoreMaxSignalsPerRun)) {
    config.rowStoreMaxSignalsPerRun = Math.max(1, Math.min(50, Math.floor(raw.rowStoreMaxSignalsPerRun)));
  }
  if (typeof raw.lessonExtractMaxPerRun === "number" && Number.isFinite(raw.lessonExtractMaxPerRun)) {
    config.lessonExtractMaxPerRun = Math.max(1, Math.min(50, Math.floor(raw.lessonExtractMaxPerRun)));
  }
  if (typeof raw.embedServerPort === "number" && Number.isFinite(raw.embedServerPort)) {
    config.embedServerPort = Math.max(1024, Math.min(65535, Math.floor(raw.embedServerPort)));
  }
  if (typeof raw.embedServerReadyTimeoutMs === "number" && Number.isFinite(raw.embedServerReadyTimeoutMs)) {
    config.embedServerReadyTimeoutMs = Math.max(5000, Math.min(600000, Math.floor(raw.embedServerReadyTimeoutMs)));
  }
  if (typeof raw.embedServerModelPath === "string" && raw.embedServerModelPath.trim() !== "") {
    config.embedServerModelPath = raw.embedServerModelPath.trim();
  }
  if (typeof raw.embedServerExePath === "string" && raw.embedServerExePath.trim() !== "") {
    config.embedServerExePath = raw.embedServerExePath.trim();
  }

  // Correction-recency fields (correction-recency-injection D-9 / P6)
  if (typeof raw.correctionDetectionEnabled === "boolean") {
    config.correctionDetectionEnabled = raw.correctionDetectionEnabled;
  }

  if (typeof raw.correctionWindowDays === "number" && Number.isFinite(raw.correctionWindowDays)) {
    config.correctionWindowDays = Math.max(1, Math.min(365, Math.floor(raw.correctionWindowDays)));
  }
  if (typeof raw.correctionMaxWindowDays === "number" && Number.isFinite(raw.correctionMaxWindowDays)) {
    config.correctionMaxWindowDays = Math.max(7, Math.min(365, Math.floor(raw.correctionMaxWindowDays)));
  }
  if (typeof raw.correctionMinItems === "number" && Number.isFinite(raw.correctionMinItems)) {
    config.correctionMinItems = Math.max(1, Math.min(50, Math.floor(raw.correctionMinItems)));
  }
  if (typeof raw.correctionMaxItems === "number" && Number.isFinite(raw.correctionMaxItems)) {
    config.correctionMaxItems = Math.max(1, Math.min(50, Math.floor(raw.correctionMaxItems)));
  }
  if (typeof raw.correctionMarkerFormat === "string") {
    const markerFormat = raw.correctionMarkerFormat.trim();
    const placeholderCount = markerFormat.split("${timestamp}").length - 1;
    if (markerFormat !== "" && placeholderCount === 1) {
      config.correctionMarkerFormat = markerFormat;
    }
  }
  validateConfig(config);
  return config;
}

function validateConfig(config: SessionRecallConfig): void {
  if (config.sessionScope === "cwd") {
    console.warn("[session-recall] sessionScope=cwd may miss sessions from other projects. Consider using \"all\".");
  }
  if (config.maxSessions < 3) {
    console.warn(`[session-recall] maxSessions=${config.maxSessions} is low. Consider 5+ for better context.`);
  }
  if (config.maxSessions > 20) {
    console.warn(`[session-recall] maxSessions=${config.maxSessions} is high. This may slow down session start.`);
  }
  if (config.maxTokens < 200) {
    console.warn(`[session-recall] maxTokens=${config.maxTokens} is low. Context brief may be truncated.`);
  }
  if (config.summarizeTimeoutMs < 300000) {
    console.warn(`[session-recall] summarizeTimeoutMs=${config.summarizeTimeoutMs}ms is short for local models (merge prefill + 8K-token generation takes minutes). 300000+ recommended.`);
  }
}

let _cachedConfig: SessionRecallConfig | null = null;
let _cachedConfigDir: string | null = null;

export function loadConfigOnce(extensionDir: string): SessionRecallConfig {
  if (_cachedConfig && _cachedConfigDir === extensionDir) return _cachedConfig;
  _cachedConfig = loadConfig(extensionDir);
  _cachedConfigDir = extensionDir;
  return _cachedConfig;
}

export function resetConfigCache(): void {
  _cachedConfig = null;
  _cachedConfigDir = null;
}
