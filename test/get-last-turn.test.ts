import { describe, it, expect } from "vitest";
import { getLastTurn } from "../index.js";

describe("getLastTurn", () => {
  it("pairs last user and assistant messages", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
    ];
    const result = getLastTurn(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("second question");
    expect(result[1].content).toBe("second answer");
  });

  it("returns empty array for empty input", () => {
    const result = getLastTurn([]);
    expect(result).toEqual([]);
  });

  it("returns single user message when no assistant", () => {
    const messages = [{ role: "user", content: "hello" }];
    const result = getLastTurn(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("hello");
  });

  it("returns single assistant message when no user", () => {
    const messages = [{ role: "assistant", content: "hi" }];
    const result = getLastTurn(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("hi");
  });

  it("returns last pair from multiple turns", () => {
    const messages = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
    ];
    const result = getLastTurn(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("q3");
    expect(result[1].content).toBe("a3");
  });

  it("ignores tool results for pairing", () => {
    const messages = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
      { role: "toolResult", content: "tool output" },
      { role: "assistant", content: "final answer" },
    ];
    const result = getLastTurn(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("question");
    expect(result[1].content).toBe("final answer");
  });

  it("handles consecutive same-role messages", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer" },
    ];
    const result = getLastTurn(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("second");
    expect(result[1].content).toBe("answer");
  });

  it("handles null/undefined without throwing", () => {
    expect(getLastTurn(null as any)).toEqual([]);
    expect(getLastTurn(undefined as any)).toEqual([]);
  });

  it("handles SessionEntry wrapper format", () => {
    const messages = [
      { type: "message", message: { role: "user", content: "first question" } },
      { type: "message", message: { role: "assistant", content: "first answer" } },
      { type: "message", message: { role: "user", content: "second question" } },
      { type: "message", message: { role: "assistant", content: "second answer" } },
    ];
    const result = getLastTurn(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("second question");
    expect(result[1].content).toBe("second answer");
  });

  it("handles mixed flat and SessionEntry wrapper formats", () => {
    const messages = [
      { role: "user", content: "flat user" },
      { type: "message", message: { role: "assistant", content: "wrapped answer" } },
      { role: "user", content: "flat user 2" },
      { type: "message", message: { role: "assistant", content: "wrapped answer 2" } },
    ];
    const result = getLastTurn(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("flat user 2");
    expect(result[1].content).toBe("wrapped answer 2");
  });

  it("handles SessionEntry wrapper with no assistant", () => {
    const messages = [
      { type: "message", message: { role: "user", content: "hello" } },
    ];
    const result = getLastTurn(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("hello");
  });
});
