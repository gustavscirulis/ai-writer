import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowUp02Icon,
  Cancel01Icon,
  CheckListIcon,
  ParagraphIcon,
  PlusSignIcon,
  TextIcon,
} from "@hugeicons/core-free-icons";
import {
  dismissChatFileError,
  mentionChatFile,
  releaseChatMentions,
  pasteChatImage,
  pickChatFiles,
  removeChatFile,
  sendChat,
  stopChat,
  useChatStatus,
  useChatError,
  useChatDraft,
  setChatDraft,
  registerChatComposer,
  focusChatComposer,
  useChatFiles,
  useChatFileError,
  useChatMentions,
  usePlanMode,
  togglePlanMode,
  useChatPath,
} from "@/hooks/use-claude";
import { useChatDropActive } from "@/hooks/use-file-drop";
import {
  applyFeedback,
  canApplyFeedback,
  clearAttachedFeedback,
  removeFeedback,
  saveFeedbackNotes,
  useDocumentFeedback,
  type FeedbackItem,
} from "@/hooks/use-feedback";
import { clearAttachmentHighlight, highlightAttachment } from "@/hooks/feedback-api";
import { useSkills } from "@/hooks/use-co-writer";
import { isWorkspaceChat } from "@/lib/agent-turn";
import { matchSkills, slashQuery, type Skill } from "@/lib/co-writer-skills";
import { attachmentLabel, type FeedbackAnchor } from "@/lib/feedback-anchors";
import {
  deleteMention,
  insertToken,
  mentionQuery,
  mentionRanges,
  snapOutOfMention,
  type MentionMatch,
} from "@/lib/mentions";
import { pastedImageFile } from "@/lib/pasted-image";
import { canonicalWikiTarget } from "@/lib/wiki-links";
import type { SearchResult } from "@/types/fs";
import { menuOptionId } from "./composer-menu";
import { FileChip } from "./file-chip";
import { COMPOSER_TEXT, MentionBackdrop } from "./mention-pills";
import { MENTION_MENU_ID, MentionMenu } from "./mention-menu";
import { FeedbackError, NotesTray } from "./notes-tray";
import { SLASH_MENU_ID, SlashMenu } from "./slash-menu";
import { useMentionFiles } from "./use-mention-files";

const MAX_INPUT_HEIGHT = 180;
const KBD =
  "inline-block min-w-[18px] rounded bg-[var(--surface-subtle)] px-1 text-center text-[10.5px] font-medium leading-4 text-[var(--text-secondary)]";

type AttachedItem = FeedbackItem & { anchor: FeedbackAnchor };

function FileError({ path }: { path: string }) {
  const error = useChatFileError(path);
  if (!error) return null;
  return (
    <p
      role="alert"
      className="chat-rise mb-2 flex items-start gap-2 px-1 text-[12px] leading-normal text-[var(--text-secondary)]"
    >
      <span className="min-w-0 flex-1">{error}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismissChatFileError(path)}
        className="grid size-4 shrink-0 place-items-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
      </button>
    </p>
  );
}

