// Global state flags for cross-module communication across Pi module reloads.
// These survive reloads because they live on globalThis, not module scope.
import type { Database as BetterSqliteDb } from "better-sqlite3";

export interface LlmStats {
  calls: number;
  successes: number;
  failures: number;
  lastLatencyMs: number;
  lastResult: string;
}

export interface SessionRecallGlobals {
  __sessionRecallLoaded__: boolean;
  __sessionRecallLastShutdownResult__: string;
  __sessionRecallLlmStats__: LlmStats;
  __sessionRecallLlmBusy__: boolean;
  __sessionRecallVccMerge__: Record<string, boolean>;
  // One entry per session file that already received its memory block
  // (before_agent_start). Kept on globalThis so it survives /reload, never cleared at
  // shutdown; index.ts bounds it at 500 entries, dropping the oldest inserted first.
  __sessionRecallContextInjectedSessions__: Set<string> | undefined;
  // The single SQLite connection this process opens for the session index
  // (summarizer.openCacheDb). It lives here so every module load in one process reuses
  // it instead of opening another connection to the same database file.
  __sessionRecallCacheDb__: BetterSqliteDb | undefined;
  // Failed open attempts for that connection: openCacheDb stops trying after 3 until
  // closeCacheDb clears it. Shared for the same reason as the connection itself.
  __sessionRecallCacheDbFailCount__: number | undefined;
  // The one open attempt in flight, shared so concurrent callers wait for it instead of
  // each opening a connection of their own (summarizer.openCacheDb). Cleared when the
  // attempt settles, whether it succeeded or failed.
  __sessionRecallCacheDbOpening__: Promise<BetterSqliteDb | null> | undefined;
  __sessionRecallMergeInProgress__: boolean;
  // correction-recency-injection D-5/F8: per-session-file evaluated-turn counter
  // for the one-save-per-3-turns capture rate limit (survives module reloads).
  __sessionRecallCorrectionRateLimit__: Record<string, number>;
}

// Typed accessor to avoid `globalThis as any` everywhere.
// Usage: G.__sessionRecallLlmBusy__ = true;
export const G = globalThis as unknown as SessionRecallGlobals;
