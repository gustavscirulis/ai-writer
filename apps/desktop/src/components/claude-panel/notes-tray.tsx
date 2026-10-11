import { useActiveFilePath } from "@/hooks/use-tabs";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  acknowledgeFeedback,
  applyFeedback,
  canApplyFeedback,
  dismissFeedbackError,
  removeFeedback,
  retryFeedbackPersistence,
  takeBackFeedback,
  useFeedbackError,
  type FeedbackItem,
} from "@/hooks/use-feedback";
import {
  clearAttachmentHighlight,
  highlightAttachment,
  revealAttachment,
} from "@/hooks/feedback-api";
import { useChatStatus } from "@/hooks/use-claude";
import { attachmentLabel } from "@/lib/feedback-anchors";

const LINK = "text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40";

export function FeedbackError() {
  const path = useActiveFilePath();
  const error = useFeedbackError(path);
  if (!error) return null;
  const persistence = error.startsWith("Could not ") && error.includes("feedback");
  return (
    <p
      role="alert"
      className="chat-rise mb-2 flex items-start gap-2 px-1 text-[12px] leading-normal text-[var(--text-secondary)]"
    >
      <span className="min-w-0 flex-1">
        {error}{" "}
        {persistence && (
          <button type="button" onClick={() => void retryFeedbackPersistence()} className={LINK}>
            Retry
          </button>
        )}
      </span>
      {!persistence && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => path && dismissFeedbackError(path)}
          className="grid size-5 shrink-0 place-items-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
        </button>
      )}
    </p>
  );
}

/** Notes saved for the next pass, collapsed above the composer. */
export function NotesTray({
  path,
  notes,
  open,
  onToggle,
  onTakeBack,
}: {
  path: string;
  notes: FeedbackItem[];
  open: boolean;
  onToggle: () => void;
  onTakeBack: (text: string) => void;
}) {
  const status = useChatStatus(path);
  const busy = status === "running" || status === "stopping";
  const ready = notes.filter(canApplyFeedback);
  if (!notes.length) return null;
  return (
    <div className="chat-rise mb-2 overflow-hidden rounded-[14px] border border-[var(--line-subtle)] bg-[var(--bg-base)] [[data-theme=dark]_&]:bg-[var(--surface-subtle)]">
      <div className="flex items-center justify-between gap-2 py-[5px] pl-2.5 pr-[5px]">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex h-[26px] min-w-0 items-center gap-1.5 text-[12.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <HugeiconsIcon
            icon={open ? ArrowDown01Icon : ArrowUp01Icon}
            size={13}
            strokeWidth={2}
            className="shrink-0"
          />
          <span className="truncate">
            {notes.length} {notes.length === 1 ? "note" : "notes"} for the next pass
          </span>
        </button>
        <button
          type="button"
          title="Have Claude make every saved note in one pass"
          disabled={busy || !ready.length}
          onClick={() =>
            void applyFeedback(
              path,
              ready.map((item) => item.id),
            )
          }
          className="h-[26px] shrink-0 rounded-full bg-[var(--text-primary)] px-[11px] text-[12px] font-medium text-[var(--bg-base)] transition-[opacity,transform] duration-150 active:scale-[0.97] disabled:opacity-20 disabled:active:scale-100"
        >
          {ready.length > 1 ? "Apply all" : "Apply"}
        </button>
      </div>
      {open && (
        <ul aria-label="Saved notes" className="max-h-[220px] overflow-y-auto">
          {notes.map((item) => (
            <li
              key={item.id}
              onPointerEnter={() => highlightAttachment(path, item.anchor, item.quote)}
              onPointerLeave={clearAttachmentHighlight}
              className="flex items-start gap-1 border-t border-[var(--line-subtler)] py-[7px] pl-3 pr-1.5 transition-colors duration-150 hover:bg-[var(--item-hover-bg)]"
            >
              <button
                type="button"
                title="Edit in the composer"
                disabled={item.status === "running"}
                onClick={() => {
                  const text = takeBackFeedback(path, item.id);
                  clearAttachmentHighlight();
                  if (text === null) return;
                  revealAttachment(path, item.anchor);
                  onTakeBack(text);
                }}
                className="flex min-w-0 flex-1 flex-col text-left text-[12.5px] leading-normal text-[var(--text-primary)]"
              >
                <span className="truncate text-[11px] text-[var(--text-muted)]">
                  {item.anchor.attached
                    ? attachmentLabel(item.anchor, item.quote, 48)
                    : "Text changed · click to re-point"}
                </span>
                <span
                  className={`whitespace-pre-wrap [overflow-wrap:anywhere] ${
                    item.status === "running"
                      ? "chat-thinking-shimmer"
                      : item.anchor.attached
                        ? ""
                        : "opacity-55"
                  }`}
                >
                  {item.feedback}
                </span>
                {item.reviewRequired && (
                  <span className="text-[11px] text-[var(--text-muted)]">
                    The last pass may already have changed this.
                  </span>
                )}
              </button>
              {item.reviewRequired && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => acknowledgeFeedback(path, item.id)}
                  className="h-6 shrink-0 rounded-full px-2 text-[11.5px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]"
                >
                  Keep
                </button>
              )}
              <button
                type="button"
                aria-label="Remove note"
                disabled={item.status === "running"}
                onClick={() => {
                  removeFeedback(path, item.id);
                  clearAttachmentHighlight();
                }}
                className="grid size-6 shrink-0 place-items-center rounded-full text-[var(--text-icon-muted)] transition-colors duration-150 hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)] disabled:opacity-40"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
