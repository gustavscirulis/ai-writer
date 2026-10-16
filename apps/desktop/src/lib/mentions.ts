export interface MentionMatch {
  query: string;
  /** Index of the `@`. */
  from: number;
  /** The caret, where the query ends. */
  to: number;
}

/** A note mentioned in the draft as `@label`. */
export interface Mention {
  path: string;
  label: string;
}

export interface MentionRange {
  from: number;
  to: number;
  path: string;
}

/** The word being typed after an `@` that starts the draft or follows whitespace. */
export function mentionQuery(text: string, caret: number): MentionMatch | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1]!;
  return { query, from: caret - query.length - 1, to: caret };
}

/** Replaces the typed `@query` or `/query` with a whole token, like `@label` or `/skill`. */
export function insertToken(text: string, match: MentionMatch, token: string) {
  const inserted = `${token} `;
  const rest = text.slice(match.to);
  return {
    text: text.slice(0, match.from) + inserted + (rest.startsWith(" ") ? rest.slice(1) : rest),
    caret: match.from + inserted.length,
  };
}

const WORD = /[\p{L}\p{N}_]/u;

/** Where each `@label` stands as a whole word; a longer label wins where two overlap. */
export function mentionRanges(text: string, mentions: Mention[]): MentionRange[] {
  const found: MentionRange[] = [];
  for (const { path, label } of mentions) {
    const token = `@${label}`;
    for (let from = text.indexOf(token); from !== -1; from = text.indexOf(token, from + 1)) {
      const to = from + token.length;
      if ((from === 0 || /\s/.test(text[from - 1]!)) && !WORD.test(text[to] ?? ""))
        found.push({ from, to, path });
    }
  }
  found.sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: MentionRange[] = [];
  for (const range of found) if (range.from >= (kept[kept.length - 1]?.to ?? 0)) kept.push(range);
  return kept;
}

/** The text cut into plain runs and pills, in order. */
export function splitMentions(text: string, ranges: MentionRange[]) {
  const parts: { from: number; text: string; path: string | null }[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.from > at) parts.push({ from: at, text: text.slice(at, range.from), path: null });
    parts.push({ from: range.from, text: text.slice(range.from, range.to), path: range.path });
    at = range.to;
  }
  if (at < text.length) parts.push({ from: at, text: text.slice(at), path: null });
  return parts;
}

/** Backspace or Delete next to a mention removes all of it. */
export function deleteMention(
  text: string,
  ranges: MentionRange[],
  caret: number,
  key: "Backspace" | "Delete",
) {
  const range = ranges.find((r) =>
    key === "Backspace" ? r.from < caret && caret <= r.to : r.from <= caret && caret < r.to,
  );
  if (!range) return null;
  return { text: text.slice(0, range.from) + text.slice(range.to), caret: range.from };
}

/** Moves a caret that landed inside a mention to the edge it was heading for, or the nearer one. */
export function snapOutOfMention(ranges: MentionRange[], caret: number, previous: number | null) {
  const range = ranges.find((r) => r.from < caret && caret < r.to);
  if (!range) return caret;
  if (previous === range.from) return range.to;
  if (previous === range.to) return range.from;
  return caret - range.from < range.to - caret ? range.from : range.to;
}
