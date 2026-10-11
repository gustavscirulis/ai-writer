import type { BlockParser, BlockContext, Line, MarkdownConfig } from "@lezer/markdown";

/**
 * Custom block parser that recognizes self-closing HTML tags (e.g. <br/>, <img ... />)
 * as HTML blocks. The Lezer Type 7 regex doesn't handle self-closing syntax.
 */
const selfClosingBlockParser: BlockParser = {
  name: "SelfClosingHTMLBlock",
  before: "HTMLBlock",
  parse(cx: BlockContext, line: Line) {
    if (line.text.charCodeAt(line.pos) !== 60 /* '<' */) return false;
    if (!/^\s*<[a-z][\w-]*(?:\s+[^>]*)?\s*\/\s*>\s*$/i.test(line.text)) return false;
    const from = cx.lineStart + line.pos;
    cx.nextLine();
    cx.addElement(cx.elt("HTMLBlock", from, cx.prevLineEnd()));
    return true;
  },
};

/**
 * Custom block parser for <details> blocks. The default Type 6 parser ends at
 * blank lines, but <details> should consume everything until </details>.
 */
const detailsBlockParser: BlockParser = {
  name: "DetailsHTMLBlock",
  before: "HTMLBlock",
  parse(cx: BlockContext, line: Line) {
    if (!/^\s*<details(?:\s|>|$)/i.test(line.text)) return false;
    const from = cx.lineStart + line.pos;
    const endPattern = /<\/details\s*>/i;
    while (!endPattern.test(line.text) && cx.nextLine()) {
      // continue consuming lines until </details>
    }
    cx.nextLine();
    cx.addElement(cx.elt("HTMLBlock", from, cx.prevLineEnd()));
    return true;
  },
};

export const htmlBlockParserExtension: MarkdownConfig = {
  parseBlock: [detailsBlockParser, selfClosingBlockParser],
};