function AttachmentChip({ item }: { item: AttachedItem }) {
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
  const path = useChatPath();
  // The queue holds note feedback, so the workspace chat has none.
  const queues = !isWorkspaceChat(path);
  const text = useChatDraft(path);
  const status = useChatStatus(path);
  const error = useChatError(path);
  const items = useDocumentFeedback(path);
  const files = useChatFiles(path);
  const mentions = useChatMentions(path);
  const pills = useMemo(() => mentionRanges(text, mentions), [text, mentions]);
  const chips = useMemo(
    () => files.filter((file) => !mentions.some((mention) => mention.path === file)),
    [files, mentions],
  );
  const planMode = usePlanMode(path);
  const dropActive = useChatDropActive();
  const attached = useMemo(
    () =>
      items.filter(
        (item): item is AttachedItem => item.status === "attached" && item.anchor !== null,
      ),
    [items],
  );
  // Running items already show in the thread as the sent message.
  const notes = useMemo(() => items.filter((item) => item.status === "pending"), [items]);
  const [trayOpen, setTrayOpen] = useState(false);
  const skills = useSkills();
  // The caret only counts for the draft it was read from, so a draft set from elsewhere opens no menu.
  const [selection, setSelection] = useState({ text, caret: 0 });
  const caret = selection.text === text ? selection.caret : null;
  const trackCaret = (input: HTMLTextAreaElement) =>
    setSelection({ text: input.value, caret: input.selectionStart });
  const slash = caret === null ? null : slashQuery(text, caret);
  const slashText = slash?.query ?? null;
  const skillMatches = useMemo(
    () => (slashText === null ? [] : matchSkills(slashText, skills)),
    [slashText, skills],
  );
  const typed = slash === null && caret !== null ? mentionQuery(text, caret) : null;
  // Right after a one-word pill the caret also reads as `@word`; that's the pill, not a search.
  const mention = typed && !pills.some((pill) => pill.from === typed.from) ? typed : null;
  const mentionFiles = useMentionFiles(mention?.query ?? null, path);
  const pendingCaret = useRef<number | null>(null);
  const pickSkill = (match: MentionMatch, skill: Skill) =>
    edit(insertToken(text, match, `/${skill.name}`));
  const pickFile = (match: MentionMatch, file: SearchResult) => {
    const label = canonicalWikiTarget(file, mentionFiles);
    edit(insertToken(text, match, `@${label}`));
    void mentionChatFile(path, file.path, label);
  };
  const edit = (next: { text: string; caret: number }) => {
    pendingCaret.current = next.caret;
    setChatDraft(path, next.text);
    setSelection(next);
  };
  const [scrollTop, setScrollTop] = useState(0);
  const menu =
    slash && skillMatches.length > 0
      ? {
          key: `/${slash.query}@${slash.from}`,
          id: SLASH_MENU_ID,
          count: skillMatches.length,
          pick: (index: number) => pickSkill(slash, skillMatches[index]!),
        }
      : mention && mentionFiles.length > 0
        ? {
            key: `@${mention.query}`,
            id: MENTION_MENU_ID,
            count: mentionFiles.length,
            pick: (index: number) => pickFile(mention, mentionFiles[index]!),
          }
        : null;
  const dismissKey = `${text}\u0000${caret}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [highlight, setHighlight] = useState({ key: "", index: 0 });
  const menuOpen = menu !== null && dismissed !== dismissKey;
  const active = menu && highlight.key === menu.key ? Math.min(highlight.index, menu.count - 1) : 0;
  const setActive = (index: number) => menu && setHighlight({ key: menu.key, index });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const setInput = useCallback(
    (input: HTMLTextAreaElement | null) => {
      inputRef.current = input;
      registerChatComposer(path, input);
    },
    [path],
  );
  const busy = status === "running" || status === "stopping";
  const retryLabel =
    status === "stopping" && error
      ? error.startsWith("Could not stop ")
        ? "Retry Stop"
        : "Retry reload"
      : null;
  // WKWebView has no `field-sizing: content`, so grow the field from its scroll height.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`;
    if (pendingCaret.current !== null) {
      input.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);
  const send = () => {
    void sendChat(path, text, {
      attachments: attached.map((item) => ({ anchor: item.anchor, quote: item.quote })),
      feedbackIds: attached.map((item) => item.id),
      files,
    });
    if (attached.length) clearAttachmentHighlight();
  };
  const empty = !text.trim() && !attached.length;
  const ready = useMemo(() => notes.filter(canApplyFeedback), [notes]);
  const queue = (flush: boolean) => {
    if (!queues) return;
    if (!empty) {
      if (!saveFeedbackNotes(path, text)) return;
      // Queued messages carry no files, so mentioned notes stay behind as chips.
      releaseChatMentions(path);
      setChatDraft(path, "");
      clearAttachmentHighlight();
    }
    if (flush && !busy) void applyFeedback(path);
    else if (!empty) setTrayOpen(true);
  };
  // A ready queue goes out with the draft appended last, so queued messages are never skipped.
  const submit = () => {
    if (busy) queue(false);
    else if (ready.length) queue(true);
    else send();
  };
  return (
    <form
      className="px-3 pb-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {queues && <FeedbackError />}
      <FileError path={path} />
      {queues && (
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
      <div
        data-chat-composer
        data-chat-drop
        className={`relative rounded-[18px] border ${dropActive ? "border-[var(--focus-border)]" : "border-[var(--line-subtle)]"} bg-[var(--bg-base)] pb-2 [[data-theme=dark]_&]:bg-[var(--surface-subtle)] pl-3.5 pr-2.5 pt-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.05)] transition-colors duration-150 focus-within:border-[var(--focus-border)]`}
      >
        {menuOpen &&
          (menu.id === SLASH_MENU_ID
            ? slash && (
                <SlashMenu
                  skills={skillMatches}
                  active={active}
                  onActive={setActive}
                  onPick={(skill) => pickSkill(slash, skill)}
                />
              )
            : mention && (
                <MentionMenu
                  files={mentionFiles}
                  active={active}
                  onActive={setActive}
                  onPick={(file) => pickFile(mention, file)}
                />
              ))}
        {(attached.length > 0 || chips.length > 0) && (
          <div className="mb-1.5 flex min-w-0 flex-wrap gap-1">
            {attached.map((item) => (
              <AttachmentChip key={item.id} item={item} />
            ))}
            {chips.map((file) => (
              <FileChip
                key={file}
                path={file}
                onRemove={() => {
                  removeChatFile(path, file);
                  focusChatComposer();
                }}
              />
            ))}
          </div>
        )}
        <div className="relative">
          <MentionBackdrop text={text} pills={pills} scrollTop={scrollTop} />
          <textarea
            ref={setInput}
            aria-label="Message"
            placeholder={
              attached.length
                ? "What should change here?"
                : busy && queues
                  ? "Queue a follow-up…"
                  : planMode
                    ? "Describe what you want planned…"
                    : "Ask anything, or describe a change…"
            }
            value={text}
            onChange={(event) => {
              setChatDraft(path, event.target.value);
              trackCaret(event.target);
            }}
            onSelect={(event) => {
              const input = event.currentTarget;
              if (input.selectionStart === input.selectionEnd) {
                const snapped = snapOutOfMention(pills, input.selectionStart, caret);
                if (snapped !== input.selectionStart) input.setSelectionRange(snapped, snapped);
              }
              trackCaret(input);
            }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            onPaste={(event) => {
              const image = pastedImageFile(event.clipboardData);
              if (!image) return;
              event.preventDefault();
              void pasteChatImage(path, image);
            }}
            rows={2}
            aria-autocomplete="list"
            aria-controls={menuOpen ? menu.id : undefined}
            aria-expanded={menuOpen}
            aria-activedescendant={menuOpen ? menuOptionId(menu.id, active) : undefined}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
              if (menuOpen && plain && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((active + step + menu.count) % menu.count);
              } else if (menuOpen && plain && (event.key === "Enter" || event.key === "Tab")) {
                event.preventDefault();
                menu.pick(active);
              } else if (menuOpen && event.key === "Escape") {
                event.preventDefault();
                setDismissed(dismissKey);
              } else if (
                event.key === "Tab" &&
                event.shiftKey &&
                !event.metaKey &&
                !event.ctrlKey
              ) {
                event.preventDefault();
                togglePlanMode(path);
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                queue(empty);
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              } else if (
                (event.key === "Backspace" || event.key === "Delete") &&
                plain &&
                event.currentTarget.selectionStart === event.currentTarget.selectionEnd &&
                pills.length
              ) {
                const next = deleteMention(
                  text,
                  pills,
                  event.currentTarget.selectionStart,
                  event.key,
                );
                if (next) {
                  event.preventDefault();
                  edit(next);
                }
              } else if (event.key === "Backspace" && !text && chips.length) {
                event.preventDefault();
                removeChatFile(path, chips[chips.length - 1]!);
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
            className={`${COMPOSER_TEXT} relative block w-full resize-none overflow-y-auto bg-transparent text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]`}
          />
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="-ml-1.5 flex min-w-0 items-center gap-1">
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files"
              onClick={() => void pickChatFiles(path)}
              className="grid size-7 shrink-0 place-items-center rounded-full text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              aria-pressed={planMode}
              title={planMode ? "Plan mode is on (⇧⇥)" : "Plan first, then write (⇧⇥)"}
              onClick={() => {
                togglePlanMode(path);
                focusChatComposer();
              }}
              className={`inline-flex h-[26px] shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-medium transition-colors duration-150 disabled:opacity-40 ${
                planMode
                  ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--text-primary)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
              }`}
            >
              <HugeiconsIcon icon={CheckListIcon} size={14} strokeWidth={1.8} />
              Plan
            </button>
            <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">
              {menuOpen ? (
                <>
                  <kbd className={KBD}>↵</kbd> choose
                </>
              ) : busy && text.trim() ? (
                queues && (
                  <>
                    <kbd className={KBD}>↵</kbd> queue for after this reply
                  </>
                )
              ) : !busy && ready.length && !empty ? (
                <>
                  <kbd className={KBD}>↵</kbd> send all
                </>
              ) : attached.length || text.trim() ? (
                <>
                  <kbd className={KBD}>↵</kbd> {attached.length ? "change now" : "send"}
                  {queues && (
                    <>
                      {" "}
                      · <kbd className={KBD}>⌘↵</kbd> queue
                    </>
                  )}
                </>
              ) : !busy && ready.length ? (
                <>
                  <kbd className={KBD}>↵</kbd> send queued
                </>
              ) : null}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {queues && (attached.length > 0 || text.trim() !== "") && (
              <button
                type="button"
                title={busy ? "Send after this reply (↵)" : "Add to the queue (⌘↵)"}
                disabled={!text.trim()}
                onClick={() => queue(false)}
                className="h-[26px] rounded-full px-[9px] text-[12px] font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Queue
              </button>
            )}
            {retryLabel ? (
              <button
                type="button"
                onClick={() => void stopChat(path)}
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
                onClick={() => void stopChat(path)}
                className="grid size-7 place-items-center rounded-full bg-[var(--text-primary)] text-[var(--bg-base)] transition-[opacity,transform] duration-150 active:scale-[0.94] disabled:opacity-40"
              >
                <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-current" />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send"
                title={
                  ready.length
                    ? `Send with ${ready.length} queued (Enter) · Shift+Enter for a new line`
                    : "Send (Enter) · Shift+Enter for a new line"
                }
                disabled={!text.trim()}
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
