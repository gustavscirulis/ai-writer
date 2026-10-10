import { expect, test } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import {
  feedbackTargets,
  feedbackTargetAt,
  mapFeedbackAnchor,
  recoverFeedbackAnchor,
} from "../src/lib/feedback-anchors";

test.each([
  ["A wrapped\nparagraph.", "Paragraph"],
  ["# Heading", "ATXHeading1"],
  ["Title\n===", "SetextHeading1"],
  ["- First\n- Second", "Paragraph"],
  ["- [ ] Task body", "Task"],
  ["> Quote\n> continued", "Paragraph"],
  ["```ts\nconst x = 1;\n```", "FencedCode"],
  ["```mermaid\ngraph LR\n A-->B\n```", "FencedCode"],
  ["    indented code", "CodeBlock"],
  ["| A | B |\n| - | - |\n| x | y |", "Table"],
  ["![Alt](file.png)", "Image"],
  ["$$x + y$$", "Math"],
  ["---\n\nBody", "HorizontalRule"],
  ["<div>HTML</div>", "HTMLBlock"],
  ["<details>\n<summary>Title</summary>\n\nBody\n</details>", "HTMLBlock"],
  ["<br/>", "HTMLBlock"],
  ["[link]: /somewhere", "LinkReference"],
  ["```\nunclosed", "FencedCode"],
])("targets %s as %s", (source, kind) => {
  const targets = feedbackTargets(source);
  expect(targets[0]?.kind).toBe(kind);
  expect(targets[0]?.text).toBe(source.slice(targets[0]!.from, targets[0]!.to));
});

test("nested prose resolves independent deepest blocks, and whitespace/frontmatter do not target", () => {
  const source = "---\ntitle: Note\n---\n\n# Heading\n\n- Parent\n  - Child\n\n> Quote\n\nBody";
  const targets = feedbackTargets(source);
  expect(targets.map((a) => a.text)).toEqual(["# Heading", "Parent", "Child", "Quote", "Body"]);
  expect(feedbackTargetAt(source, source.indexOf("title"))).toBeNull();
  expect(feedbackTargetAt(source, source.indexOf("\n\n") + 1)).toBeNull();
});

test("widget boundary side prefers ending block, not a following sibling", () => {
  const source = "```\ncode\n```\n\nNext";
  const first = feedbackTargets(source)[0]!;
  expect(feedbackTargetAt(source, first.to, -1)).toEqual(first);
});

test("local edits map anchors through insertions above and at paragraph edges", () => {
  let state = EditorState.create({ doc: "First\n\nTarget" });
  let target = feedbackTargets(state.doc.toString())[1]!;
  for (const change of [
    { from: 0, insert: "Above\n\n" },
    { from: 14, insert: "New " },
  ]) {
    const tr = state.update({ changes: change });
    target = mapFeedbackAnchor(target, tr.changes, feedbackTargets(tr.newDoc.toString()));
    expect(target.attached).toBe(true);
    state = tr.state;
  }
  expect(target.text).toBe("New Target");
});

test.each([
  { from: 3, insert: "\n\n" },
  { from: 0, to: 6, insert: "" },
  { from: 6, to: 8, insert: " " },
])("split, delete and merge detach targets (%j)", (changes) => {
  const state = EditorState.create({ doc: "Target\n\nOther" });
  const target = feedbackTargets(state.doc.toString())[0]!;
  const tr = state.update({ changes });
  expect(
    mapFeedbackAnchor(target, tr.changes, feedbackTargets(tr.newDoc.toString())).attached,
  ).toBe(false);
});

test("recovery uses full block text/context and refuses ambiguous identical paragraphs", () => {
  const repeated = "Repeated\n\n".repeat(50);
  const targets = feedbackTargets(repeated);
  const saved = targets[20]!;
  expect(recoverFeedbackAnchor(saved, targets).attached).toBe(false);
  const unique = feedbackTargets("First\n\nUnique\n\nLast")[1]!;
  const moved = recoverFeedbackAnchor(unique, feedbackTargets("Above\n\nFirst\n\nUnique\n\nLast"));
  expect(moved.attached).toBe(true);
  expect(moved.from).toBeGreaterThan(unique.from);
  expect(recoverFeedbackAnchor(unique, feedbackTargets("Unique merged with more")).attached).toBe(
    false,
  );
});

test("known deletion cannot recover onto another identical paragraph", () => {
  const saved = feedbackTargets("Same\n\nOther\n\nSame")[0]!;
  const surviving = feedbackTargets("Other\n\nSame");
  expect(recoverFeedbackAnchor(saved, surviving).attached).toBe(false);
  expect(
    recoverFeedbackAnchor({ ...saved, attached: false }, feedbackTargets("Same")).attached,
  ).toBe(false);
});
