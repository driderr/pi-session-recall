import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { ensureSchema } from "../summarizer.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

describe("migration helpers", () => {
  it("ensureSchema creates session_summaries table", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const tableNames = tables.map((t: any) => t.name);
    expect(tableNames).toContain("session_summaries");

    // Verify session_summaries schema
    const columns = db.prepare("PRAGMA table_info(session_summaries)").all();
    const columnNames = columns.map((c: any) => c.name);
    expect(columnNames).toContain("session_path");
    expect(columnNames).toContain("version");
    expect(columnNames).toContain("summary");
    expect(columnNames).toContain("char_count");
    expect(columnNames).toContain("merge_count");
    expect(columnNames).toContain("last_fresh_hash");
    expect(columnNames).toContain("updated_at");

    db.close();
  });

  it("session_summaries table enforces unique session_path", () => {
    const db = new Database(":memory:");
    ensureSchema(db);

    db.prepare(
      "INSERT INTO session_summaries (session_path, version, summary, char_count, merge_count, last_fresh_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("/session1.jsonl", 1, "Summary 1", 9, 1, "hash1", new Date().toISOString());

    // INSERT OR REPLACE should work (same session_path)
    db.prepare(
      "INSERT OR REPLACE INTO session_summaries (session_path, version, summary, char_count, merge_count, last_fresh_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("/session1.jsonl", 2, "Summary 2", 9, 2, "hash2", new Date().toISOString());

    const count = db.prepare("SELECT COUNT(*) as c FROM session_summaries").get();
    expect(count.c).toBe(1);

    const row = db.prepare("SELECT summary, version FROM session_summaries WHERE session_path = ?").get("/session1.jsonl");
    expect(row.summary).toBe("Summary 2");
    expect(row.version).toBe(2);

    db.close();
  });

});
