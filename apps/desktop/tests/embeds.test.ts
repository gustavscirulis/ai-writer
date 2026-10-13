import { describe, expect, test } from "vite-plus/test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { foldExtension } from "../src/lib/prosemark-core/main";
import { embedDecorations } from "../src/components/editor-area/embeds/embed-decorations";
import { resolveEmbed } from "../src/components/editor-area/embeds/embed-providers";
import { EmbedWidget } from "../src/components/editor-area/embeds/embed-widget";
import {
  clampFrameHeight,
  MAX_FRAME_HEIGHT,
  MIN_FRAME_HEIGHT,
  parseFrameMessage,
} from "../src/components/editor-area/embeds/frame-messages";

function embedWidgets(doc: string, anchor = 0, head = anchor) {
  let state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), embedDecorations()],
    selection: EditorSelection.single(anchor, head),
  });
  ensureSyntaxTree(state, doc.length, 1000);
  state = state.update({ selection: state.selection }).state;
  const found: { widget: EmbedWidget; replaced: boolean }[] = [];
  state.field(foldExtension).between(0, state.doc.length, (from, to, decoration) => {
    const widget = (decoration.spec as { widget?: unknown }).widget;
    if (widget instanceof EmbedWidget) found.push({ widget, replaced: to > from });
  });
  return found;
}

describe("html embed fences", () => {
  const embed = "intro\n\n```html embed\n<p>hi</p>\n```\n\nafter";

  test("an `html embed` fence renders as a replaced embed", () => {
    const [found] = embedWidgets(embed);
    expect(found.widget.spec).toEqual({ kind: "html", html: "<p>hi</p>" });
    expect(found.replaced).toBe(true);
  });

  test("the source shows above the embed while the caret is inside", () => {
    const [found] = embedWidgets(embed, embed.indexOf("<p>"));
    expect(found.replaced).toBe(false);
    expect(found.widget.mode).toBe("editing");
  });

  test("a selection spanning the whole fence selects the embed without opening its source", () => {
    const from = embed.indexOf("```");
    const to = embed.lastIndexOf("```") + 3;
    for (const [anchor, head] of [
      [from, to],
      [to, from],
      [0, embed.length],
    ]) {
      const [found] = embedWidgets(embed, anchor, head);
      expect(found.replaced).toBe(true);
      expect(found.widget.mode).toBe("selected");
    }
  });

  test("a selection that ends inside the fence opens its source", () => {
    const [found] = embedWidgets(embed, 0, embed.indexOf("<p>"));
    expect(found.replaced).toBe(false);
    expect(found.widget.mode).toBe("editing");
  });

  test.each([
    ["a plain html fence", "```html\n<p>hi</p>\n```"],
    ["an unclosed fence", "```html embed\n<p>hi</p>"],
    ["an empty fence", "```html embed\n\n```"],
    ["another language", "```js embed\nalert(1)\n```"],
  ])("%s stays as code", (_name, doc) => {
    expect(embedWidgets(doc)).toHaveLength(0);
  });

  test("the info string is matched case-insensitively with extra flags", () => {
    expect(resolveEmbed({ type: "fence", info: " HTML  embed wide", body: "<b>x</b>" })).toEqual({
      kind: "html",
      html: "<b>x</b>",
    });
  });
});

describe("frame messages", () => {
  test.each([
    [{ source: "writer-embed", type: "ready" }, { type: "ready" }],
    [
      { source: "writer-embed", type: "height", height: 120 },
      { type: "height", height: 120 },
    ],
    [
      { source: "writer-embed", type: "error", message: "boom" },
      { type: "error", message: "boom" },
    ],
  ])("accepts %j", (data, expected) => {
    expect(parseFrameMessage(data)).toEqual(expected);
  });

  test.each([
    null,
    "ready",
    { type: "ready" },
    { source: "other", type: "ready" },
    { source: "writer-embed", type: "render", html: "" },
    { source: "writer-embed", type: "height", height: "120" },
    { source: "writer-embed", type: "height", height: Number.POSITIVE_INFINITY },
    { source: "writer-embed", type: "error", message: 1 },
  ])("rejects %j", (data) => {
    expect(parseFrameMessage(data)).toBeNull();
  });

  test("heights are clamped so embed code can't blow up the note", () => {
    expect(clampFrameHeight(0)).toBe(MIN_FRAME_HEIGHT);
    expect(clampFrameHeight(10_000_000)).toBe(MAX_FRAME_HEIGHT);
    expect(clampFrameHeight(120.2)).toBe(121);
  });
});
