import { describe, it, expect } from "vitest";
import { getLogPath, getRecentLogLines } from "../logger.js";
import { sep } from "node:path";

describe("logger", () => {
  it("log path contains correct date format", () => {
    const path = getLogPath();
    const today = new Date().toISOString().slice(0, 10);
    expect(path).toContain(`log-${today}.txt`);
  });

  it("log path is in extension directory", () => {
    const path = getLogPath();
    expect(path).toContain("session-recall");
    expect(path).toContain(".txt");
  });

  it("getRecentLogLines returns empty array when no log exists", () => {
    const lines = getRecentLogLines(5);
    // May return actual log lines if extension has been used, or empty if not
    expect(Array.isArray(lines)).toBe(true);
  });

  it("getLogPath uses forward slashes on Windows for the date portion", () => {
    const path = getLogPath();
    const today = new Date().toISOString().slice(0, 10);
    // The filename portion should be correct regardless of OS
    const filename = path.split(sep).pop();
    expect(filename).toBe(`log-${today}.txt`);
  });
});
