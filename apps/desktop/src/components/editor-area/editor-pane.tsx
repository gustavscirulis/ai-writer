import type { EditorView } from "@codemirror/view";
import { ProseMarkEditor } from "./prosemark-editor";
import { FrontmatterPanel } from "./frontmatter-panel";
import { EditorScrollContainer } from "./editor-scroll-container";
import { EditorSearchOverview } from "./editor-search-overview";
import { SectionRail } from "./section-rail";
import { useCloseEditorSearchWhenInactive } from "./use-close-editor-search-when-inactive";
import { useIsFileLoading } from "@/hooks/use-tabs";
import { useHistoryPath } from "@/hooks/use-version-history";
import { HistoryPreview } from "@/components/version-history/history-preview";
import { memo, useCallback, useEffect, useRef, useState } from "react";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function AsciiSpinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return <span>{SPINNER_FRAMES[frame]}</span>;
}

interface EditorPaneProps {
  path: string;
  isActive: boolean;
}

export const EditorPane = memo(function EditorPane({ path, isActive }: EditorPaneProps) {
  const isLoading = useIsFileLoading(path);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Not the view itself: React's dev profiler walks props into window.frames, where sandboxed embeds throw.
  const [getView, setGetView] = useState<(() => EditorView) | null>(null);
  const handleViewChange = useCallback(
    (view: EditorView | null) => setGetView(view ? () => () => view : null),
    [],
  );
  const showsHistory = useHistoryPath() === path && isActive;
  useCloseEditorSearchWhenInactive(isActive);

  const getScrollContainer = useCallback(() => scrollContainerRef.current, []);

  if (isLoading) {
    return (
      <div
        className={
          isActive ? "relative z-10 h-full" : "absolute inset-0 invisible pointer-events-none"
        }
      >
        <div className="flex h-full items-center justify-center text-[13px] text-[var(--text-muted)]">
          <AsciiSpinner />
        </div>
      </div>
    );
  }

  return (
    <div
      data-pane
      className={
        isActive ? "relative z-10 h-full" : "absolute inset-0 invisible pointer-events-none"
      }
    >
      {/* The window background is translucent, so the preview can't simply cover the editor. */}
      <div className={showsHistory ? "invisible h-full" : "h-full"}>
        <EditorScrollContainer ref={scrollContainerRef}>
          <div
            className="mx-auto w-full"
            style={{
              maxWidth: "var(--writer-editor-outer-width)",
              boxSizing: "border-box",
              paddingTop: "var(--writer-editor-top-padding)",
              paddingLeft: "var(--writer-editor-side-padding)",
              paddingRight: "var(--writer-editor-side-padding)",
            }}
          >
            <FrontmatterPanel filePath={path} />
          </div>
          <ProseMarkEditor
            filePath={path}
            getScrollContainer={getScrollContainer}
            autoFocus={isActive}
            onViewChange={handleViewChange}
          />
        </EditorScrollContainer>
      </div>
      {!showsHistory && (
        <SectionRail filePath={path} getView={getView} scrollContainerRef={scrollContainerRef} />
      )}
      {isActive && <EditorSearchOverview scrollContainerRef={scrollContainerRef} />}
      {showsHistory && <HistoryPreview path={path} />}
    </div>
  );
});
