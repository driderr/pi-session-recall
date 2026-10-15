import { statSync, existsSync } from "node:fs";
import { join, normalize, dirname } from "node:path";
import { homedir } from "node:os";
import type { SessionRecallConfig } from "./config.js";
import { openCacheDb } from "./summarizer.js";
import type { Database as BetterSqliteDb } from "better-sqlite3";

export interface DiscoveredSession {
  path: string;
  cwd: string;
  timestamp: string;
  sizeBytes: number;
}

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
export const SQLITE_PATH = join(SESSIONS_DIR, "session-index.sqlite");

// R14: Detect subagent sessions. Subagent sessions live at
// <parent-session>/<hash>/run-N/session.jsonl. Skip them during discovery;
// the parent session already captures the relevant context.
export function isSubagentSession(path: string): boolean {
  return /\/run-\d+\/session\.jsonl/.test(path.replace(/\\/g, "/"));
}

// Match a path against glob-like ignore patterns.
// Cache compiled regexes with a size cap to prevent unbounded memory growth.
const _ignoreRegexCache = new Map<string, RegExp>();
const MAX_IGNORE_CACHE_SIZE = 100;
export function matchesIgnorePatterns(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  for (const pattern of patterns) {
    let regex = _ignoreRegexCache.get(pattern);
    if (!regex) {
      const source = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "___DOUBLE_STAR___")
        .replace(/\*/g, "[^/]*")
        .replace(/___DOUBLE_STAR___/g, ".*");
      regex = new RegExp(source);
      // Evict oldest entry if cache is full
      if (_ignoreRegexCache.size >= MAX_IGNORE_CACHE_SIZE) {
        const firstKey = _ignoreRegexCache.keys().next().value;
        if (firstKey) _ignoreRegexCache.delete(firstKey);
      }
      _ignoreRegexCache.set(pattern, regex);
    }
    if (regex.test(normalized)) return true;
  }
  return false;
}

async function querySqlite(config: SessionRecallConfig, cwd?: string, ignorePatterns: string[] = []): Promise<DiscoveredSession[]> {
  // Use the shared DB singleton from summarizer.ts to avoid concurrent
  // connections to the same SQLite file (which causes SQLITE_BUSY errors).
  const db = await openCacheDb();
  if (!db) {
    console.warn("[session-recall] SQLite unavailable for discovery");
    return [];
  }

  try {
    // Primary source: session_summaries (session-recall's own table, always up-to-date).
    // The Pi-managed `sessions` table is unreliable — Pi's session manager may not
    // populate it consistently, causing /recall to show stale sessions with 0 metadata.
    let query = "SELECT session_path, updated_at FROM session_summaries";
    const params: string[] = [];

    if (cwd) {
      query += " WHERE session_path LIKE ?";
      params.push(`${cwd}%`);
    }

    query += " ORDER BY updated_at DESC LIMIT ?";
    params.push(String(config.maxSessions * 2));

    const rows = db.prepare(query).all(...params) as Array<{ session_path: string; updated_at: string }>;
    const results: DiscoveredSession[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const path = row.session_path;
      // Dedup: same session_path can appear multiple times
      if (seen.has(path)) continue;

      try {
        if (isSubagentSession(path)) continue;
        const stat = statSync(path);
        if (stat.isFile()) {
          // Derive timestamp from filename (e.g. 2026-06-13T09-30-54-900Z_...)
          const timestamp = extractTimestampFromPath(path);
          // Derive cwd from parent directory
          const sessionDir = dirname(path);
          const cwd = decodeCwdFromPath(path, sessionDir);

          seen.add(path);
          results.push({ path, cwd, timestamp, sizeBytes: stat.size });
        }
      } catch { /* File missing */ }
    }

    // Filter out ignored sessions
    if (ignorePatterns.length > 0) {
      return results.filter(s => !matchesIgnorePatterns(s.path, ignorePatterns));
    }
    return results;
  } catch (err) {
    console.warn(`[session-recall] SQLite discovery failed: ${err}`);
    return [];
  }
}

// Extract ISO timestamp from session filename.
// Handles formats: 2026-06-13T09-30-54-900Z_... or 2026-06-13T09-30-54.900Z_...
function extractTimestampFromPath(path: string): string {
  const basename = path.split(/[\\/]/).pop() || path;
  const match = basename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[-.]\d{3}Z?)/);
  if (match) {
    // Normalize: 2026-06-13T09-30-54-900Z -> 2026-06-13T09:30:54.900Z
    return match[1].replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})([-.])(\d{3})(Z?)$/, "$1T$2:$3:$4.$6$7");
  }
  return new Date().toISOString();
}

// Decode cwd from session path.
// Pi encodes paths like: ~/.pi/agent/sessions/--C--Users-<You>-Documents-VSCodeProjects-<proj>--/file.jsonl
// We extract the cwd portion between the encoded markers.
function decodeCwdFromPath(sessionPath: string, sessionDir: string): string {
  const sessionsDir = join(homedir(), ".pi", "agent", "sessions");
  const relative = sessionPath.replace(sessionsDir, "").replace(/^[\\/]/, "");
  const parts = relative.split(/[\\/]/);

  if (parts.length >= 2) {
    const encoded = parts[0];
    // Decode: --C--Users-<You>-Documents-...-- -> C:\Users\<You>\Documents\...
    let decoded = encoded.replace(/^-+/, "").replace(/-+$/, "");
    decoded = decoded.replace(/--/g, "\\").replace(/-/g, "/");
    decoded = decoded.replace(/\/\//g, "/");
    return decoded;
  }

  return sessionDir;
}

export async function discoverSessions(config: SessionRecallConfig, cwd: string): Promise<DiscoveredSession[]> {
  return querySqlite(config, config.sessionScope === "cwd" ? cwd : undefined, config.ignorePatterns);
}
