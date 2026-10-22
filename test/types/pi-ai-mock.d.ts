// Test-only type surface of the @earendil-works/pi-ai alias.
//
// vitest.config.ts resolves "@earendil-works/pi-ai" to test/mocks/pi-ai.ts at
// RUNTIME. The compiler cannot see that alias, so a test that imports a mock
// helper through the aliased name would be checked against the published
// package and reported as "has no exported member".
//
// This file merges the mock's test-control helpers into that module's types so
// the aliased imports type-check honestly. It is included only by
// tsconfig.test.json, so production code never sees these names. The mock's own
// QueuedResponse type is imported, which is also what gives a queued callback
// its parameter type.
//
// Signatures mirror test/mocks/pi-ai.ts and import its QueuedResponse type
// rather than restating it, so this file cannot drift ahead of the mock.

import type { MockCompleteCall, QueuedResponse } from "../mocks/pi-ai";

declare module "@earendil-works/pi-ai" {
  /** Clear recorded calls, the queued responses, and the default response. */
  export function mockCompleteReset(): void;

  /** Set the persistent fallback used when the queue is empty. */
  export function mockCompleteSetDefault(response: QueuedResponse): void;

  /** Queue the response for the next complete() call. */
  export function mockCompleteQueue(response: QueuedResponse): void;

  /** Recorded complete() calls, in order. */
  export function mockCompleteCalls(): readonly MockCompleteCall[];
}
