import type { SyntaxNodeRef } from "@lezer/common";

/**
 * Extract info string and code content for a FencedCode node. Lezer's tree:
 *   FencedCode → CodeMark, CodeInfo, CodeText, CodeMark
 * Multiple CodeText children can occur (e.g. blockquoted fences); we
 * concatenate their slices.
 */
export function parseFencedCode(
  state: { doc: { sliceString(from: number, to: number): string } },
  node: SyntaxNodeRef,
): { info: string; source: string; closed: boolean } | undefined {
  let info = "";
  let source = "";
  let marks = 0;

  let child = node.node.firstChild;
  while (child) {
    if (child.name === "CodeInfo") {
      info = state.doc.sliceString(child.from, child.to);
    } else if (child.name === "CodeText") {
      source += state.doc.sliceString(child.from, child.to);
    } else if (child.name === "CodeMark") {
      marks++;
    }
    child = child.nextSibling;
  }

  if (!info) return undefined;
  // Opening and closing fence are both CodeMarks; an unclosed fence (still
  // being typed) runs to the end of the document with only the opening one.
  return { info, source, closed: marks >= 2 };
}
