// embeddings.ts — C1 (rowstore-embeddings): the extension's first raw HTTP client and
// first child_process.spawn. Design: openspec/changes/rowstore-embeddings/design.md §1–§4.
//
// Dependency direction (one-way): embeddings.ts → summarizer.ts (type seam §1.3).
// No pi-ai dependency (that is what keeps the gated live test alias-free, Q9).
//
// Discipline (design §2/§3): every failure path resolves to null / an UNAVAILABLE
// status — this module never throws out of its public API, and it never kills any
// process (detached-by-design, §4). The four LTROW-SRV byte forms are constructed
// ONLY here, via ltrowSrv() (single-emitter rule, §1.4 / P2).
import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { SessionRecallConfig } from "./config.js";
import { log } from "./logger.js";
import { loadModelConfig, type ModelConfig } from "./summarizer.js";

export type EmbedKind = "query" | "document";

export interface EmbeddingModelInfo {
  provider: string;
  modelId: string;
  name: string;
  api: string;
  baseUrl: string;
  apiKey: string;
  dimensions?: number;
}

export interface EmbedServerStatus {
  status: "ready" | "unavailable";
  source?: "probe" | "spawn";
  port: number;
  reason?: string;
  pid?: number;
}

export interface EmbedServerIo {
  spawn?: (exePath: string, args: string[]) => ChildProcess;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const EMBED_MODEL_ID = "nomic-embed-text-v1.5";
export const EMBED_CALL_WATCHDOG_MS = 20_000;
export const EMBED_PROBE_TIMEOUT_MS = 5_000;
export const EMBED_READY_POLL_MS = 1_000;

// P3 — Nomic prefixes; the trailing space IS part of the prefix (byte-pinned).
const QUERY_PREFIX = "search_query: ";
const DOCUMENT_PREFIX = "search_document: ";

type ProviderEntry = ModelConfig["providers"][string];
type ModelEntry = ProviderEntry["models"][number];

// ─── Single emitter of LTROW-SRV (P2 — design §1.4) ──────────────────────────

/** The four byte-pinned line shapes, constructed in exactly one place. */
function ltrowSrv(kind: "READY" | "SPAWNED" | "UNAVAILABLE", port: number, detail: string): string {
  if (kind === "SPAWNED") return `LTROW-SRV SPAWNED port=${port} pid=${detail}`;
  return `LTROW-SRV ${kind} port=${port} ${detail}`;
}

function unavailable(port: number, reason: string): EmbedServerStatus {
  log(ltrowSrv("UNAVAILABLE", port, `reason=${reason}`));
  return { status: "unavailable", reason, port };
}

// ─── Discovery (design §1.3 — call-fresh, no cache) ──────────────────────────

export function getEmbeddingModel(): EmbeddingModelInfo | null {
  const config = loadModelConfig();
  if (!config || typeof config.providers !== "object" || config.providers === null) return null;
  const matches: { providerName: string; provider: ProviderEntry; model: ModelEntry }[] = [];
  const refused: string[] = [];
  for (const [providerName, provider] of Object.entries(config.providers)) {
    if (!provider || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!model || model.embedding !== true) continue;
      if (provider.api !== "openai-embeddings") {
        refused.push(`${providerName}/${model.id}`);
      } else {
        matches.push({ providerName, provider, model });
      }
    }
  }
  if (matches.length === 0) {
    log(
      refused.length > 0
        ? `embed: embedding model refused (api is not openai-embeddings): ${refused.join(", ")}`
        : "embed: no embedding model found in models.json",
    );
    return null;
  }
  if (matches.length > 1) {
    log(`embed: multiple embedding models, using first: ${matches.map((m) => `${m.providerName}/${m.model.id}`).join(", ")}`);
  }
  const { providerName, provider, model } = matches[0];
  return {
    provider: providerName,
    modelId: model.id,
    name: model.name || model.id,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey || "none", // normalize missing → "none" (never send Bearer undefined)
    dimensions: typeof model.dimensions === "number" ? model.dimensions : undefined,
  };
}

// ─── Cosine similarity (pure arithmetic) ─────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Raw-fetch call discipline (design §2) ───────────────────────────────────

const authHeaders = (apiKey: string): Record<string, string> =>
  apiKey !== "none" ? { authorization: `Bearer ${apiKey}` } : {};

const isVector = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x));

const validLength = (v: number[], dimensions: number | undefined): boolean =>
  dimensions === undefined || v.length === dimensions;

