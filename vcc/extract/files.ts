/**
 * Extract file activity from NormalizedBlock[] (tool calls only, no FileOps).
 * Ported from pi-vcc, adapted: dropped FileOps parameter.
 */

import type { NormalizedBlock } from "../normalize.js";
import { extractPath } from "../tool-args.js";

export interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
}

const FILE_READ_TOOLS = new Set([
  "Read", "read_file", "View",
]);

const FILE_WRITE_TOOLS = new Set([
  "Edit", "Write", "edit", "write", "edit_file", "write_file",
  "MultiEdit",
]);

const FILE_CREATE_TOOLS = new Set([
  "Write", "write", "write_file",
]);

/** Find the longest common directory prefix among absolute paths. */
function longestCommonDirPrefix(paths: string[]): string {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return "";
  return split[0].slice(0, i).join("/") + "/";
}

function trimPaths(set: Set<string>, prefix: string): Set<string> {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) {
    out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return out;
}

export function extractFiles(blocks: NormalizedBlock[]): FileActivity {
  const act: FileActivity = {
    read: new Set(),
    modified: new Set(),
    created: new Set(),
  };

  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const args = b.args ?? {};
    const p = extractPath(args);
    if (!p) continue;

    if (FILE_READ_TOOLS.has(b.name ?? "")) act.read.add(p);
    if (FILE_WRITE_TOOLS.has(b.name ?? "")) act.modified.add(p);
    if (FILE_CREATE_TOOLS.has(b.name ?? "")) act.created.add(p);
  }

  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);
  if (prefix) {
    act.read = trimPaths(act.read, prefix);
    act.modified = trimPaths(act.modified, prefix);
    act.created = trimPaths(act.created, prefix);
  }

  return act;
}
