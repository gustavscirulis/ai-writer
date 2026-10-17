import { useCallback, useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { VersionPreview } from "@/hooks/use-version-history";
import { findOuterScroller, scrollPosToSafeTop } from "@/components/editor-area/editor-scroll";
import { firstChangePosition, historyPreviewState } from "./history-preview-extensions";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Versions swapped in quicker than this are being scrubbed through, not read. */
const SCRUB_MS = 300;

/** Mounts a read-only preview editor and swaps its state whenever the preview changes. */
export function useHistoryPreviewView(path: string, preview: VersionPreview | null) {
  const viewRef = useRef<EditorView | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const shownRef = useRef(false);
  const swappedAtRef = useRef(0);

  const mount = useCallback((parent: HTMLDivElement | null) => {
    if (!parent) return;
    const view = new EditorView({ parent });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
      shownRef.current = false;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !preview) return;
    view.setState(historyPreviewState(preview.body, preview.original, () => pathRef.current));
    const target = firstChangePosition(view.state) ?? 0;
    const now = performance.now();
    const scrubbing = now - swappedAtRef.current < SCRUB_MS;
    swappedAtRef.current = now;
    // While scrubbing, highlights and scroll keep up instead of restarting their animations.
    view.dom.parentElement?.toggleAttribute("data-scrubbing", scrubbing);
    const behavior = shownRef.current && !scrubbing && !reducedMotion() ? "smooth" : "auto";
    shownRef.current = true;
    view.requestMeasure({
      read: () => findOuterScroller(view.dom),
      write: (scroller) => scroller && scrollPosToSafeTop(view, scroller, target, behavior),
    });
  }, [preview]);

  return mount;
}
