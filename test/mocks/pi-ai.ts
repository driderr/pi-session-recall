// Programmable recording mock for @earendil-works/pi-ai (design §4.1).
// Queuing a function gives tests per-call control (reject transiently, wait
// for the signal, read flags mid-run); an empty queue falls back to the
// default response — the legacy { content: [], stopReason: "stop" } unless
// mockCompleteSetDefault() was called. LIVE vehicles set a real-forwarding
// default so code under test reaches the real complete() PAST this alias
// (lt-conversion-live precedent; the rowstore-merge 8.1 first run proved the
// cost of forgetting: 149/149 signals failed `timeout` in ~0ms on the empty
// default, no real LLM contact).

import type { Api, Context, Model } from "@earendil-works/pi-ai";

export interface MockCompleteCall {
  model: Model<Api>; // real Model type: live vehicles hand this straight to the real complete()
  messages: Context["messages"];
  options: Record<string, unknown>; // includes signal, maxTokens, reasoningEffort
  promptText: string; // concatenated text parts of the last user message
  signalAbortedAtCall: boolean; // options.signal.aborted at call time
}

const calls: MockCompleteCall[] = [];
// Response queued for one complete() call: either a response object, or a
// per-call function that receives the recorded call. Declared as a real union
// on purpose -- the previous `unknown | ((call) => ...)` collapsed to `unknown`
// (anything unioned with unknown is unknown), so every test callback parameter
// was implicitly typed and the compiler could not check the call shape.
export type QueuedResponse =
  | { [key: string]: unknown }
  | null
  | ((call: MockCompleteCall) => unknown | Promise<unknown>);
const queue: QueuedResponse[] = [];
const LEGACY_DEFAULT: QueuedResponse = { content: [], stopReason: "stop" };
let defaultResponse: QueuedResponse = LEGACY_DEFAULT;

/** Clear calls + queue + default (call in beforeEach). */
export function mockCompleteReset(): void {
  calls.length = 0;
  queue.length = 0;
  defaultResponse = LEGACY_DEFAULT;
}

/** Persistent fallback for empty-queue calls (value or per-call function).
 *  Used by live vehicles to forward every call to the real SDK; unit tests
 *  leave it at the legacy default. Cleared by mockCompleteReset(). */
export function mockCompleteSetDefault(response: QueuedResponse): void {
  defaultResponse = response;
}

/** Queue the response for the next complete() call (value or per-call function). */
export function mockCompleteQueue(response: QueuedResponse): void {
  queue.push(response);
}

/** Recorded calls, in order. */
export function mockCompleteCalls(): readonly MockCompleteCall[] {
  return calls;
}

function extractPromptText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | undefined;
    if (m && m.role === "user" && Array.isArray(m.content)) {
      return (m.content as Array<{ type?: unknown; text?: unknown }>)
        .filter(p => p && p.type === "text" && typeof p.text === "string")
        .map(p => p.text as string)
        .join("");
    }
  }
  return "";
}

export async function complete(
  model: Model<Api>,
  { messages }: { messages: Context["messages"] },
  options: Record<string, unknown>,
): Promise<unknown> {
  const signal = options?.signal as { aborted?: boolean } | undefined;
  const call: MockCompleteCall = {
    model,
    messages,
    options,
    promptText: extractPromptText(messages),
    signalAbortedAtCall: Boolean(signal?.aborted),
  };
  calls.push(call);

  if (queue.length === 0) {
    const dflt = defaultResponse;
    return typeof dflt === "function" ? await dflt(call) : dflt; // settable default (legacy empty-stop when unset)
  }
  const next = queue.shift() as QueuedResponse;
  if (typeof next === "function") {
    return await next(call);
  }
  return next;
}

// No local Model/Message stand-ins: the mock records and forwards the real
// @earendil-works/pi-ai types, which is what the code under test actually passes
// and what the live vehicles hand back to the real complete().
