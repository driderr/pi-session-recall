import { describe, it, expect } from "vitest";
import { sanitize } from "../vcc/sanitize.js";

describe("sanitize", () => {
  it("strips ANSI escape codes", () => {
    expect(sanitize("\x1b[32mSuccess\x1b[0m")).toBe("Success");
    expect(sanitize("\x1b[1;31mError\x1b[0m")).toBe("Error");
  });

  it("strips carriage returns", () => {
    expect(sanitize("line1\r\nline2")).toBe("line1\nline2");
    expect(sanitize("line1\rline2")).toBe("line1\nline2");
  });

  it("strips control characters", () => {
    expect(sanitize("hello\x00world")).toBe("helloworld");
  });

  it("is no-op on clean text", () => {
    expect(sanitize("clean text")).toBe("clean text");
  });

  it("handles empty string", () => {
    expect(sanitize("")).toBe("");
  });
});
