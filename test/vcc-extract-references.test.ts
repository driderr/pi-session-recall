import { describe, it, expect } from "vitest";
import { extractReferences, formatReferences } from "../vcc/extract/references.js";
import type { NormalizedBlock } from "../vcc/normalize.js";

describe("extractReferences", () => {
  it("extracts URLs", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Check https://example.com/docs for details" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toContain("https://example.com/docs");
  });

  it("extracts GitHub issue refs", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "See issue #42 for context" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.githubRefs).toContain("#42");
  });

  it("extracts version numbers", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Upgrade to v1.2.3" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.versions).toContain("v1.2.3");
  });

  it("extracts branch names", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Merge feat/auth into main" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.branches).toContain("feat/auth");
  });

  it("returns empty for no references", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Hello world" },
    ];
    const refs = extractReferences(blocks);
    expect(refs.urls).toEqual([]);
    expect(refs.githubRefs).toEqual([]);
  });

  it("respects enabled=false option", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Check https://example.com/docs" },
    ];
    const refs = extractReferences(blocks, { enabled: false });
    expect(refs.urls).toEqual([]);
  });
});

describe("formatReferences", () => {
  it("formats with category prefixes", () => {
    const refs = {
      urls: ["https://example.com"],
      githubRefs: ["#42"],
      versions: ["v1.0.0"],
      branches: [],
      commitRefs: [],
    };
    const lines = formatReferences(refs);
    expect(lines).toContain("URL: https://example.com");
    expect(lines).toContain("GitHub: #42");
    expect(lines).toContain("Version: v1.0.0");
  });

  it("returns empty for no references", () => {
    expect(formatReferences({ urls: [], githubRefs: [], versions: [], branches: [], commitRefs: [] })).toEqual([]);
  });
});
