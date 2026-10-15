// Programmable recording mock for @earendil-works/pi-ai (design §4.1).
// Queuing a function gives tests per-call control (reject transiently, wait
// for the signal, read flags mid-run); an empty queue falls back to the
// default response — the legacy { content: [], stopReason: "stop" } unless
// mockCompleteSetDefault() was called. LIVE vehicles set a real-forwarding
// default so code under test reaches the real complete() PAST this alias
// (lt-conversion-live precedent; the rowstore-merge 8.1 first run proved the
// cost of forgetting: 149/149 signals failed `timeout` in ~0ms on the empty
// default, no real LLM contact).

export interface MockCompleteCall {
  model: unknown;
  messages: unknown[];
  options: Record<string, unknown>; // includes signal, maxTokens, reasoningEffort
  promptText: string; // concatenated text parts of the last user message
  signalAbortedAtCall: boolean; // options.signal.aborted at call time
}

const calls: MockCompleteCall[] = [];
type QueuedResponse = unknown | ((call: MockCompleteCall) => unknown | Promise<unknown>);
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
  model: unknown,
  { messages }: { messages: unknown[] },
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

export interface Message {
  role: string;
  content: unknown;
  timestamp?: number;
}

export interface Model<T = any> {
  provider: string;
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  maxTokens?: number;
  contextWindow?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat?: T;
}
