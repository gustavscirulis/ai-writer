import { beforeEach, expect, test, vi } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeHtml: vi.fn() }));
vi.mock("../src/lib/tauri", () => ({ readImageDataUrl: vi.fn() }));

import { writeHtml } from "@tauri-apps/plugin-clipboard-manager";
import { readImageDataUrl } from "../src/lib/tauri";
import { copySelectionAsRichText, renderMarkdownToHtml } from "../src/lib/rich-text-copy";

beforeEach(() => vi.resetAllMocks());

const viewWith = (doc: string, anchor: number, head: number) =>
  ({ state: EditorState.create({ doc, selection: { anchor, head } }) }) as unknown as EditorView;

test("renders GFM formatting to HTML", async () => {
  const html = await renderMarkdownToHtml(
    "# Title\n\n**Bold** and ~~gone~~\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
    "/notes",
  );
  expect(html).toContain("<h1>Title</h1>");
  expect(html).toContain("<strong>Bold</strong>");
  expect(html).toContain("<del>gone</del>");
  expect(html).toContain("<li>one</li>");
  expect(html).toContain("<td>2</td>");
});

test("inlines local images as data URLs and leaves remote ones alone", async () => {
  vi.mocked(readImageDataUrl).mockResolvedValue("data:image/png;base64,AQID");

  const html = await renderMarkdownToHtml(
    "![local](note%20assets/pic.png) ![remote](https://example.com/a.png)",
    "/notes",
  );

  expect(readImageDataUrl).toHaveBeenCalledExactlyOnceWith("/notes/note assets/pic.png");
  expect(html).toContain('<img src="data:image/png;base64,AQID" alt="local"/>');
  expect(html).toContain('<img src="https://example.com/a.png" alt="remote"/>');
});

test("an image that can't be read falls back to its alt text", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(readImageDataUrl).mockRejectedValue(new Error("missing"));

  const html = await renderMarkdownToHtml("Before ![a diagram](gone.png) after", "/notes");

  expect(html).toBe("<p>Before a diagram after</p>");
});

test("copies the selection as HTML with the markdown as plain text", async () => {
  await copySelectionAsRichText(viewWith("intro **bold** outro", 6, 14), "/notes/a.md");

  expect(writeHtml).toHaveBeenCalledExactlyOnceWith("<p><strong>bold</strong></p>", "**bold**");
});

test("does nothing without a selection", async () => {
  await copySelectionAsRichText(viewWith("intro **bold**", 3, 3), "/notes/a.md");

  expect(writeHtml).not.toHaveBeenCalled();
});
