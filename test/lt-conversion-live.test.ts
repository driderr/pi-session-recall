// Task 0 dry-run spike (design §5.5, pin C) — live DB read-only + ONE real LLM call.
//
// Env-gated: the Task 0 dry run runs only with LT_LIVE_DRY=1; the Task 1 real
// conversion runs only with LT_LIVE=1 (default suite unaffected — both describes
// skip without their env vars).
//
// NO vi.mock("node:fs")/vi.mock("node:os") — real homedir → real models.json, real
// SQLITE_PATH (~/.pi/agent/sessions/session-index.sqlite), real LLM. The real
// complete() is reached by importing the real package PAST the vitest alias
// (../node_modules/@earendil-works/pi-ai/dist/index.js — entry per package.json) and
// is forwarded through the recording mock so mockCompleteCalls() still works.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { mockCompleteQueue, mockCompleteReset, mockCompleteCalls, complete as mockComplete } from "@earendil-works/pi-ai";
import * as realPiAi from "../node_modules/@earendil-works/pi-ai/dist/index.js";
import { getPrimaryModel, type ModelWithCompat, openCacheDb, sqliteReadLongTerm, runLtTableConversion, validateTableSummary, sqliteGetMeta, sqliteCountUnmergedSessions, LT_TABLE_CONVERSION_FLAG_KEY, LT_TABLE_CONVERSION_BACKUP_KEY } from "../summarizer.js";
import { loadConfigOnce } from "../config.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync } from "node:fs";
import { SQLITE_PATH } from "../discoverer.js";

// The 5 pinned sections (prompt order — design §2).
const PINNED_SECTIONS = ["Key Decisions", "Patterns & Conventions", "Configuration", "Lessons Learned", "Open Issues"];

// Repo root (this file lives in test/) — loadConfigOnce's extensionDir (the user
// config lives at ~/.pi/agent/session-recall.yaml; the extensionDir only serves the
// config.example.yaml bootstrap fallback).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Pre-S1 inline version of design §2.1's parseable predicate (parseScoreTables lands in T1).
// parseable === true iff ALL 5 pinned sections are present (line exactly `## <name>`)
// AND each is followed, before the next `## ` line, by a `| Item | Score |` table header.
function isTableSummaryInline(text: string): boolean {
  const lines = text.split("\n");
  let i = 0;
  for (const name of PINNED_SECTIONS) {
    while (i < lines.length && lines[i].replace(/\s+$/, "") !== `## ${name}`) i++;
    if (i >= lines.length) return false;
    i++;
    let hasTableHeader = false;
    while (i < lines.length && !lines[i].startsWith("## ")) {
      if (/^\|\s*Item\s*\|\s*Score\s*\|/.test(lines[i])) hasTableHeader = true;
      i++;
    }
    if (!hasTableHeader) return false;
  }
  return true;
}

// Inline copy of the design §6.2 conversion prompt (S0 predates the shipped builder —
// T4 verifies buildConversionPrompt's output matches char-for-char before Task 1).
function buildConversionPromptInline(existingSummary: string, currentSessionCount: number): string {
  return `Convert the following prose long-term summary into the five-section table format.

${existingSummary}

Rules:
1. Extract each item (bullet or line) as exactly one table row in the matching section.
2. Preserve each item's score: a "(score: N)" suffix means Score N; a legacy "(N:x)" suffix means Score N; an item with no score suffix gets Score 1.
3. Set Last-Seen to ${currentSessionCount} for every row.
4. Keep item text as-is except removing the score suffix. Do not add, merge, or drop items.
5. Output full tables for all five sections — Key Decisions, Patterns & Conventions, Configuration, Lessons Learned, Open Issues — each with the header row | Item | Score | Last-Seen | followed by the |------|-------|-----------| separator. A section with no rows keeps the placeholder row | (none) | | |.

Output only the converted summary.`;
}

