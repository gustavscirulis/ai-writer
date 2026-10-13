import type { EmbedProvider } from "../embed-providers";

/** ```html embed: the `embed` flag keeps ordinary ```html snippets as code. */
export function isHtmlEmbedInfo(info: string): boolean {
  const [language, ...flags] = info.trim().toLowerCase().split(/\s+/);
  return language === "html" && flags.includes("embed");
}

export const htmlProvider: EmbedProvider = {
  id: "html",
  resolve: (source) =>
    source.type === "fence" && isHtmlEmbedInfo(source.info) && source.body.trim()
      ? { kind: "html", html: source.body }
      : null,
};