export async function embedText(text: string, kind: EmbedKind): Promise<number[] | null> {
  const model = getEmbeddingModel();
  if (!model) return null; // discovery miss already logged by getEmbeddingModel (embed:)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_CALL_WATCHDOG_MS);
  try {
    const res = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(model.apiKey),
      },
      body: JSON.stringify({
        model: model.modelId,
        input: (kind === "query" ? QUERY_PREFIX : DOCUMENT_PREFIX) + text,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log(`embed: HTTP ${res.status} from ${model.baseUrl}/embeddings (${model.modelId})`);
      return null;
    }
    const json = (await res.json()) as { data?: { embedding?: unknown }[] };
    const vec = json?.data?.[0]?.embedding;
    if (!isVector(vec) || !validLength(vec, model.dimensions)) {
      log(`embed: malformed body or dimensions mismatch (expected ${model.dimensions ?? "any"}, got ${Array.isArray(vec) ? vec.length : "non-array"})`);
      return null;
    }
    return vec;
  } catch (err) {
    log(`embed: ${controller.signal.aborted ? `watchdog timeout after ${EMBED_CALL_WATCHDOG_MS}ms` : String(err)} (${model.modelId})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function embedBatch(texts: string[], kind: EmbedKind): Promise<number[][] | null> {
  const model = getEmbeddingModel();
  if (!model) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_CALL_WATCHDOG_MS);
  try {
    const res = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authHeaders(model.apiKey),
      },
      body: JSON.stringify({
        model: model.modelId,
        input: texts.map((t) => (kind === "query" ? QUERY_PREFIX : DOCUMENT_PREFIX) + t),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log(`embed: HTTP ${res.status} from ${model.baseUrl}/embeddings (${model.modelId})`);
      return null;
    }
    const json = (await res.json()) as { data?: { embedding?: unknown }[] };
    const rows = json?.data;
    const raw = Array.isArray(rows) ? rows.map((r) => r?.embedding) : [];
    // filter + type predicate: isVector is a guard, so every surviving
    // element is a validated vector — no cast needed at the return site.
    const vectors = raw.filter((v): v is number[] => isVector(v) && validLength(v, model.dimensions));
    if (
      !Array.isArray(rows) ||
      rows.length !== texts.length ||
      vectors.length !== raw.length
    ) {
      log(`embed: batch malformed or count mismatch (expected ${texts.length} vectors, got ${Array.isArray(rows) ? rows.length : "non-array"})`);
      return null;
    }
    return vectors;
  } catch (err) {
    log(`embed: ${controller.signal.aborted ? `watchdog timeout after ${EMBED_CALL_WATCHDOG_MS}ms` : String(err)} (${model.modelId})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Probe classification (design §3) ────────────────────────────────────────

type ProbeOutcome =
  | { kind: "ready" }              // HTTP 200 + nomic-embed-text-v1.5 in body
  | { kind: "wrong-model" }        // HTTP 200, model id absent
  | { kind: "http"; status: number } // non-200
  | { kind: "net"; code: string };   // network error or probe timeout

/**
 * GET http://127.0.0.1:<port>/v1/models — host literal, port ALWAYS from config
 * (two-instance rule: the main chat instance's port appears in no C1 code path).
 * Readiness = string
 * containment of the model id (no JSON parse — a malformed 200 body degrades to
 * wrong-model rather than an exception class).
 */
async function probeOnce(port: number): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: controller.signal });
    if (res.status !== 200) return { kind: "http", status: res.status };
    const body = await res.text();
    return body.includes(EMBED_MODEL_ID) ? { kind: "ready" } : { kind: "wrong-model" };
  } catch (err) {
    // undici throws TypeError: fetch failed with the socket error on err.cause.
    const code =
      typeof (err as { cause?: { code?: unknown } }).cause?.code === "string"
        ? (err as { cause: { code: string } }).cause.code
        : controller.signal.aborted
          ? "ABORT_ERR"
          : "UNKNOWN";
    return { kind: "net", code };
  } finally {
    clearTimeout(timer);
  }
}

/** Lightweight readiness probe (no spawn, no hint logging) — the fold's infra
 *  pre-check (mergeSignalsIntoRowStore): is the embed endpoint answering RIGHT
 *  NOW? "ready" = up; every other outcome (refused/wrong-model/http/net) = down. */
export async function probeEmbedServerUp(port: number): Promise<boolean> {
  const probe = await probeOnce(port);
  return probe.kind === "ready";
}
// ─── Lifecycle (design §3.2 + §4 — single emitter of LTROW-SRV) ──────────────

