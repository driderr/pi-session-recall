/**
 * Format VccSections into a plain-text summary string.
 * Ported from pi-vcc.
 */

import type { VccSections } from "./build-sections.js";

function section(title: string, items: string[]): string {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
}

const DEFAULT_BRIEF_MAX_LINES = 120;

export function capBrief(text: string, maxLines = DEFAULT_BRIEF_MAX_LINES): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const omitted = lines.length - maxLines;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
}

export function formatSummary(
  data: VccSections,
  config: { briefTranscriptCap?: number } = {},
): string {
  const briefCap = config.briefTranscriptCap ?? DEFAULT_BRIEF_MAX_LINES;

  const headerParts = [
    section("Session Goal", data.goals),
    section("Files And Changes", data.files),
    section("Commits", data.commits),
    section("References", data.references),
    section("Key Signals", data.signals),
    section("Outstanding Context", data.outstandingContext),
    section("User Preferences", data.preferences),
  ].filter(Boolean);

  const parts: string[] = [];
  if (headerParts.length > 0) {
    parts.push(headerParts.join("\n\n"));
  }
  if (data.briefTranscript) {
    parts.push(capBrief(data.briefTranscript, briefCap));
  }

  if (parts.length === 0) return "";

  return parts.join("\n\n---\n\n");
}