describe.runIf(process.env.LT_LIVE_DRY === "1")("Task 0 dry-run spike (design §5.5, pin C)", () => {
  it("measures converted table size against the live DB (read-only) with one real LLM call", { timeout: 600_000 }, async () => {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");

    // Read-only handle — no schema/pragma side effects on the live WAL DB.
    const db = new Database(SQLITE_PATH, { readonly: true });
    try {
      const row = db.prepare(
        "SELECT timestamp, summary, char_count, session_count FROM long_term WHERE id = 1",
      ).get() as { timestamp: string; summary: string; char_count: number; session_count: number } | undefined;
      expect(row, "live long_term row must exist").toBeTruthy();
      const summary = row!.summary;
      const sessionCount = row!.session_count;

      // Preconditions (design §5.5 dry run): flag absent + summary non-table.
      const flag = db.prepare("SELECT value FROM meta WHERE key = 'lt_table_conversion_complete'").get();
      expect(flag, "lt_table_conversion_complete must be absent before Task 1").toBeUndefined();
      expect(isTableSummaryInline(summary), "stored summary must be non-table (prose)").toBe(false);

      // One real LLM call — real complete() past the alias, forwarded through the recording mock.
      const modelInfo = getPrimaryModel();
      expect(modelInfo, "primary model must be configured (models.json)").toBeTruthy();
      const modelObj: ModelWithCompat = {
        provider: modelInfo!.provider,
        id: modelInfo!.modelId,
        name: modelInfo!.name,
        api: modelInfo!.api,
        baseUrl: modelInfo!.baseUrl,
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
        input: modelInfo!.input,
        maxTokens: modelInfo!.maxTokens,
        contextWindow: modelInfo!.contextWindow,
        cost: modelInfo!.cost,
      };

      const prompt = buildConversionPromptInline(summary, sessionCount);
      mockCompleteQueue(async (call) => realPiAi.complete(call.model, { messages: call.messages }, call.options as never));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 600_000);
      let response: any;
      try {
        response = await mockComplete(
          modelObj,
          { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
          {
            apiKey: modelInfo!.apiKey && modelInfo!.apiKey !== "none" ? modelInfo!.apiKey : "sk-none",
            signal: controller.signal,
            reasoningEffort: "low",
          },
        );
      } finally {
        clearTimeout(timer);
      }
      expect(mockCompleteCalls()).toHaveLength(1);

      const text = (Array.isArray(response?.content)
        ? (response.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c && c.type === "text")
            .map((c) => c.text ?? "")
            .join("\n")
            .trim()
        : "");
      const stopReason = response?.stopReason as string | undefined;
      expect(stopReason, `real LLM call should complete (stopReason=${stopReason})`).toBe("stop");
      expect(text, "LLM returned no text").not.toBe("");

      // Pre-S1 inline version of validateTableSummary: 5 section headers + table headers + 8K ceiling.
      const sectionHeadersOk = PINNED_SECTIONS.every((name) =>
        text.split("\n").some((l) => l.replace(/\s+$/, "") === `## ${name}`),
      );
      const tableHeadersOk = isTableSummaryInline(text); // all-5 predicate incl. per-section table header
      const hardCeilingOk = text.length <= 8000;

      console.log(
        [
          "## Task 0 verdict",
          `- live long_term: timestamp=${row!.timestamp}, char_count=${row!.char_count}, session_count=${sessionCount}`,
          `- preconditions: flag absent=${flag === undefined}, summary non-table=${!isTableSummaryInline(summary)}`,
          `- converted output: ${text.length} chars (longTermMaxChars soft limit 5000, hard ceiling 8000)`,
          `- converted vs 5K: ${text.length <= 5000 ? "under" : "OVER"} the 5K soft limit`,
          `- 5 section headers present: ${sectionHeadersOk}`,
          `- 5-section table format (incl. | Item | Score | headers): ${tableHeadersOk}`,
          `- 8K ceiling: ${hardCeilingOk ? "PASS" : "FAIL"}`,
          `- live session_count: ${sessionCount} (SQLite-primary regime: monotonic non-decreasing, derived from merged-session hash set; stale hash-fallback file is 106 sessions as of 2026-06-01 — the pin P5 max(0, current−lastSeen) clamp absorbs that regression direction)`,
          `- no writes: ${"pending post-check"}`,
        ].join("\n"),
      );

      expect(sectionHeadersOk, "converted output must contain all 5 pinned section headers").toBe(true);
      expect(tableHeadersOk, "converted output must have a | Item | Score | table header under each pinned section").toBe(true);
      expect(hardCeilingOk, `converted output ${text.length} chars exceeds the 8K ceiling`).toBe(true);

      // Assert no writes happened (read-only handle): flag still absent, summary byte-identical.
      const flagAfter = db.prepare("SELECT value FROM meta WHERE key = 'lt_table_conversion_complete'").get();
      const rowAfter = db
        .prepare("SELECT summary, char_count, session_count FROM long_term WHERE id = 1")
        .get() as { summary: string; char_count: number; session_count: number };
      expect(flagAfter, "flag must still be absent after the dry run").toBeUndefined();
      expect(rowAfter.summary).toBe(summary);
      expect(rowAfter.char_count).toBe(row!.char_count);
      expect(rowAfter.session_count).toBe(sessionCount);

      console.log("## Task 0 verdict — no writes confirmed: flag absent, summary byte-identical");
      console.log("## Task 0 — converted output (verbatim):\n" + text);
    } finally {
      db.close();
    }
  });
});

