/**
 * Filter noise from NormalizedBlock[]: thinking blocks, noise tool calls,
 * empty user messages, XML system-reminder wrappers.
 * Ported from pi-vcc.
 */

import type { NormalizedBlock } from "./normalize.js";

const NOISE_TOOLS = new Set([
  "TodoWrite", "TodoRead", "ToolSearch", "WebSearch",
  "AskUser", "ExitSpecMode", "GenerateDroid",
]);

const NOISE_STRINGS = [
  "Continue from where you left off.",
  "No response requested.",
  "IMPORTANT: TodoWrite was not called yet.",
];

const XML_WRAPPER_RE = /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

function isNoiseUserBlock(text: string): boolean {
  const trimmed = text.trim();
  if (NOISE_STRINGS.some((s) => trimmed.includes(s))) return true;
  const stripped = trimmed.replace(XML_WRAPPER_RE, "").trim();
  return stripped.length === 0;
}

function cleanUserText(text: string): string {
  return text.replace(XML_WRAPPER_RE, "").trim();
}

export function filterNoise(blocks: NormalizedBlock[]): NormalizedBlock[] {
  const out: NormalizedBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "thinking") continue;
    if (b.kind === "tool_call" && b.name && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "tool_result" && b.name && NOISE_TOOLS.has(b.name)) continue;
    if (b.kind === "user") {
      const userText = b.text ?? "";
      if (isNoiseUserBlock(userText)) continue;
      const cleaned = cleanUserText(userText);
      if (!cleaned) continue;
      out.push({ kind: "user", text: cleaned });
      continue;
    }
    out.push(b);
  }
  return out;
}
