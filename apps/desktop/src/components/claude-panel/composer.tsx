import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp02Icon, Cancel01Icon, ParagraphIcon, TextIcon } from "@hugeicons/core-free-icons";
import {
  sendChat,
  stopChat,
  useChatStatus,
  useChatError,
  useChatDraft,
  setChatDraft,
  clearChatDraftIfUnchanged,
  registerChatComposer,
  focusChatComposer,
} from "@/hooks/use-claude";
import {
  clearAttachedFeedback,
  consumeFeedback,
  removeFeedback,
  saveFeedbackNotes,
  useDocumentFeedback,
  type FeedbackItem,
} from "@/hooks/use-feedback";
import { clearAttachmentHighlight, highlightAttachment } from "@/hooks/feedback-api";
import { useActiveFilePath } from "@/hooks/use-tabs";
import { attachmentLabel } from "@/lib/feedback-anchors";
import { FeedbackError, NotesTray } from "./notes-tray";

const MAX_INPUT_HEIGHT = 180;
const KBD =
  "inline-block min-w-[18px] rounded bg-[var(--surface-subtle)] px-1 text-center text-[10.5px] font-medium leading-4 text-[var(--text-secondary)]";

function AttachmentChip({ item }: { item: FeedbackItem }) {
  const label = attachmentLabel(item.anchor, item.quote, 28);
  return (
    <span
      title={item.quote ?? item.anchor.text}
      onPointerEnter={() => highlightAttachment(item.path, item.anchor, item.quote)}
      onPointerLeave={clearAttachmentHighlight}
      className={`chat-enter inline-flex h-[22px] max-w-full items-center gap-1 rounded-md bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] pl-[7px] pr-[3px] text-[11.5px] text-[var(--text-secondary)] ${
        item.anchor.attached ? "" : "opacity-55"
      }`}
    >
      <HugeiconsIcon
        icon={item.quote ? TextIcon : ParagraphIcon}
        size={11}
        strokeWidth={2}
        className="shrink-0"
      />
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={() => {
          removeFeedback(item.path, item.id);
          clearAttachmentHighlight();
          focusChatComposer();
        }}
        className="grid size-4 shrink-0 place-items-center rounded text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] hover:text-[var(--text-primary)]"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
      </button>
    </span>
  );
}

export function Composer() {
  const path = useActiveFilePath();
  const text = useChatDraft(path);
  const status = useChatStatus();
  const error = useChatError();
  const items = useDocumentFeedback(path);
  const attached = useMemo(() => items.filter((item) => item.status === "attached"), [items]);
  const notes = useMemo(() => items.filter((item) => item.status !== "attached"), [items]);
  const [trayOpen, setTrayOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const setInput = useCallback((input: HTMLTextAreaElement | null) => {
    inputRef.current = input;
    registerChatComposer(input);
  }, []);
  const busy = status === "running" || status === "stopping";
  const retryLabel =
    status === "stopping" && error
      ? error.startsWith("Could not stop Claude Code:")
        ? "Retry Stop"
        : "Retry reload"
      : null;
  // WKWebView has no `field-sizing: content`, so grow the field from its scroll height.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [text]);
  const send = async () => {
    if (!path) return;
    const draft = text;
    const sent = attached;
    const ok = await sendChat(
      draft,
      sent.map((item) => ({ anchor: item.anchor, quote: item.quote })),
    );
    if (!ok) return;
    clearChatDraftIfUnchanged(path, draft);
    consumeFeedback(
      path,
      sent.map((item) => item.id),
    );
    clearAttachmentHighlight();
  };
  const saveNotes = () => {
    if (!path || !saveFeedbackNotes(path, text)) return;
    setChatDraft(path, "");
    setTrayOpen(true);
    clearAttachmentHighlight();
  };
  return (
    <form
      className="px-3 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {path && <FeedbackError />}
      {path && (
        <NotesTray
          path={path}
          notes={notes}
          open={trayOpen}
          onToggle={() => setTrayOpen(!trayOpen)}
          onTakeBack={(note) => {
            setChatDraft(path, text.trim() ? `${text.trimEnd()}\n${note}` : note);
            focusChatComposer();
          }}
        />
      )}
      <div className="rounded-[18px] border border-[var(--line-subtle)] bg-[var(--bg-base)] pb-2 [[data-theme=dark]_&]:bg-[var(--surface-subtle)] pl-3.5 pr-2.5 pt-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.05)] transition-colors duration-150 focus-within:border-[var(--focus-border)]">
        {attached.length > 0 && (
          <div className="mb-1.5 flex min-w-0 flex-wrap gap-1">
            {attached.map((item) => (
              <AttachmentChip key={item.id} item={item} />
            ))}
          </div>
        )}
        <textarea
          ref={setInput}
          aria-label="Message"
          placeholder={
            !path
              ? "Open a note to start"
              : attached.length
                ? "What should change here?"
                : "Ask about your writing…"
          }
          value={text}
          onChange={(event) => path && setChatDraft(path, event.target.value)}
          disabled={!path}
          rows={2}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || !path) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              saveNotes();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!busy) void send();
            } else if (event.key === "Backspace" && !text && attached.length) {
              event.preventDefault();
              removeFeedback(path, attached[attached.length - 1]!.id);
              clearAttachmentHighlight();
            } else if (event.key === "Escape" && attached.length) {
              event.preventDefault();
              clearAttachedFeedback(path);
              clearAttachmentHighlight();
            }
          }}
          className="block w-full resize-none overflow-y-auto bg-transparent text-[13.5px] leading-[1.55] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">
            {attached.length ? (
              <>
                <kbd className={KBD}>↵</kbd> change now · <kbd className={KBD}>⌘↵</kbd> save note
              </>
            ) : (
              path && "Select text or ⌥-click a paragraph to point at it"
            )}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            {attached.length > 0 && (
              <button
                type="button"
                title="Save as a note for the next pass (⌘↵)"
                disabled={!text.trim()}
                onClick={saveNotes}
                className="h-[26px] rounded-full px-[9px] text-[12px] font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Save note
              </button>
            )}
            {retryLabel ? (
              <button
                type="button"
                onClick={() => void stopChat()}
                className="h-7 rounded-full bg-[var(--surface-subtle)] px-3 text-[12px] text-[var(--text-primary)]"
              >
                {retryLabel}
              </button>
            ) : busy ? (
              <button
                type="button"
                aria-label={status === "stopping" ? "Stopping…" : "Stop"}
                title={status === "stopping" ? "Stopping…" : "Stop"}
                disabled={status === "stopping"}
                onClick={() => void stopChat()}
                className="grid size-7 place-items-center rounded-full bg-[var(--text-primary)] text-[var(--bg-base)] transition-[opacity,transform] duration-150 active:scale-[0.94] disabled:opacity-40"
              >
                <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-current" />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send"
                title="Send (Enter) · Shift+Enter for a new line"
                disabled={!path || !text.trim()}
                className="grid size-7 place-items-center rounded-full bg-[var(--text-primary)] text-[var(--bg-base)] transition-[opacity,transform] duration-150 active:scale-[0.94] disabled:opacity-20"
              >
                <HugeiconsIcon icon={ArrowUp02Icon} size={15} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
