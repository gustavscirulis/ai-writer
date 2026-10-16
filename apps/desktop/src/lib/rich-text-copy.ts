import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EditorView } from "@codemirror/view";
import { writeHtml } from "@tauri-apps/plugin-clipboard-manager";
import { getParentDir, resolveImagePath } from "@/lib/paths";
import { readImageDataUrl } from "@/lib/tauri";

const isSelfContained = (src: string) => /^(https?:|data:)/i.test(src);

function urlTransform(url: string, key: string) {
  return key === "src" && url.startsWith("data:image/") ? url : defaultUrlTransform(url);
}

function render(markdown: string, img: Components["img"]) {
  return renderToStaticMarkup(
    createElement(
      Markdown,
      { remarkPlugins: [remarkGfm], urlTransform, components: { img } },
      markdown,
    ),
  );
}

/** Render markdown to an HTML fragment for pasting into other apps. Local
 *  images are inlined as data URLs because other apps can't load `asset://`;
 *  an image that can't be read falls back to its alt text. */
export async function renderMarkdownToHtml(markdown: string, markdownDir: string): Promise<string> {
  const localSources = new Set<string>();
  render(markdown, ({ src }) => {
    if (typeof src === "string" && src && !isSelfContained(src)) localSources.add(src);
    return null;
  });

  const dataUrls = new Map(
    await Promise.all(
      [...localSources].map(async (src) => {
        try {
          return [src, await readImageDataUrl(resolveImagePath(src, markdownDir))] as const;
        } catch (error) {
          console.warn(`[rich-text-copy] could not embed image ${src}`, error);
          return [src, null] as const;
        }
      }),
    ),
  );

  return render(markdown, ({ node: _node, src, alt, ...props }) => {
    if (typeof src !== "string" || !dataUrls.has(src))
      return createElement("img", { ...props, src, alt });
    const dataUrl = dataUrls.get(src);
    return dataUrl ? createElement("img", { ...props, src: dataUrl, alt }) : (alt ?? null);
  });
}

/** Copy the editor's main selection to the clipboard as HTML, with the
 *  markdown source as the plain-text fallback. No-op on an empty selection. */
export async function copySelectionAsRichText(view: EditorView, path: string) {
  const { from, to } = view.state.selection.main;
  if (from === to) return;
  const markdown = view.state.sliceDoc(from, to);
  const html = await renderMarkdownToHtml(markdown, getParentDir(path));
  await writeHtml(html, markdown);
}
