/**
 * Orchestrate all VCC extractors to produce structured sections.
 * Ported from pi-vcc, adapted for session-recall per-turn use.
 */

import type { NormalizedBlock } from "./normalize.js";
import { clip, clipSentence, firstLine, nonEmptyLines } from "./content.js";
import { extractGoals } from "./extract/goals.js";
import { extractFiles } from "./extract/files.js";
import { extractCommits, formatCommits } from "./extract/commits.js";
import { extractReferences, formatReferences } from "./extract/references.js";
import { extractSignals, formatSignals } from "./extract/signals.js";
import { extractPreferences, dedupPreferencesAgainstGoals } from "./extract/preferences.js";
import { buildBriefSections, stringifyBrief } from "./brief.js";

export interface VccSections {
  goals: string[];
  files: string[];
  commits: string[];
  references: string[];
  signals: string[];
  outstandingContext: string[];
  preferences: string[];
  briefTranscript: string;
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

function extractOutstandingContext(blocks: NormalizedBlock[]): string[] {
  const items: string[] = [];
  const tail = blocks.slice(-20);

  for (const b of tail) {
    if (b.kind === "tool_result" && b.isError) {
      items.push(`[${b.name}] ${firstLine(b.text ?? "", 150)}`);
      continue;
    }

    if (b.kind === "assistant" || b.kind === "user") {
      for (const line of nonEmptyLines(b.text ?? "")) {
        if (!BLOCKER_RE.test(line)) continue;
        if (line.length < 15) continue;
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
        const clipped = b.kind === "user" ? `[user] ${clipSentence(line, 150)}` : clipSentence(line, 150);
        if (!items.includes(clipped)) items.push(clipped);
        break;
      }
    }
  }

  return items.slice(0, 5);
}

function formatFileActivity(blocks: NormalizedBlock[]): string[] {
  const act = extractFiles(blocks);
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };
  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
  return lines;
}

export function buildSections(
  blocks: NormalizedBlock[],
  config: { briefTranscriptCap?: number } = {},
): VccSections {
  const briefSections = buildBriefSections(blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(
    extractPreferences(blocks),
    sessionGoal,
  );

  return {
    goals: sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    files: formatFileActivity(blocks),
    commits: formatCommits(extractCommits(blocks)),
    references: formatReferences(extractReferences(blocks)),
    signals: formatSignals(extractSignals(blocks)),
    preferences: userPreferences,
    briefTranscript: stringifyBrief(briefSections),
  };
}
