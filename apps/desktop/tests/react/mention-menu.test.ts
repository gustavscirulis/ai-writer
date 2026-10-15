import { expect, test } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MentionMenu } from "../../src/components/claude-panel/mention-menu";

const file = (relative: string) => ({
  path: `/vault/${relative}`,
  filename: relative.slice(relative.lastIndexOf("/") + 1),
  relative_path: relative,
  score: 0,
  match_indices: [],
});

test("lists each note by name with its folder, marking the active one", () => {
  const html = renderToStaticMarkup(
    createElement(MentionMenu, {
      files: [file("Style guide.md"), file("Research/Interviews/Plan.md")],
      active: 1,
      onActive: () => {},
      onPick: () => {},
    }),
  );
  for (const text of [
    'role="listbox" aria-label="Files"',
    'id="co-writer-mentions-0" role="option" aria-selected="false"',
    'id="co-writer-mentions-1" role="option" aria-selected="true"',
    ">Style guide<",
    ">Plan<",
    ">Research/Interviews<",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain(".md");
});
