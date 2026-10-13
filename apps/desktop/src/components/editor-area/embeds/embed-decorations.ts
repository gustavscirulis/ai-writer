import type { EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { foldableSyntaxFacet } from "@/lib/prosemark-core/main";
import { parseFencedCode } from "../fenced-code";
import { resolveEmbed } from "./embed-providers";
import { type EmbedMode, EmbedWidget } from "./embed-widget";

// Replace ↔ widget, like images: the source shows above the live embed while
// the caret is in it.
const fenceEmbeds = foldableSyntaxFacet.of({
  nodePath: "FencedCode",
  keepDecorationOnUnfold: true,
  buildDecorations: (state, node, selectionTouchesRange) => {
    const fence = parseFencedCode(state, node);
    // An unclosed fence is still being typed; replacing it would swallow the
    // caret's line.
    if (!fence?.closed) return undefined;
    const spec = resolveEmbed({ type: "fence", info: fence.info, body: fence.source });
    if (!spec) return undefined;
    const mode = embedMode(state, node, selectionTouchesRange);
    const widget = new EmbedWidget(spec, "FencedCode", mode);
    return mode === "editing"
      ? Decoration.widget({ widget, block: true, side: 1 }).range(node.to)
      : Decoration.replace({ widget, block: true, inclusiveStart: true }).range(node.from, node.to);
  },
});

/** A selection spanning the whole embed selects it as a block; only a
 *  selection that ends inside its source opens that source for editing. */
export function embedMode(
  state: EditorState,
  node: { from: number; to: number },
  touches: boolean,
): EmbedMode {
  if (!touches) return "view";
  const covered = state.selection.ranges
    .filter((range) => range.from <= node.to && node.from <= range.to)
    .every((range) => range.from <= node.from && range.to >= node.to);
  return covered ? "selected" : "editing";
}

export function embedDecorations() {
  return [fenceEmbeds];
}
