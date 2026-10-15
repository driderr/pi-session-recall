/**
 * VCC extraction pipeline: Message[] → normalized → filtered → sections → summary string.
 */

import type { Message } from "@earendil-works/pi-ai";
import { normalize } from "./normalize.js";
import { filterNoise } from "./filter-noise.js";
import { buildSections } from "./build-sections.js";
import { formatSummary } from "./format.js";

/**
 * Run the full VCC extraction pipeline on a list of messages.
 * Returns a formatted VCC summary string.
 */
export function extractVccSummary(
  messages: Message[],
  config: { briefTranscriptCap?: number } = {},
): string {
  const blocks = normalize(messages);
  const filtered = filterNoise(blocks);
  const sections = buildSections(filtered, config);
  return formatSummary(sections, config);
}
