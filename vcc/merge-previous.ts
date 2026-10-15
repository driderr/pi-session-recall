/**
 * Merge a fresh VCC summary into an existing merged summary.
 * Ported from pi-vcc summarize.ts, adapted for per-turn accumulation.
 */

import type { VccSections } from "./build-sections.js";
import { capBrief } from "./format.js";

const HEADER_NAMES = [
  "Session Goal", "Files And Changes", "Commits", "References",
  "Key Signals", "Outstanding Context", "User Preferences",
];

const SEPARATOR = "\n\n---\n\n";

/** Extract a named section from summary text. */
function sectionOf(text: string, header: string): string {
  const tag = `[${header}]`;
  const start = text.indexOf(tag);
  if (start < 0) return "";
  const after = text.slice(start);
  const nextSection = HEADER_NAMES
    .filter((h) => h !== header)
    .map((h) => after.indexOf(`[${h}]`))
    .filter((n) => n > 0);
  const nextSep = after.indexOf("\n\n---\n\n");
  const candidates = [...nextSection, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
  const end = candidates[0];
  return (end ? after.slice(0, end) : after).trim();
}

/** Extract the brief transcript part (everything after ---). */
function briefOf(text: string): string {
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return "";
  return text.slice(idx + SEPARATOR.length).trim();
}

/** Merge Files And Changes by category, dedup paths. */
function mergeFileLines(prev: string, fresh: string): string {
  const categories = ["Modified", "Created", "Read"] as const;
  const merged: Record<string, Set<string>> = {};
  for (const cat of categories) merged[cat] = new Set();

  for (const text of [prev, fresh]) {
    for (const line of text.split("\n")) {
      for (const cat of categories) {
        const prefix = `- ${cat}: `;
        if (!line.startsWith(prefix)) continue;
        let rest = line.slice(prefix.length);
        rest = rest.replace(/\s*\(\+\d+ more\)\s*$/, "");
        for (const p of rest.split(",")) {
          const trimmed = p.trim();
          if (trimmed) merged[cat].add(trimmed);
        }
      }
    }
  }

  // Dedup: if already in Modified, drop from Created
  for (const p of merged.Modified) merged.Created.delete(p);

  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };

  const lines: string[] = [];
  if (merged.Modified.size > 0) lines.push(`- Modified: ${cap(merged.Modified, 10)}`);
  if (merged.Created.size > 0) lines.push(`- Created: ${cap(merged.Created, 10)}`);
  if (merged.Read.size > 0) lines.push(`- Read: ${cap(merged.Read, 10)}`);
  if (lines.length === 0) return "";
  return `[Files And Changes]\n${lines.join("\n")}`;
}

/** Merge a header section according to per-section rules. */
function mergeHeaderSection(header: string, prev: string, fresh: string): string {
  // Outstanding Context is volatile — always use fresh only
  if (header === "Outstanding Context") return fresh;
  if (!prev) return fresh;
  if (!fresh) return prev;

  // Files And Changes: merge by category
  if (header === "Files And Changes") {
    return mergeFileLines(prev, fresh);
  }

  // Session Goal, Commits, Key Signals, User Preferences: line-level dedup, cap
  const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);
  const combined = [...new Set([...prevLines, ...freshLines])];
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8
    : header === "Key Signals" ? 15 : header === "User Preferences" ? 10 : combined.length;
  const capped = combined.length > CAP ? combined.slice(-CAP) : combined;
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
}

export interface MergeOptions {
  briefTranscriptCap?: number;
}

/**
 * Merge a fresh VCC summary into an existing merged summary.
 * - Goals/Commits/Signals/Preferences: line-level dedup, capped
 * - Files: dedup by category/path
 * - Outstanding Context: volatile (always fresh)
 * - Brief Transcript: append + tail-biased cap
 */
export function mergePrevious(
  existingSummary: string,
  freshSummary: string,
  options: MergeOptions = {},
): string {
  const briefCap = options.briefTranscriptCap ?? 120;

  // Identity merges
  if (!existingSummary) return freshSummary;
  if (!freshSummary) return existingSummary;

  // Merge header sections
  const headers = HEADER_NAMES
    .map((header) => {
      const freshSec = sectionOf(freshSummary, header);
      const prevSec = sectionOf(existingSummary, header);
      return mergeHeaderSection(header, prevSec, freshSec);
    })
    .filter(Boolean);

  // Merge brief transcript: append + cap
  const prevBrief = briefOf(existingSummary);
  const freshBrief = briefOf(freshSummary);
  let mergedBrief: string;
  if (!prevBrief) {
    mergedBrief = freshBrief;
  } else if (!freshBrief) {
    mergedBrief = prevBrief;
  } else {
    mergedBrief = prevBrief + "\n\n" + freshBrief;
  }

  const parts: string[] = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(capBrief(mergedBrief, briefCap));
  }

  if (parts.length === 0) return "";
  return parts.join(SEPARATOR);
}
