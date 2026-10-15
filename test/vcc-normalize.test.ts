import { describe, it, expect } from "vitest";
import { normalize } from "../vcc/normalize.js";

describe("normalize", () => {
  it("normalizes a simple user message", () => {
    const messages = [{ role: "user", content: "fix the build", timestamp: Date.now() }];
    const blocks = normalize(messages as any);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("user");
    expect(blocks[0].text).toBe("fix the build");
  });

  it("normalizes assistant text content", () => {
    const messages = [{
      role: "assistant",
      content: [{ type: "text", text: "I'll fix it" }],
      timestamp: Date.now(),
    }];
    const blocks = normalize(messages as any);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("assistant");
    expect(blocks[0].text).toBe("I'll fix it");
  });

  it("normalizes tool calls", () => {
    const messages = [{
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: "file.ts" } }],
      timestamp: Date.now(),
    }];
    const blocks = normalize(messages as any);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("tool_call");
    expect(blocks[0].name).toBe("read");
  });

  it("normalizes tool results", () => {
    const messages = [{
      role: "toolResult",
      toolName: "read",
      content: "file content here",
      isError: false,
      timestamp: Date.now(),
    }];
    const blocks = normalize(messages as any);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("tool_result");
    expect(blocks[0].text).toBe("file content here");
  });

  it("normalizes thinking blocks", () => {
    const messages = [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "let me think" }],
      timestamp: Date.now(),
    }];
    const blocks = normalize(messages as any);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("thinking");
  });

  it("strips ANSI codes", () => {
    const messages = [{ role: "user", content: "\x1b[32mSuccess\x1b[0m", timestamp: Date.now() }];
    const blocks = normalize(messages as any);
    expect(blocks[0].text).toBe("Success");
  });

  it("returns empty array for empty input", () => {
    expect(normalize([])).toEqual([]);
  });

  it("handles multiple content parts", () => {
    const messages = [{
      role: "assistant",
      content: [
        { type: "text", text: "Part 1" },
        { type: "toolCall", name: "write", arguments: { path: "file.ts" } },
        { type: "text", text: "Part 2" },
      ],
      timestamp: Date.now(),
    }];
    const blocks = normalize(messages as any);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].kind).toBe("assistant");
    expect(blocks[1].kind).toBe("tool_call");
    expect(blocks[2].kind).toBe("assistant");
  });
});
