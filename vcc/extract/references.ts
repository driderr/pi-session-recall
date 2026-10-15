/**
 * Extract URLs, GitHub refs, versions, branches, commit refs from NormalizedBlock[].
 * Ported from pi-vcc.
 */

import type { NormalizedBlock } from "../normalize.js";

export interface ReferenceExtract {
  urls: string[];
  githubRefs: string[];
  versions: string[];
  branches: string[];
  commitRefs: string[];
}

export interface ReferencesOptions {
  enabled?: boolean;
  extraUrlPatterns?: string[];
  extraGithubRefPatterns?: string[];
  extraVersionPatterns?: string[];
  extraBranchPatterns?: string[];
}

const URL_RE = /https?:\/\/\S+/g;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>]+$/;

const BARE_ISSUE_RE = /#(\d+)/g;
const PR_REF_RE = /\b(PR|pr)\s*#(\d+)/g;
const OWNER_REPO_RE = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)\/([a-zA-Z0-9_.-]+)\b/g;
const REPO_FILTER = (owner: string, repo: string): boolean => {
  if (owner.length < 2 || repo.length < 2) return false;
  if (/^\./.test(repo)) return false;
  const skipOwners = new Set(["src", "lib", "dist", "build", "test", "tests", "pkg", "cmd", "web", "app", "docs", "scripts", "assets", "public", "static", "vendor"]);
  if (skipOwners.has(owner.toLowerCase())) return false;
  return true;
};

const VERSION_RE = /\b(v?\d+\.\d+\.\d+)\b/g;
function isIPContext(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 20), index);
  const after = text.slice(index, Math.min(text.length, index + 30));
  if (/\d+\.\d+\.\d+\.\d+/.test(after)) return true;
  if (/\d+\.\d+\.\d+\.\d+/.test(before + after.slice(0, 15))) return true;
  return false;
}

const BRANCH_RE = /\b(?:feat|fix|hotfix|release|chore|refactor|docs|test)\/[\w-]+\b/g;
const COMMIT_REF_RE = /\b([0-9a-f]{7,12})\b/g;
function isLikelyHexHash(s: string): boolean {
  return /[a-f]/i.test(s);
}

const URL_LIMIT = 10;
const GITHUB_REF_LIMIT = 8;
const VERSION_LIMIT = 5;
const BRANCH_LIMIT = 5;
const COMMIT_REF_LIMIT = 5;

function cleanUrl(raw: string): string {
  return raw.replace(TRAILING_PUNCT_RE, "");
}

function collectTextFromBlocks(blocks: NormalizedBlock[]): string[] {
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "user" || b.kind === "assistant") {
      texts.push(b.text ?? "");
    }
  }
  return texts;
}

function compilePatterns(patterns: string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  return patterns.map((p) => {
    try { return new RegExp(p, "g"); } catch { return null; }
  }).filter((r): r is RegExp => r !== null);
}

export function extractReferences(blocks: NormalizedBlock[], options?: ReferencesOptions): ReferenceExtract {
  if (options?.enabled === false) {
    return { urls: [], githubRefs: [], versions: [], branches: [], commitRefs: [] };
  }

  const urls = new Set<string>();
  const githubRefs = new Set<string>();
  const versions = new Set<string>();
  const branches = new Set<string>();
  const commitRefs = new Set<string>();

  const extraUrlRes = compilePatterns(options?.extraUrlPatterns);
  const extraGhRefRes = compilePatterns(options?.extraGithubRefPatterns);
  const extraVersionRes = compilePatterns(options?.extraVersionPatterns);
  const extraBranchRes = compilePatterns(options?.extraBranchPatterns);

  const texts = collectTextFromBlocks(blocks);

  for (const text of texts) {
    if (urls.size < URL_LIMIT) {
      for (const m of text.matchAll(URL_RE)) {
        const cleaned = cleanUrl(m[0]);
        if (cleaned && urls.size < URL_LIMIT) urls.add(cleaned);
      }
      for (const re of extraUrlRes) {
        for (const m of text.matchAll(re)) {
          const val = m[1] ?? m[0];
          const cleaned = cleanUrl(val);
          if (cleaned && urls.size < URL_LIMIT) urls.add(cleaned);
        }
      }
    }

    if (githubRefs.size < GITHUB_REF_LIMIT) {
      for (const m of text.matchAll(BARE_ISSUE_RE)) {
        const ref = `#${m[1]}`;
        if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(ref);
      }
      for (const m of text.matchAll(PR_REF_RE)) {
        const ref = `${m[1]} #${m[2]}`;
        if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(ref);
      }
      for (const m of text.matchAll(OWNER_REPO_RE)) {
        if (REPO_FILTER(m[1], m[2])) {
          const ref = `${m[1]}/${m[2]}`;
          if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(ref);
        }
      }
      for (const m of text.matchAll(/https?:\/\/github\.com\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)\/(?:issues|pull)\/(\d+)/g)) {
        const ref = `${m[1]}/${m[2]}#${m[3]}`;
        if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(ref);
      }
      for (const re of extraGhRefRes) {
        for (const m of text.matchAll(re)) {
          const val = m[1] ?? m[0];
          if (githubRefs.size < GITHUB_REF_LIMIT) githubRefs.add(val);
        }
      }
    }

    if (versions.size < VERSION_LIMIT) {
      for (const m of text.matchAll(VERSION_RE)) {
        if (!isIPContext(text, m.index ?? 0)) {
          if (versions.size < VERSION_LIMIT) versions.add(m[1]);
        }
      }
      for (const re of extraVersionRes) {
        for (const m of text.matchAll(re)) {
          const val = m[1] ?? m[0];
          if (versions.size < VERSION_LIMIT) versions.add(val);
        }
      }
    }

    if (branches.size < BRANCH_LIMIT) {
      for (const m of text.matchAll(BRANCH_RE)) {
        if (branches.size < BRANCH_LIMIT) branches.add(m[0]);
      }
      for (const re of extraBranchRes) {
        for (const m of text.matchAll(re)) {
          if (branches.size < BRANCH_LIMIT) branches.add(m[0]);
        }
      }
    }

    if (commitRefs.size < COMMIT_REF_LIMIT) {
      for (const m of text.matchAll(COMMIT_REF_RE)) {
        if (isLikelyHexHash(m[1])) {
          if (commitRefs.size < COMMIT_REF_LIMIT) commitRefs.add(m[1]);
        }
      }
    }
  }

  return {
    urls: [...urls].slice(0, URL_LIMIT),
    githubRefs: [...githubRefs].slice(0, GITHUB_REF_LIMIT),
    versions: [...versions].slice(0, VERSION_LIMIT),
    branches: [...branches].slice(0, BRANCH_LIMIT),
    commitRefs: [...commitRefs].slice(0, COMMIT_REF_LIMIT),
  };
}

export function formatReferences(refs: ReferenceExtract): string[] {
  const lines: string[] = [];
  if (refs.urls.length > 0) lines.push(`URL: ${refs.urls.join(", ")}`);
  if (refs.githubRefs.length > 0) lines.push(`GitHub: ${refs.githubRefs.join(", ")}`);
  if (refs.versions.length > 0) lines.push(`Version: ${refs.versions.join(", ")}`);
  if (refs.branches.length > 0) lines.push(`Branch: ${refs.branches.join(", ")}`);
  if (refs.commitRefs.length > 0) lines.push(`CommitRef: ${refs.commitRefs.join(", ")}`);
  return lines;
}
