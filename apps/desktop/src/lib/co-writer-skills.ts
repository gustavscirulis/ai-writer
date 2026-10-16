import type { ModelInfo } from "@/lib/claude-models";
import type { McpServer } from "@/lib/co-writer-suggestions";
import type { MentionMatch } from "@/lib/mentions";

/** A Claude Code skill or custom command, run by typing `/name`. */
export interface Skill {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
}

export interface Capabilities extends ModelInfo {
  mcpServers: McpServer[];
  skills: Skill[];
}

const MAX_MATCHES = 50;

/** The word being typed after a `/` that starts the draft or follows whitespace. */
export function slashQuery(text: string, caret: number): MentionMatch | null {
  const match = /(?:^|\s)\/(\S*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1]!;
  return { query, from: caret - query.length - 1, to: caret };
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

/** The text with its first `/skill` word moved to the front, or null when it names no skill. */
function skillFirst(text: string, skills: Skill[]) {
  for (const match of text.matchAll(/(^|\s)\/(\S+)/g)) {
    const name = match[2]!;
    if (!skills.some((skill) => skill.name === name || skill.aliases.includes(name))) continue;
    if (match.index === 0) return text;
    const from = match.index + match[1]!.length;
    const before = text.slice(0, from);
    const after = text.slice(from + name.length + 1);
    const rest = /^[ \t]/.test(after)
      ? before + after.slice(1)
      : before.replace(/[ \t]+$/, "") + after;
    return `/${name} ${rest.trim()}`.trimEnd();
  }
  return null;
}

/** Claude Code and Codex only run a skill when the message starts with `/name`, so a skill
 * typed later moves there, with the context after it; other `/` words, like paths, stay as typed. */
export function promptContent(context: object, text: string, skills: Skill[]) {
  const block = `<writer_context>${JSON.stringify(context)}</writer_context>`;
  const skilled = skillFirst(text, skills);
  return skilled === null ? `${block}\n\n${text}` : `${skilled}\n\n${block}`;
}
