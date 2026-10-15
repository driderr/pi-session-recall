import { describe, it, expect } from "vitest";
import { clip, clipSentence, nonEmptyLines, firstLine, textOf } from "../vcc/content.js";

describe("clip", () => {
  it("returns text unchanged when within limit", () => {
    expect(clip("hello", 10)).toBe("hello");
  });

  it("truncates at word boundary", () => {
    const result = clip("hello world foo bar", 11);
    expect(result).toBe("hello world");
  });

  it("truncates at max when no word boundary found", () => {
    const result = clip("superlongword", 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

describe("clipSentence", () => {
  it("returns text unchanged when within limit", () => {
    expect(clipSentence("hello.", 10)).toBe("hello.");
  });

  it("truncates at sentence boundary", () => {
    const result = clipSentence("First sentence. Second sentence.", 20);
    expect(result).toBe("First sentence.");
  });

  it("falls back to word boundary when no sentence end", () => {
    const result = clipSentence("hello world foo bar", 11);
    expect(result.length).toBeLessThanOrEqual(11);
  });
});

describe("nonEmptyLines", () => {
  it("splits and trims, filtering empty", () => {
    expect(nonEmptyLines("a\n  b  \n\n  \nc")).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for whitespace-only", () => {
    expect(nonEmptyLines("  \n\n  ")).toEqual([]);
  });
});

describe("firstLine", () => {
  it("returns first line clipped", () => {
    expect(firstLine("hello\nworld", 3)).toBe("hel");
  });

  it("handles empty string", () => {
    expect(firstLine("", 10)).toBe("");
  });
});

describe("textOf", () => {
  it("handles string content", () => {
    expect(textOf("hello")).toBe("hello");
  });

  it("handles array content", () => {
    expect(textOf([{ type: "text", text: "hello" }, { type: "text", text: "world" } as any])).toBe("hello\nworld");
  });

  it("handles null content", () => {
    expect(textOf(null as any)).toBe("");
  });
});
