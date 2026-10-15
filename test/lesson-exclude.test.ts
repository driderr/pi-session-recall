import { describe, it, expect } from "vitest";
import { matchesIgnorePatterns } from "../discoverer.js";

// lessonExcludePatterns semantics (2026-09-02): the config list is matched
// against the FULL session file path by the same helper ignorePatterns uses.
// Session directories are the cwd dash-encoded, e.g.
//   ~/.pi/agent/sessions/--C--Users-test-Documents-VSCodeProjects-discordGrabber-Plugin--/<file>.jsonl
// The substring pattern "discordGrabber" is intended to catch BOTH the plain
// and the -Plugin project directories (user decision 2026-09-02). This file
// pins that real-world path-shape behavior for the writer guard in index.ts.

const BASE = "C:\\Users\\test\\.pi\\agent\\sessions";

describe("lessonExcludePatterns matching (writer guard semantics)", () => {
  it("discordGrabber matches the encoded -Plugin project directory (Windows path)", () => {
    const path = `${BASE}\\--C--Users-test-Documents-VSCodeProjects-discordGrabber-Plugin--\\2026-08-01T12-00-00-000Z_abc.jsonl`;
    expect(matchesIgnorePatterns(path, ["discordGrabber"])).toBe(true);
  });

  it("discordGrabber matches the encoded plain project directory (Windows path)", () => {
    const path = `${BASE}\\--C--Users-test-Documents-VSCodeProjects-discordGrabber--\\2026-08-01T12-00-00-000Z_abc.jsonl`;
    expect(matchesIgnorePatterns(path, ["discordGrabber"])).toBe(true);
  });

  it("discordGrabber matches the encoded directory shape (POSIX-normalized path)", () => {
    const path = `${BASE}/--C--Users-test-Documents-VSCodeProjects-discordGrabber-Plugin--/2026-08-01T12-00-00-000Z_abc.jsonl`;
    expect(matchesIgnorePatterns(path, ["discordGrabber"])).toBe(true);
  });

  it("does not match unrelated project directories", () => {
    const path = `${BASE}\\--C--Users-test-Documents-VSCodeProjects-session-recall--\\2026-08-01T12-00-00-000Z_abc.jsonl`;
    expect(matchesIgnorePatterns(path, ["discordGrabber"])).toBe(false);
  });

  it("does not match a project name that merely shares a longer word", () => {
    const path = `${BASE}\\--C--Users-test-Documents-VSCodeProjects-grabber-utils--\\2026-08-01T12-00-00-000Z_abc.jsonl`;
    // "discordGrabber" requires the full word; a sibling name without it is untouched
    expect(matchesIgnorePatterns(path, ["discordGrabber"])).toBe(false);
  });

  it("empty pattern list excludes nothing", () => {
    const path = `${BASE}\\--C--Users-test-Documents-VSCodeProjects-discordGrabber-Plugin--\\x.jsonl`;
    expect(matchesIgnorePatterns(path, [])).toBe(false);
  });
});
