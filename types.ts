// Global state flags for cross-module communication across Pi module reloads.
// These survive reloads because they live on globalThis, not module scope.

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
  __sessionRecallContextInjected__: boolean;
  __sessionRecallContextSessionId__: string | undefined;
  __sessionRecallMergeInProgress__: boolean;
  // correction-recency-injection D-5/F8: per-session-file evaluated-turn counter
  // for the one-save-per-3-turns capture rate limit (survives module reloads).
  __sessionRecallCorrectionRateLimit__: Record<string, number>;
}

// Typed accessor to avoid `globalThis as any` everywhere.
// Usage: G.__sessionRecallLlmBusy__ = true;
export const G = globalThis as unknown as SessionRecallGlobals;
