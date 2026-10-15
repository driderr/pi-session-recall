/**
 * VCC (Versioned Context Compression) — public API.
 * Ported from pi-vcc v0.4.x (buihongduc132/pi-vcc, MIT — a fork of
 * sting8k/pi-vcc, MIT), adapted for session-recall per-turn use.
 * Full provenance: README "Credits" section.
 */

export { normalize } from "./normalize.js";
export { filterNoise } from "./filter-noise.js";
export { buildSections } from "./build-sections.js";
export { formatSummary } from "./format.js";
export { mergePrevious } from "./merge-previous.js";
export { extractVccSummary } from "./pipeline.js";
export type { NormalizedBlock } from "./normalize.js";
export type { VccSections } from "./build-sections.js";
export type { MergeOptions } from "./merge-previous.js";
