import { describe, it, expect } from "vitest";
import { filterNoise } from "../vcc/filter-noise.js";
import type { NormalizedBlock } from "../vcc/normalize.js";

describe("filterNoise", () => {
  it("drops thinking blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "thinking", text: "let me think" },
      { kind: "user", text: "hello" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("user");
  });

  it("drops noise tool calls", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "TodoWrite", args: {} },
      { kind: "tool_call", name: "read", args: { path: "file.ts" } },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read");
  });

  it("drops empty user messages", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "   " },
      { kind: "user", text: "hello" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("hello");
  });

  it("strips XML wrappers from user messages", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>reminder text</system-reminder>hello" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("hello");
  });

  it("drops user messages that are only XML wrappers", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>reminder text</system-reminder>" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(0);
  });

  it("retains valid blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "fix the bug" },
      { kind: "assistant", text: "I'll fix it" },
      { kind: "tool_call", name: "read", args: { path: "file.ts" } },
      { kind: "tool_result", name: "read", text: "content", isError: false },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(4);
  });

  it("handles empty input", () => {
    expect(filterNoise([])).toEqual([]);
  });
});
