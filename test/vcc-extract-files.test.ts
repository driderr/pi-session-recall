import { describe, it, expect } from "vitest";
import { extractFiles } from "../vcc/extract/files.js";
import type { NormalizedBlock } from "../vcc/normalize.js";

describe("extractFiles", () => {
  it("extracts file reads", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { path: "src/api.ts" } },
    ];
    const result = extractFiles(blocks);
    expect(result.read.has("src/api.ts")).toBe(true);
  });

  it("extracts file modifications", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Edit", args: { path: "src/api.ts" } },
    ];
    const result = extractFiles(blocks);
    expect(result.modified.has("src/api.ts")).toBe(true);
  });

  it("extracts file creations", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Write", args: { path: "src/new.ts" } },
    ];
    const result = extractFiles(blocks);
    expect(result.created.has("src/new.ts")).toBe(true);
  });

  it("deduplicates by path", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { path: "src/api.ts" } },
      { kind: "tool_call", name: "Read", args: { path: "src/api.ts" } },
    ];
    const result = extractFiles(blocks);
    expect(result.read.size).toBe(1);
  });

  it("returns empty for no tool calls", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "world" },
    ];
    const result = extractFiles(blocks);
    expect(result.read.size).toBe(0);
    expect(result.modified.size).toBe(0);
    expect(result.created.size).toBe(0);
  });
});
