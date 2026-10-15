/**
 * Text clipping and extraction utilities.
 * Ported from pi-vcc, adapted for @earendil-works/pi-ai Message type.
 */

import type { Message } from "@earendil-works/pi-ai";

/** Clip text to max chars, preferring word boundary. */
export function clip(text: string, max = 200): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  // Avoid splitting a surrogate pair
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
}

/**
 * Clip text to last sentence boundary at or before `max` chars.
 * Falls back to word boundary (clip()) if no sentence end is found.
 */
export function clipSentence(text: string, max = 200): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const matches = [...window.matchAll(/[.!?](?:\s|$)/g)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const end = (last.index ?? 0) + 1;
    if (end >= max * 0.5) return text.slice(0, end);
  }
  return clip(text, max);
}

/** Return non-empty trimmed lines from text. */
export function nonEmptyLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Return the first line of text, clipped to max chars. */
export function firstLine(text: string, max = 200): string {
  return clip(text.split("\n")[0] ?? "", max);
}

/** Extract text parts from a Message content field (string or array). */
export function textParts(content: Message["content"]): string[] {
  if (!content) return [];
  if (typeof content === "string") return [content];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text);
}

/** Join all text parts of a Message content field with newlines. */
export function textOf(content: Message["content"]): string {
  return textParts(content).join("\n");
}
