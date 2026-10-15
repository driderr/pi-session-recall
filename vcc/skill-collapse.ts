/**
 * Skill tag collapsing utilities.
 * Ported from pi-vcc.
 */

const SKILL_TAG_RE = /^-?\s*<skill\s+name="([^"]+)"/;
const SKILL_CLOSE_RE = /^-?\s*<\/skill>/;

/** Collapse skill tags in an array of lines — dedup by name, drop content inside block. */
export function collapseSkillLines(lines: string[]): string[] {
  const result: string[] = [];
  const seenSkills = new Set<string>();
  let insideSkill = false;

  for (const line of lines) {
    const skillMatch = line.match(SKILL_TAG_RE);
    if (skillMatch) {
      insideSkill = true;
      const name = skillMatch[1];
      if (!seenSkills.has(name)) {
        seenSkills.add(name);
        result.push(`[skill: ${name}]`);
      }
      continue;
    }
    if (insideSkill) {
      if (SKILL_CLOSE_RE.test(line)) insideSkill = false;
      continue;
    }
    result.push(line);
  }
  return result;
}

/** Collapse <skill name="X" ...>...</skill> blocks in raw text. */
const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?(?:<\/skill>|$)/g;
export function collapseSkillText(text: string): string {
  return text.replace(SKILL_BLOCK_RE, (_, name) => `[skill: ${name}]`);
}