// ─── Task 1 real conversion (design §5.5 steps 1–5, pin C) ────────────────────────────
// Runs AFTER the full `npx vitest run` is green and `npm run sync` has deployed (tasks
// S4 order). Production runner end-to-end (openCacheDb → runLtTableConversion →
// productionConversionLlmCall → the real complete() past the alias) with an explicit
// file-level DB backup and verification. Leaves the live DB correct: converted tables
// + flag + backup; unmerged backlog untouched. Pi-restart idempotency (flag-set skip,
// backup-clear on the first successful fold) is the parent's post-review live check.
describe.runIf(process.env.LT_LIVE === "1")("Task 1 real conversion (design §5.5, pin C)", () => {
  it("backs up the live DB, converts prose to tables via runLtTableConversion, verifies flag/backup/state", { timeout: 600_000 }, async () => {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    mockCompleteReset();

    // ── Step 1: preconditions + pre-reads (read-only handle — no schema/pragma side effects)
    const pre = new Database(SQLITE_PATH, { readonly: true });
    const oldRow = pre
      .prepare(
        "SELECT timestamp, summary, char_count, session_count, merged_sessions FROM long_term WHERE id = 1",
      )
      .get() as { timestamp: string; summary: string; char_count: number; session_count: number; merged_sessions: string } | undefined;
    const flagBefore = pre
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(LT_TABLE_CONVERSION_FLAG_KEY) as { value: string } | undefined;
    const preUnmerged = sqliteCountUnmergedSessions(pre);
    pre.close();
    expect(oldRow, "live long_term row must exist").toBeTruthy();
    expect(flagBefore, "lt_table_conversion_complete must be absent before Task 1").toBeUndefined();
    expect(isTableSummaryInline(oldRow!.summary), "stored summary must be non-table (prose)").toBe(false);

    // ── Step 2: WAL checkpoint (TRUNCATE) on a short-lived read-write handle, then file backup
    const ckptDb = new Database(SQLITE_PATH);
    const checkpoint = (ckptDb.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>)[0];
    ckptDb.close();
    expect(checkpoint.busy, "checkpoint busy — another connection may hold the WAL (Pi session active?)").toBe(0);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bakPath = `${SQLITE_PATH}.bak-${stamp}`;
    copyFileSync(SQLITE_PATH, bakPath);
    const walBakPath = existsSync(`${SQLITE_PATH}-wal`) ? `${bakPath}-wal` : null;
    if (walBakPath) copyFileSync(`${SQLITE_PATH}-wal`, walBakPath);
    const shmBakPath = existsSync(`${SQLITE_PATH}-shm`) ? `${bakPath}-shm` : null;
    if (shmBakPath) copyFileSync(`${SQLITE_PATH}-shm`, shmBakPath);

    // ── Step 3: production path — openCacheDb (read-write) + the real runner (real LLM past the alias)
    const db = await openCacheDb();
    expect(db, "openCacheDb must return the live DB handle").toBeTruthy();
    const longTerm = sqliteReadLongTerm(db!);
    expect(longTerm, "long_term must be present for conversion").toBeTruthy();
    expect(longTerm!.summary, "runner input must match the pre-read summary").toBe(oldRow!.summary);
    const config = loadConfigOnce(REPO_ROOT);

    mockCompleteQueue(async (call) => realPiAi.complete(call.model, { messages: call.messages }, call.options as never));
    const outcome = await runLtTableConversion(db!, longTerm, config);
    expect(outcome.ran, `conversion must run (skippedReason=${outcome.skippedReason})`).toBe(true);
    expect(outcome.converted, "conversion must produce converted tables").not.toBeNull();
    expect(outcome.skippedReason, "successful conversion must not carry a skip reason").toBeNull();
    const llmCalls = mockCompleteCalls().length;
    // productionConversionLlmCall is single-attempt (transient error = conversion failure);
    // convertProseToTables allows one in-loop validation retry → at most 2 LLM calls.
    expect(llmCalls).toBeGreaterThanOrEqual(1);
    expect(llmCalls).toBeLessThanOrEqual(2);

    // ── Step 4: verify backup + flag + state (design §5.5 step 4)
    const flagValue = sqliteGetMeta(db!, LT_TABLE_CONVERSION_FLAG_KEY);
    expect(flagValue, "flag must be set after success").not.toBeNull();
    const backupMeta = sqliteGetMeta(db!, LT_TABLE_CONVERSION_BACKUP_KEY);
    expect(backupMeta, "backup meta must equal the old prose byte-for-byte").toBe(oldRow!.summary);
    const afterRow = db!
      .prepare("SELECT summary, char_count, session_count, merged_sessions FROM long_term WHERE id = 1")
      .get() as { summary: string; char_count: number; session_count: number; merged_sessions: string };
    expect(afterRow.summary, "stored summary must equal the converted tables").toBe(outcome.converted!);
    const validation = validateTableSummary(afterRow.summary, config);
    expect(validation.ok, `stored tables must pass validateTableSummary (${validation.reason ?? "?"})`).toBe(true);
    expect(afterRow.session_count, "session_count must be unchanged (conversion is not a merge)").toBe(oldRow!.session_count);
    expect(afterRow.merged_sessions, "merged_sessions must be re-persisted byte-identical").toBe(oldRow!.merged_sessions);
    const afterUnmerged = sqliteCountUnmergedSessions(db!);
    expect(afterUnmerged, "unmerged backlog must be untouched by conversion").toBe(preUnmerged);

    console.log(
      [
        "## Task 1 verification",
        `- preconditions: flag absent=${flagBefore === undefined}, summary non-table=${!isTableSummaryInline(oldRow!.summary)}, checkpoint busy=${checkpoint.busy}`,
        `- DB backup: ${bakPath}${walBakPath ? ` (+ ${walBakPath})` : ""}${shmBakPath ? ` (+ ${shmBakPath})` : ""}`,
        `- old summary: ${oldRow!.char_count} chars, session_count=${oldRow!.session_count}, timestamp=${oldRow!.timestamp}`,
        `- outcome: ran=${outcome.ran}, converted=${outcome.converted!.length} chars, llmCalls=${llmCalls}, skippedReason=${outcome.skippedReason}`,
        `- flag set: ${flagValue}`,
        `- backup meta byte-identical to old prose: ${backupMeta === oldRow!.summary}`,
        `- stored summary === outcome.converted: ${afterRow.summary === outcome.converted}`,
        `- validateTableSummary(stored).ok: ${validation.ok} (hard ceiling ${config.longTermHardMaxChars})`,
        `- session_count unchanged: ${afterRow.session_count === oldRow!.session_count} (${oldRow!.session_count})`,
        `- merged_sessions byte-identical: ${afterRow.merged_sessions === oldRow!.merged_sessions}`,
        `- unmerged sessions before/after: ${preUnmerged}/${afterUnmerged} (untouched)`,
        "- live DB left correct: converted tables + flag + backup in place; Pi-restart idempotency (flag-set skip, backup-clear on first successful fold) = parent post-review live check",
      ].join("\n"),
    );
  });
});
