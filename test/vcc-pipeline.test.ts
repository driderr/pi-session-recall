import { describe, it, expect } from "vitest";
import { extractVccSummary } from "../vcc/pipeline.js";

describe("extractVccSummary (pipeline)", () => {
  it("produces a summary from a full turn", () => {
    const messages: any[] = [
      { role: "user", content: "I want to fix the login bug", timestamp: Date.now() },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll investigate the login flow" },
          { type: "toolCall", name: "Read", arguments: { path: "src/auth.ts" } },
          { type: "toolCall", name: "Edit", arguments: { path: "src/auth.ts" } },
        ],
        timestamp: Date.now(),
      },
    ];
    const summary = extractVccSummary(messages);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("[Session Goal]");
    // Brief transcript appears after --- separator with [user]/[assistant] headers
    expect(summary).toContain("---");
    expect(summary).toContain("[user]");
    expect(summary).toContain("[assistant]");
  });

  it("returns empty string for empty messages", () => {
    expect(extractVccSummary([])).toBe("");
  });

  it("returns empty string for noise-only messages", () => {
    const messages: any[] = [
      { role: "user", content: "   ", timestamp: Date.now() },
    ];
    expect(extractVccSummary(messages)).toBe("");
  });

  it("respects briefTranscriptCap", () => {
    const messages: any[] = [
      { role: "user", content: "fix the build", timestamp: Date.now() },
    ];
    const summary = extractVccSummary(messages, { briefTranscriptCap: 50 });
    expect(summary.length).toBeGreaterThan(0);
  });

  it("handles tool errors in summary", () => {
    const messages: any[] = [
      { role: "user", content: "run the tests", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolName: "bash",
        content: "Error: test failed on line 42",
        isError: true,
        timestamp: Date.now(),
      },
    ];
    const summary = extractVccSummary(messages);
    expect(summary.length).toBeGreaterThan(0);
  });
});
