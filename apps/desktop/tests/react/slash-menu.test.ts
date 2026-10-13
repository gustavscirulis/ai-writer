import { expect, test } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SlashMenu } from "../../src/components/claude-panel/slash-menu";

test("lists each skill with its argument hint and description, marking the active one", () => {
  const html = renderToStaticMarkup(
    createElement(SlashMenu, {
      skills: [
        { name: "ux-copy", description: "Write UX copy", argumentHint: "", aliases: [] },
        { name: "pdf", description: "", argumentHint: "<file>", aliases: [] },
      ],
      active: 1,
      onActive: () => {},
      onPick: () => {},
    }),
  );
  for (const text of [
    'role="listbox"',
    'id="co-writer-skills-0" role="option" aria-selected="false"',
    'id="co-writer-skills-1" role="option" aria-selected="true"',
    "/ux-copy",
    "Write UX copy",
    "/pdf",
    "&lt;file&gt;",
  ])
    expect(html).toContain(text);
});
