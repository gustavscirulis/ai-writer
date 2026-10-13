import type { McpServer } from "@/lib/co-writer-suggestions";

/** A Claude Code skill or custom command, run by typing `/name`. */
export interface Skill {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
}

export interface Capabilities {
  mcpServers: McpServer[];
  skills: Skill[];
}

const MAX_MATCHES = 50;

/** The word being typed after a leading `/`, while the draft is still only that word. */
export function slashQuery(draft: string) {
  return /^\/(\S*)$/.exec(draft)?.[1] ?? null;
}

/** Name prefixes (including the part after a `plugin:` namespace) rank above substrings. */
export function matchSkills(query: string, skills: Skill[]) {
  const q = query.toLowerCase();
  const rank = (skill: Skill) => {
    const name = skill.name.toLowerCase();
    if (name.startsWith(q) || name.slice(name.lastIndexOf(":") + 1).startsWith(q)) return 0;
    return name.includes(q) ? 1 : -1;
  };
  return skills
    .map((skill) => ({ skill, rank: rank(skill) }))
    .filter((match) => match.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_MATCHES)
    .map((match) => match.skill);
}

function startsWithSkill(text: string, skills: Skill[]) {
  const name = /^\/(\S+)/.exec(text)?.[1];
  return !!name && skills.some((skill) => skill.name === name || skill.aliases.includes(name));
}

/** Claude Code only runs a skill when the message starts with `/name`, so the
 * context goes after it there; other text that starts with `/`, like a path, stays as typed. */
export function promptContent(context: object, text: string, skills: Skill[]) {
  const block = `<writer_context>${JSON.stringify(context)}</writer_context>`;
  return startsWithSkill(text, skills) ? `${text}\n\n${block}` : `${block}\n\n${text}`;
}
