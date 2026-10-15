// Chunk packer (design §2.1) — pure, no DB, no LLM.
// Spec: 60K Token Budget Enforcement (chunking scenarios).
import { describe, it, expect } from "vitest";
import { renderSessionEntry, packMergeChunks } from "../summarizer.js";

const SEP = "\n---\n"; // must match summarizer's SEPARATOR (same string as the prompt join)

// All row paths share basename length (8 chars) so rendered entries of a
// requested total length are exactly predictable: entry = header + content.
function rowPath(i: number): string {
  return `/pi/sessions/${String(i).padStart(2, "0")}.jsonl`;
}
const HEADER_LEN = `### Session: 00.jsonl\n\n`.length; // 23

function contentForEntryLength(n: number, label: string): string {
  const need = n - HEADER_LEN;
  const unit = `${label}|`;
  let s = unit.repeat(Math.ceil(need / unit.length));
  s = s.slice(0, need);
  expect(s.length).toBe(need); // guard: exact-length construction
  return s;
}

function rowsWithEntryLengths(
  lengths: number[],
): Array<{ session_path: string; unmerged_fresh_content: string }> {
  return lengths.map((len, i) => ({
    session_path: rowPath(i),
    unmerged_fresh_content: contentForEntryLength(len, `c${i}`),
  }));
}

describe("renderSessionEntry", () => {
  it("exact header format with blank line and byte-identical content", () => {
    const entry = renderSessionEntry(
      "/pi/agent/sessions/2026-08-24T05-38-26-803Z_01a03246.jsonl",
      "VCC content",
    );
    expect(entry).toBe("### Session: 2026-08-24T05-38-26-803Z_01a03246.jsonl\n\nVCC content");
    // content portion byte-identical (header prefix only)
    expect(entry.endsWith("VCC content")).toBe(true);
  });

  it("renders Windows backslash paths by basename", () => {
    const entry = renderSessionEntry("C:\\pi\\agent\\sessions\\abc.jsonl", "X");
    expect(entry).toBe("### Session: abc.jsonl\n\nX");
  });
});

describe("packMergeChunks", () => {
  it("5 rows x 10,000-char entries, max 24,000 -> exactly 3 chunks [2,2,1]", () => {
    const rows = rowsWithEntryLengths([10_000, 10_000, 10_000, 10_000, 10_000]);
    const chunks = packMergeChunks(rows, 24_000);
    expect(chunks).toHaveLength(3);
    expect(chunks.map(c => c.entries.length)).toEqual([2, 2, 1]);
    // each chunk's as-sent rendered length <= max
    for (const chunk of chunks) {
      expect(chunk.entries.join(SEP).length).toBeLessThanOrEqual(24_000);
    }
    // path order = input order (updated_at ASC); oldest in the first chunk
    const flatPaths = chunks.flatMap(c => c.paths);
    expect(flatPaths).toEqual(rows.map(r => r.session_path));
  });

  it("at-limit boundary: as-sent 24,000 exactly adds the entry", () => {
    // Pin F construction: chunk already rendered 13,995 (two 6,995 entries + 5-char separator).
    const rows = rowsWithEntryLengths([6_995, 6_995, 10_000]);
    const chunks = packMergeChunks(rows, 24_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].entries.length).toBe(3);
    expect(chunks[0].entries.join(SEP).length).toBe(24_000);
  });

  it("one-over boundary: as-sent 24,001 starts a new chunk", () => {
    const rows = rowsWithEntryLengths([6_995, 6_995, 10_001]);
    const chunks = packMergeChunks(rows, 24_000);
    expect(chunks).toHaveLength(2);
    expect(chunks.map(c => c.entries.length)).toEqual([2, 1]);
    // the 10,001-char entry is in the second chunk, unsplit
    expect(chunks[1].entries[0].length).toBe(10_001);
    for (const chunk of chunks) {
      expect(chunk.entries.join(SEP).length).toBeLessThanOrEqual(24_000);
    }
  });

  it("oversized single session becomes its own chunk (never skipped, never split)", () => {
    const rows = rowsWithEntryLengths([30_000, 100]);
    const chunks = packMergeChunks(rows, 24_000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].paths).toEqual([rowPath(0)]);
    expect(chunks[0].entries.length).toBe(1);
    // content not split — full oversized content present in its own chunk
    expect(chunks[0].entries[0]).toContain(rows[0].unmerged_fresh_content);
    // a following small entry goes to a SECOND chunk (not appended to the oversized one)
    expect(chunks[1].paths).toEqual([rowPath(1)]);
    expect(chunks[1].entries.length).toBe(1);
  });

  it("empty input produces zero chunks", () => {
    expect(packMergeChunks([], 24_000)).toEqual([]);
  });

  it("2-entry chunk joins with exactly one separator (as sent to the LLM)", () => {
    const rows = rowsWithEntryLengths([10_000, 10_000]);
    const chunks = packMergeChunks(rows, 24_000);
    expect(chunks).toHaveLength(1);
    const joined = chunks[0].entries.join(SEP);
    expect(joined.split(SEP)).toHaveLength(2); // exactly one separator between the two entries
    expect(chunks[0].entries[0].includes(SEP)).toBe(false);
    expect(chunks[0].entries[1].includes(SEP)).toBe(false);
  });
});
