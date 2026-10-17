import { useRef, useState, type PointerEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import {
  newChat,
  setChatPanelWidth,
  useChatPanelWidth,
  useChatPath,
  useChatStatus,
  useToolPermissions,
} from "@/hooks/use-claude";
import { PermissionRequest } from "./permission-request";
import { Composer } from "./composer";
import { MessageList } from "./message-list";

const HEADER_BUTTON =
  "grid size-7 place-items-center rounded-[7px] text-[var(--text-icon-muted)] transition-colors duration-150 hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] disabled:opacity-40";

export function clampChatWidth(width: number, maxWidth = window.innerWidth * 0.5) {
  return Math.max(260, Math.min(560, maxWidth, Math.round(width)));
}

export function ClaudePanel({ maxWidth }: { maxWidth: number }) {
  const width = useChatPanelWidth();
  const path = useChatPath();
  // A hidden window holds animations on their first frame, which would leave the panel invisible.
  const [animateIn] = useState(() => document.visibilityState === "visible");
  const status = useChatStatus(path);
  const awaitingApproval = useToolPermissions(path).length > 0;
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
      aria-label="Co-writer"
      className={`${animateIn ? "co-writer-panel-enter " : ""}relative flex h-full min-w-0 shrink-0 flex-col border-l border-[var(--line-subtler)] bg-[var(--bg)] text-[13px] text-[var(--text-primary)]`}
      style={{ width: "var(--agent-panel-width)" }}
    >
      <div
        role="separator"
        aria-label="Resize Co-writer"
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
      <header
        data-tauri-drag-region
        className="@container flex shrink-0 items-center gap-2 pl-[18px]"
        style={{
          height: "calc(var(--chrome-control-height) + var(--chrome-control-padding) * 2)",
          paddingBlock: "var(--chrome-control-padding)",
          // NoteTools sits over the right of this header and closes the panel.
          paddingRight: "calc(var(--note-tools-width, 0px) + 18px)",
        }}
      >
        <h2
          data-tauri-drag-region
          className="text-[13px] font-semibold text-[var(--text-primary)] @max-[104px]:hidden"
        >
          Co-writer
        </h2>
        <button
          type="button"
          title="New conversation"
          aria-label="New conversation"
          disabled={status === "stopping"}
          onClick={() => void newChat(path)}
          className={HEADER_BUTTON}
        >
          <HugeiconsIcon icon={PencilEdit02Icon} size={16} strokeWidth={1.8} />
        </button>
      </header>
      <MessageList key={`messages:${path}`} />
      {awaitingApproval ? (
        <PermissionRequest key={`permissions:${path}`} />
      ) : (
        <Composer key={`composer:${path}`} />
      )}
    </aside>
  );
}
