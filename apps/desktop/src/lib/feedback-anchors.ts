import { parser, GFM } from "@lezer/markdown";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { ChangeDesc } from "@codemirror/state";
import { prosemarkMarkdownSyntaxExtensions } from "@/lib/prosemark-core/markdown";
import { htmlBlockParserExtension } from "@/lib/prosemark-core/markdown/htmlBlock";

const feedbackParser = parser.configure([
  GFM,
  prosemarkMarkdownSyntaxExtensions,
  htmlBlockParserExtension,
]);
const BLOCKS = new Set([
  "Paragraph",
  "Task",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
  "FencedCode",
  "CodeBlock",
  "Table",
  "HTMLBlock",
  "HorizontalRule",
  "LinkReference",
]);

export interface FeedbackAnchor {
  kind: string;
  from: number;
  to: number;
  text: string;
  before: string;
  after: string;
  attached: boolean;
  occurrences: number;
}

function anchor(source: string, node: SyntaxNode): FeedbackAnchor {
  let kind = node.name;
  if (kind === "Paragraph") {
    const image = node.getChild("Image"),
      math = node.getChild("Math");
    if (image?.from === node.from && image.to === node.to) kind = "Image";
    else if (
      math?.from === node.from &&
      math.to === node.to &&
      source.slice(math.from, math.from + 2) === "$$"
    )
      kind = "Math";
  }
  return {
    kind,
    from: node.from,
    to: node.to,
    text: source.slice(node.from, node.to),
    before: source.slice(Math.max(0, node.from - 80), node.from),
    after: source.slice(node.to, node.to + 80),
    attached: true,
    occurrences: 1,
  };
}

/** The same parser config as Writer; atomic widgets never expose nested targets. */
export function feedbackTargets(source: string, tree: Tree = feedbackParser.parse(source)) {
  const targets: FeedbackAnchor[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.name === "Frontmatter") return;
    if (BLOCKS.has(node.name)) {
      if (source.slice(node.from, node.to).trim()) targets.push(anchor(source, node));
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(tree.topNode);
  const counts = new Map<string, number>();
  for (const target of targets) {
    const key = `${target.kind}:${target.text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const target of targets) target.occurrences = counts.get(`${target.kind}:${target.text}`)!;
  return targets;
}

export function feedbackTargetAt(source: string, pos: number, side: -1 | 1 = 1) {
  const targets = feedbackTargets(source);
  return (
    targets.find((target) =>
      side === -1 ? target.from < pos && pos <= target.to : target.from <= pos && pos < target.to,
    ) ?? null
  );
}

/** Recovery never trusts old offsets or chooses the nearest identical paragraph. */
export function recoverFeedbackAnchor(
  saved: FeedbackAnchor,
  targets: FeedbackAnchor[],
): FeedbackAnchor {
  if (!saved.attached) return saved;
  const matches = targets.filter(
    (target) => target.kind === saved.kind && target.text === saved.text,
  );
  if (matches.length === 1 && saved.occurrences === 1) return matches[0]!;
  const contextual = matches.filter(
    (target) => target.before === saved.before && target.after === saved.after,
  );
  return contextual.length === 1 ? contextual[0]! : { ...saved, attached: false };
}

export function mapFeedbackAnchor(
  saved: FeedbackAnchor,
  changes: ChangeDesc,
  targets: FeedbackAnchor[],
): FeedbackAnchor {
  if (!saved.attached) return saved;
  // Inclusive bounds allow typing at paragraph edges; exclusive bounds allow a
  // sibling inserted exactly at an edge. Neither accepts a split/merged block.
  for (const [left, right] of [
    [-1, 1],
    [1, -1],
  ] as const) {
    const from = changes.mapPos(saved.from, left),
      to = changes.mapPos(saved.to, right);
    if (to <= from) continue;
    const candidate = targets.find(
      (target) => target.kind === saved.kind && target.from === from && target.to === to,
    );
    if (candidate) return candidate;
  }
  return { ...saved, attached: false };
}

export function feedbackTargetLabel(target: FeedbackAnchor) {
  const heading = /Heading/.test(target.kind);
  const names: Record<string, string> = {
    Paragraph: "Paragraph",
    Task: "Task",
    FencedCode: "Code block",
    CodeBlock: "Code block",
    HTMLBlock: "HTML block",
    HorizontalRule: "Divider",
    LinkReference: "Link definition",
    Math: "Math",
    Image: "Image",
    Table: "Table",
  };
  return heading ? "Heading" : (names[target.kind] ?? "Block");
}

/** A quote locates itself inside its block; if the block text moved on, the whole block stands in. */
export function attachmentRange(target: FeedbackAnchor, quote: string | null) {
  const index = quote ? target.text.indexOf(quote) : -1;
  return index < 0 || !quote
    ? { from: target.from, to: target.to }
    : { from: target.from + index, to: target.from + index + quote.length };
}

const PROSE = /^(Paragraph|Task|ATXHeading\d|SetextHeading\d)$/;

export function attachmentLabel(target: FeedbackAnchor, quote: string | null, length = 32) {
  const clip = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat;
  };
  if (quote) return `“${clip(quote)}”`;
  if (!PROSE.test(target.kind)) return feedbackTargetLabel(target);
  return clip(target.text.replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[.\]\s+)?|\d+[.)]\s+)/, ""));
}
