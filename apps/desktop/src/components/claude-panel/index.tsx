import { useRef, type PointerEvent } from "react";
import {
  newChat,
  setChatPanelWidth,
  toggleChatPanel,
  useChatPanelWidth,
  useChatStatus,
} from "@/hooks/use-claude";
import { PermissionRequest } from "./permission-request";
import { Composer } from "./composer";
import { MessageList } from "./message-list";

export function clampChatWidth(width: number, maxWidth = window.innerWidth * 0.5) {
  return Math.max(260, Math.min(560, maxWidth, Math.round(width)));
}

export function ClaudePanel({ maxWidth }: { maxWidth: number }) {
  const width = useChatPanelWidth();
  const status = useChatStatus();
  const drag = useRef<{ x: number; width: number; current: number } | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const setDraft = (next: number) =>
    rootRef.current
      ?.closest<HTMLElement>("[data-app-layout]")
      ?.style.setProperty("--agent-panel-width", `${next}px`);
  const finishResize = (event: PointerEvent<HTMLDivElement>, persist: boolean) => {
    if (!drag.current) return;
    const next = drag.current.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (persist) void setChatPanelWidth(next);
    else setDraft(clampChatWidth(width, maxWidth));
  };
  return (
    <aside
      ref={rootRef}
      aria-label="Chat panel"
      className="relative flex h-full min-w-0 shrink-0 flex-col border-l border-[var(--line-subtle)] bg-[var(--bg)] pt-[var(--chrome-drag-height)]"
      style={{ width: "var(--agent-panel-width)" }}
    >
      <div
        role="separator"
        aria-label="Resize chat panel"
        aria-orientation="vertical"
        aria-valuemin={260}
        aria-valuemax={maxWidth}
        aria-valuenow={clampChatWidth(width, maxWidth)}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-50 w-2 cursor-col-resize outline-none focus-visible:bg-[var(--line-subtle)]"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            void setChatPanelWidth(
              clampChatWidth(width + (event.key === "ArrowLeft" ? 20 : -20), maxWidth),
            );
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            x: event.clientX,
            width: clampChatWidth(width, maxWidth),
            current: clampChatWidth(width, maxWidth),
          };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          drag.current.current = clampChatWidth(
            drag.current.width + drag.current.x - event.clientX,
            maxWidth,
          );
          setDraft(drag.current.current);
        }}
        onPointerUp={(event) => finishResize(event, true)}
        onPointerCancel={(event) => finishResize(event, false)}
      />
      <header className="flex items-center justify-between gap-3 border-b border-[var(--line-subtle)] px-5 py-3">
        <div>
          <h2 className="text-[13px] font-medium">Chat</h2>
          <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">
            Using Claude Code · experimental
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
          <button
            type="button"
            disabled={status === "stopping"}
            onClick={() => void newChat()}
            className="hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            New chat
          </button>
          <button
            type="button"
            onClick={toggleChatPanel}
            aria-label="Close chat panel"
            className="rounded px-1 text-[16px] hover:text-[var(--text-primary)]"
          >
            ×
          </button>
        </div>
      </header>
      <MessageList />
      <PermissionRequest />
      <Composer />
    </aside>
  );
}