export async function ensureEmbedServer(config: SessionRecallConfig, io: EmbedServerIo = {}): Promise<EmbedServerStatus> {
  const port = config.embedServerPort;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = io.now ?? Date.now;

  const probe = await probeOnce(port);
  if (probe.kind === "ready") {
    log(ltrowSrv("READY", port, "source=probe"));
    return { status: "ready", source: "probe", port };
  }
  if (probe.kind === "wrong-model") return unavailable(port, "wrong-model");
  if (probe.kind === "http") return unavailable(port, `http-${probe.status}`);
  // ECONNREFUSED is the only probe outcome that leads to a spawn; every other
  // network code is terminal UNAVAILABLE (closed 7-token set, §3.2).
  if (probe.code !== "ECONNREFUSED") return unavailable(port, `net-${probe.code}`);

  try {
    // Pre-checks BEFORE any spawn — exe first, then model (spec scenario).
    // Empty default (publication 2026-10-15): hint the config key, then fail closed.
    if (!config.embedServerExePath.trim()) {
      log("embed: embedServerExePath is empty — set it in ~/.pi/agent/session-recall.yaml (llama.cpp llama-server path) to enable auto-spawn");
    }
    if (!existsSync(config.embedServerExePath.trim())) return unavailable(port, "exe-missing");
    if (!config.embedServerModelPath.trim()) {
      log("embed: embedServerModelPath is empty — set it in ~/.pi/agent/session-recall.yaml (nomic-embed-text-v1.5 GGUF path) to enable auto-spawn");
    }
    if (!existsSync(config.embedServerModelPath.trim())) return unavailable(port, "model-missing");

    // P4 — argv byte-identical to the validated command: -m <modelPath> FIRST,
    // --log-timestamps --log-prefix at the tail; port/model config-driven.
    const args = [
      "-m", config.embedServerModelPath,
      "--embedding", "--pooling", "mean", "-ngl", "99", "-c", "2048",
      "-b", "4096", "-ub", "4096", "-np", "1", "--load-mode", "mlock",
      "--host", "127.0.0.1",
      "--port", String(port),
      "--alias", EMBED_MODEL_ID,
      "--log-timestamps", "--log-prefix",
    ];
    const doSpawn = io.spawn ?? ((exePath: string, spawnArgs: string[]) =>
      cpSpawn(exePath, spawnArgs, {
        detached: true,    // new process group — the server outlives Pi
        stdio: "ignore",   // no pipes to hold; server logs to its own console/file
        windowsHide: true,
      }));
    const child = doSpawn(config.embedServerExePath, args);
    child.unref(); // Pi's event loop and exit do not wait on the server
    if (child.pid == null) {
      log("embed: spawn returned no pid (fail closed)");
      return unavailable(port, "spawn-failed");
    }
    log(ltrowSrv("SPAWNED", port, String(child.pid)));

    let spawnError: Error | null = null;
    let ready = false;
    const onError = (err: Error) => {
      if (ready) {
        // An error after READY is ignored — the process is already detached.
        log(`embed: detached embed-server error after ready: ${String(err)}`);
        return;
      }
      spawnError = err;
    };
    child.on("error", onError);

    // Readiness poll: 1s interval, deadline from now() + config. Non-ready poll
    // outcomes are NOT re-classified into tokens (the 146MB model load leaves the
    // port refused for many seconds — normal). Only the deadline → timeout.
    const deadline = now() + config.embedServerReadyTimeoutMs;
    for (;;) {
      await sleep(EMBED_READY_POLL_MS);
      if (spawnError) {
        log(`embed: spawn failed: ${String(spawnError)}`);
        return unavailable(port, "spawn-failed");
      }
      if (now() > deadline) {
        // No kill (detached server keeps running — orphan; manual kill is the
        // documented remedy, AGENTS.md §9; lifecycle cleanup is C5).
        log("embed: readiness poll exhausted (detached server left running — orphan)");
        return unavailable(port, "timeout");
      }
      const poll = await probeOnce(port);
      if (poll.kind === "ready") {
        ready = true;
        log(ltrowSrv("READY", port, "source=spawn"));
        return { status: "ready", source: "spawn", port, pid: child.pid };
      }
    }
  } catch (err) {
    log(`embed: spawn phase unexpected error: ${String(err)}`);
    return unavailable(port, "spawn-failed");
  }
}
