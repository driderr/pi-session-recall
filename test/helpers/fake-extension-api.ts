// Shared partial ExtensionAPI for the registration tests.
//
// ExtensionAPI declares about thirty members; at runtime an extension receives
// pi's real object. The registration tests exercise three of them — on,
// registerTool, registerCommand — so every other member is an inert no-op
// function: a test that reaches for one gets a callable stub instead of a
// TypeError. The Proxy plus the cast below is the single place the test tree
// admits an unchecked ExtensionAPI value, and it exists only to pass a partial
// fake where the real API is declared.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Handlers an extension registered, keyed by event name. */
export type CapturedHandlers = Record<string, (...args: any[]) => any>;

/**
 * Pass this to an extension's exported factory function to capture what it
 * registers. `captured` fills as the factory calls on(); `counters` records
 * tool/command registration for tests that assert on registration counts.
 */
export function fakeApi(
  captured: CapturedHandlers,
  counters?: { tool?: () => void; command?: () => void },
): ExtensionAPI {
  const impl = {
    // pi's on() returns an unsubscribe function, so the fake returns one too —
    // a factory that keeps the disposer is not handed undefined.
    on: (name: string, cb: (...args: any[]) => any) => {
      captured[name] = cb;
      return () => {};
    },
    registerTool: () => { counters?.tool?.(); },
    registerCommand: () => { counters?.command?.(); },
  };
  return new Proxy(impl, {
    get: (target, prop) =>
      prop in target
        ? (target as Record<string, unknown>)[prop as string]
        : () => {},
  }) as unknown as ExtensionAPI;
}
