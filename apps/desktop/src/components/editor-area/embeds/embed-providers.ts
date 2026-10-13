import { htmlProvider } from "./providers/html";

/** What the markdown says: a fenced block, or the destination of `![](…)`. */
export type EmbedSource =
  | { type: "fence"; info: string; body: string }
  | { type: "url"; url: string };

/** What the widget draws. Providers only map a source to one of these; the
 *  widget owns rendering, sizing and sandboxing. */
export type EmbedSpec = { kind: "html"; html: string };

export interface EmbedProvider {
  id: string;
  resolve(source: EmbedSource): EmbedSpec | null;
}

const providers: readonly EmbedProvider[] = [htmlProvider];

export function resolveEmbed(source: EmbedSource): EmbedSpec | null {
  for (const provider of providers) {
    const spec = provider.resolve(source);
    if (spec) return spec;
  }
  return null;
}
