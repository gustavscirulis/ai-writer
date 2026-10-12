import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getChunks, unifiedMergeView } from "@codemirror/merge";
import { prosemarkBasicSetup, prosemarkBaseThemeSetup } from "@/lib/prosemark-core/main";
import { headingWeightHighlight, writerMarkdown } from "@/components/editor-area/editor-extensions";
import { headingDecorations } from "@/components/editor-area/heading-decorations";
import { imageSrcResolver } from "@/components/editor-area/image-src-resolver";
import { mathDecorations } from "@/components/editor-area/math-decorations";
import { tableDecorations } from "@/components/editor-area/table-decorations";
import { viewportParsePlugin } from "@/components/editor-area/viewport-parse";

// A trailing empty line gives the parked selection somewhere to sit that
// touches no markdown node, so live-preview hiding renders the whole note.
function withTrailingNewline(text: string) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

// The live editor's rendering without anything that writes back to the note
// (store sync, feedback anchors, Mermaid's editable canvas, undo history).
function previewExtensions(original: string, getFilePath: () => string): Extension[] {
  return [
    writerMarkdown(),
    prosemarkBasicSetup(),
    prosemarkBaseThemeSetup(),
    headingWeightHighlight,
    viewportParsePlugin,
    tableDecorations(),
    mathDecorations(),
    headingDecorations,
    imageSrcResolver(getFilePath),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.transactionFilter.of((tr) => (tr.docChanged ? [] : tr)),
    unifiedMergeView({
      original: withTrailingNewline(original),
      mergeControls: false,
      allowInlineDiffs: true,
      gutter: false,
    }),
    EditorView.editorAttributes.of({ class: "writer-history-preview" }),
  ];
}

export function historyPreviewState(
  body: string,
  original: string,
  getFilePath: () => string,
): EditorState {
  const doc = withTrailingNewline(body);
  return EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: previewExtensions(original, getFilePath),
  });
}

/** Document position of the first change, or null when nothing changed. */
export function firstChangePosition(state: EditorState): number | null {
  return getChunks(state)?.chunks[0]?.fromB ?? null;
}
