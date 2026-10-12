import { useCallback, useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { VersionPreview } from "@/hooks/use-version-history";
import { firstChangePosition, historyPreviewState } from "./history-preview-extensions";

/** Mounts a read-only preview editor and swaps its state whenever the preview changes. */
export function useHistoryPreviewView(path: string, preview: VersionPreview | null) {
  const viewRef = useRef<EditorView | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const mount = useCallback((parent: HTMLDivElement | null) => {
    if (!parent) return;
    const view = new EditorView({ parent });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !preview) return;
    view.setState(historyPreviewState(preview.body, preview.original, () => pathRef.current));
    const target = firstChangePosition(view.state) ?? 0;
    view.dispatch({
      effects: EditorView.scrollIntoView(target, { y: target === 0 ? "start" : "center" }),
    });
  }, [preview]);

  return mount;
}
