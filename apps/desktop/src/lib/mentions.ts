export interface MentionMatch {
  query: string;
  /** Index of the `@`. */
  from: number;
  /** The caret, where the query ends. */
  to: number;
}

/** The word being typed after an `@` that starts the draft or follows whitespace. */
export function mentionQuery(text: string, caret: number): MentionMatch | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1]!;
  return { query, from: caret - query.length - 1, to: caret };
}

export function insertMention(text: string, match: MentionMatch, label: string) {
  const mention = `@${label} `;
  const rest = text.slice(match.to);
  return {
    text: text.slice(0, match.from) + mention + (rest.startsWith(" ") ? rest.slice(1) : rest),
    caret: match.from + mention.length,
  };
}
