import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { useFeedbackStore, captureFeedbackPathRewrite } from "@/stores/feedback-store";
import { getEditorView } from "@/lib/editor-views";
import {
  attachmentRange,
  feedbackTargetAt,
  feedbackTargets,
  recoverFeedbackAnchor,
  type FeedbackAnchor,
} from "@/lib/feedback-anchors";
import { findOuterScroller, scrollPosToSafeTop } from "@/components/editor-area/editor-scroll";
import { focusChatComposer, showChatPanel } from "@/hooks/use-claude";

export const feedbackState = () => useFeedbackStore.getState();
export { captureFeedbackPathRewrite };

function attach(path: string, targets: { anchor: FeedbackAnchor; quote: string | null }[]) {
  if (!targets.length) return false;
  for (const { anchor, quote } of targets)
    if (!feedbackState().attach(path, anchor, quote)) return false;
  showChatPanel();
  focusChatComposer();
  return true;
}

export const attachBlock = (path: string, target: FeedbackAnchor) =>
  attach(path, [{ anchor: target, quote: null }]);

/** A selection inside one block attaches as a quote, one across blocks attaches each block, and a caret attaches its block. */
export function attachFromEditor(path: string, view: EditorView | undefined = getEditorView(path)) {
  if (!view) return false;
  const source = view.state.doc.toString();
  const { from, to, head } = view.state.selection.main;
  let targets: { anchor: FeedbackAnchor; quote: string | null }[];
  if (from === to) {
    const target = feedbackTargetAt(source, head) ?? feedbackTargetAt(source, head, -1);
    targets = target ? [{ anchor: target, quote: null }] : [];
  } else {
    const blocks = feedbackTargets(source).filter((target) => target.from < to && target.to > from);
    const quote = source.slice(from, to).trim();
    targets =
      blocks.length === 1 && quote && quote !== blocks[0]!.text.trim()
        ? [{ anchor: blocks[0]!, quote }]
        : blocks.map((anchor) => ({ anchor, quote: null }));
  }
  if (!attach(path, targets)) return false;
  if (from !== to) view.dispatch({ selection: EditorSelection.cursor(to) });
  return true;
}

/** Finds a sent or saved attachment in the note as it reads now; null once its text is gone. */
function resolveAttachment(path: string, anchor: FeedbackAnchor) {
  const view = getEditorView(path);
  if (!view) return null;
  if (anchor.attached && view.state.sliceDoc(anchor.from, anchor.to) === anchor.text) return anchor;
  const found = recoverFeedbackAnchor(anchor, feedbackTargets(view.state.doc.toString()));
  return found.attached ? found : null;
}

export function highlightAttachment(path: string, anchor: FeedbackAnchor, quote: string | null) {
  const target = resolveAttachment(path, anchor);
  feedbackState().highlight(target ? { path, ...attachmentRange(target, quote) } : null);
}

export const clearAttachmentHighlight = () => feedbackState().highlight(null);

export function revealAttachment(path: string, anchor: FeedbackAnchor) {
  const view = getEditorView(path);
  const target = resolveAttachment(path, anchor);
  const scroller = view && findOuterScroller(view.dom);
  if (view && target && scroller) scrollPosToSafeTop(view, scroller, target.from, "auto");
}
