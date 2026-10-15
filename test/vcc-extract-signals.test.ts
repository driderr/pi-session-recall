import { describe, it, expect } from "vitest";
import { extractSignals, formatSignals } from "../vcc/extract/signals.js";
import type { NormalizedBlock } from "../vcc/normalize.js";

describe("extractSignals", () => {
  it("extracts constraints from user messages", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Don't use any external libraries for this" },
    ];
    const signals = extractSignals(blocks);
    expect(signals.constraints.length).toBeGreaterThan(0);
  });

  it("extracts decisions from user messages", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "I decided to use TypeScript for the project" },
    ];
    const signals = extractSignals(blocks);
    expect(signals.decisions.length).toBeGreaterThan(0);
  });

  it("extracts status patterns", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "DONE: Fixed the authentication bug" },
    ];
    const signals = extractSignals(blocks);
    expect(signals.statuses.length).toBeGreaterThan(0);
  });

  it("returns empty for clean messages", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Here is the result of your query" },
    ];
    const signals = extractSignals(blocks);
    expect(signals.constraints).toEqual([]);
    expect(signals.decisions).toEqual([]);
  });

  it("caps constraints at 5", () => {
    const blocks: NormalizedBlock[] = Array.from({ length: 10 }, (_, i) => ({
      kind: "user" as const,
      text: `Must not do thing number ${i} in the system`,
    }));
    const signals = extractSignals(blocks);
    expect(signals.constraints.length).toBeLessThanOrEqual(5);
  });

  it("skips questions", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Can you not use that library?" },
    ];
    const signals = extractSignals(blocks);
    expect(signals.constraints).toEqual([]);
  });
});

describe("formatSignals", () => {
  it("formats signals with prefixes", () => {
    const signals = {
      constraints: ["Must use HTTPS"],
      decisions: ["Use TypeScript"],
      statuses: ["DONE: Fixed bug"],
    };
    const lines = formatSignals(signals);
    expect(lines).toContain("Constraint: Must use HTTPS");
    expect(lines).toContain("Decision: Use TypeScript");
    expect(lines).toContain("Status: DONE: Fixed bug");
  });

  it("returns empty for no signals", () => {
    expect(formatSignals({ constraints: [], decisions: [], statuses: [] })).toEqual([]);
  });
});
