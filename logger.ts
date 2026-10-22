import { join, dirname } from "path";
import { readdirSync, statSync, unlinkSync, appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { gzipSync } from "zlib";
import { CACHE_DIR } from "./config.js";

// SESSION_RECALL_LOG_DIR relocates the log. The test harness points it at a scratch
// directory: a suite that exercises the extension's own startup would otherwise
// append to the operator's live log (found 2026-10-22 — full-suite runs were writing
// "Loaded OK" lines there). Production never sets this variable.
const LOG_DIR = process.env.SESSION_RECALL_LOG_DIR || join(CACHE_DIR, "..");
let _logDirInitialized = false;

// Log rotation policy
const ZIP_AFTER_DAYS = 3;
const DELETE_AFTER_DAYS = 7;

export function getLogPath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(LOG_DIR, `log-${date}.txt`);
}

export function rotateLogs(): void {
  try {
    if (!existsSync(LOG_DIR)) return;

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const files = readdirSync(LOG_DIR).filter(f => f.startsWith("log-") && (f.endsWith(".txt") || f.endsWith(".txt.gz")));

    for (const file of files) {
      const filePath = join(LOG_DIR, file);
      const stat = statSync(filePath);
      const ageDays = (now - stat.mtimeMs) / dayMs;

      if (ageDays > DELETE_AFTER_DAYS) {
        // Delete logs older than 7 days (both .txt and .gz)
        unlinkSync(filePath);
      } else if (ageDays > ZIP_AFTER_DAYS && file.endsWith(".txt")) {
        // Zip logs older than 3 days
        try {
          const content = readFileSync(filePath);
          const gzipped = gzipSync(content);
          writeFileSync(filePath + ".gz", gzipped);
          try {
            unlinkSync(filePath);
          } catch {
            // If delete fails (locked file), leave both .txt and .txt.gz — safe, will retry next rotation
          }
        } catch {
          // If zip fails, leave the file alone
        }
      }
    }
  } catch {
    // Non-fatal — don't break logging if rotation fails
  }
}

export function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const logPath = getLogPath();
  try {
    if (!_logDirInitialized) {
      mkdirSync(dirname(logPath), { recursive: true });
      _logDirInitialized = true;
    }
    appendFileSync(logPath, `[${ts}] ${msg}\n`);
    // rotateLogs() is called from session_start, not here (per-write rotation is too expensive)
  } catch {
    // Non-fatal — don't crash if log write fails
  }
}

// For health checks: list recent log entries
export function getRecentLogLines(count: number): string[] {
  const logPath = getLogPath();
  if (!existsSync(logPath)) return [];
  try {
    const content = readFileSync(logPath, "utf-8");
    return content.trim().split("\n").slice(-count);
  } catch {
    return [];
  }
}

