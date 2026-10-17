import { closeVersionHistory, useVersionPreview } from "@/hooks/use-version-history";
import { EditorScrollContainer } from "@/components/editor-area/editor-scroll-container";
import { useHistoryPreviewView } from "./use-history-preview-view";
import "./version-history.css";

export function HistoryPreview({ path }: { path: string }) {
  const preview = useVersionPreview();
  const mount = useHistoryPreviewView(path, preview);
  return (
    <div
      data-history-preview
      className="absolute inset-0 z-20"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        closeVersionHistory();
      }}
    >
      <EditorScrollContainer>
        <div style={{ paddingTop: "var(--writer-editor-top-padding)" }} />
        <div ref={mount} className="min-h-full" />
        <div aria-hidden="true" className="h-28" />
      </EditorScrollContainer>
    </div>
  );
}
