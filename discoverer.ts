import { statSync, existsSync } from "node:fs";
import { join, normalize, dirname } from "node:path";
import { homedir } from "node:os";
import type { SessionRecallConfig } from "./config.js";
import { openCacheDb } from "./summarizer.js";
import { log } from "./logger.js";
import type { Database as BetterSqliteDb } from "better-sqlite3";

export interface DiscoveredSession {
  path: string;
  cwd: string;
  timestamp: string;
  sizeBytes: number;
}

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
export const SQLITE_PATH = join(SESSIONS_DIR, "session-index.sqlite");

// R13: Recognise a child session by its storage shape:
// <parent-session-dir>/<child-run-id>/run-N/session.jsonl — what the pi-subagents build Pi
// actually loads (the pi-subagents fork, 0.82.1) really writes — and it is the only child
// shape a real session index contains. Discovery skips those paths, so a delegated run is
// not listed to the user. This sees the path only;
// the child's
// process role — which is what also keeps it out of long-term memory work — is
// captured in index.ts when the extension instance registers.
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

    // The child and missing-file filters below run AFTER a row window is taken, so one
    // fixed window lets the rows it discards crowd real sessions out of the budget: a
    // delegated run leaves one `run-N/session.jsonl` row per child behind, and those are
    // the newest rows by `updated_at`. Measured on a real session index at the default
    // maxSessions: filling the budget took two pages of rows, while the single fixed window
    // this replaces returned only half the sessions it was asked for. Scan forward
    // in fixed pages until the budget is filled or the table runs out, capped at ten windows.
    // The returned count still never exceeds `wanted`, which is what the single LIMIT used to
    // guarantee, and the same cap bounds the extra work: at most `wanted * 10` rows fetched
    // and stat'd per call. That ceiling scales with config, not with the table — at the
    // maxSessions clamp of 50 it is 1000 rows — and the synchronous worst case is cheap: 1000
    // statSync calls measured a few milliseconds, which is why no absolute row limit was
    // added on top of the cap. Each page re-sorts the table (nothing is indexed on
    // updated_at), so the ten-page worst case is ten sorts of it as well.
    const wanted = config.maxSessions * 2;
    const maxScanRows = wanted * 10;
    // The tie-breaker matters for paging: with equal `updated_at` values SQLite makes no
    // ordering promise across statements, so a row can land in two pages or in none.
    const stmt = db.prepare(
      `${query} ORDER BY updated_at DESC, session_path DESC LIMIT ? OFFSET ?`,
    );
    const results: DiscoveredSession[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let rowsScanned = 0; // rows actually fetched, which is what the SHORT line reports
    let scanStoppedBecause = "";
    let scanStoppedEarly = false;

    while (results.length < wanted && !scanStoppedEarly) {
      const rows = stmt.all(...params, wanted, offset) as Array<{
        session_path: string;
        updated_at: string;
      }>;
      rowsScanned += rows.length;
      if (rows.length < wanted) scanStoppedEarly = true; // the table is exhausted
      offset += wanted;
      // Exhaustion wins the reason. When the last page is partial AND the window position
      // reaches the cap in the same pass, the true statement is "there were no more rows",
      // not "I gave up" — a SHORT line there would tell an operator to raise a cap that was
      // never the limit. The cap therefore reports only while the table still had more to give.
      if (offset >= maxScanRows && !scanStoppedEarly) {
        // The cap, not the table, ended the scan: the list can come back short and nothing
        // else would say why. One greppable line for "my /recall went short during a heavy
        // delegated run".
        scanStoppedBecause = `scan cap of ${maxScanRows} rows reached`;
        scanStoppedEarly = true;
      }

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
            const decodedCwd = decodeCwdFromPath(path, sessionDir);

            seen.add(path);
            results.push({ path, cwd: decodedCwd, timestamp, sizeBytes: stat.size });
            if (results.length >= wanted) break;
          }
        } catch { /* File missing */ }
      }
    }

    // Filter out ignored sessions
    const kept =
      ignorePatterns.length > 0
        ? results.filter((s) => !matchesIgnorePatterns(s.path, ignorePatterns))
        : results;

    // The short-list test reads `kept`, not `results`: ignorePatterns is user config, so a scan
    // can fill its budget with rows the caller then filters away and still hand back a short
    // list. Calling that "not short" is the one thing this line exists to prevent.
    if (scanStoppedBecause && kept.length < wanted) {
      // Reports the rows actually FETCHED. Because exhaustion wins the reason above, the last
      // page is always full when this prints and the two numbers agree; counting the fetch
      // keeps the reported figure honest if that rule ever changes.
      log(`DISCOVERY SHORT scanned=${rowsScanned} wanted=${wanted} reason=${scanStoppedBecause}`);
    }

    return kept;
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
