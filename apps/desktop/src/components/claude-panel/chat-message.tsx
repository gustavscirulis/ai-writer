import { memo, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  BubbleChatQuestionIcon,
  CommandLineIcon,
  Edit02Icon,
  File01Icon,
  GlobalIcon,
  ParagraphIcon,
  Search01Icon,
  TextIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { ChatAttachment, ChatMessage, ChatTool } from "@/lib/claude-stream";
import { getFileName } from "@/lib/paths";
import { attachmentLabel } from "@/lib/feedback-anchors";
import { openLinkedFile } from "@/hooks/editor-api";
import { FileChip } from "./file-chip";
import { MarkdownReply } from "./markdown-reply";
import {
  clearAttachmentHighlight,
  highlightAttachment,
  revealAttachment,
} from "@/hooks/feedback-api";

const TOOL_KINDS: Record<
  string,
  { verb: string; icon: typeof File01Icon; label?: string; running?: string }
> = {
  Read: { verb: "read", icon: File01Icon },
  Edit: { verb: "edited", icon: Edit02Icon },
  MultiEdit: { verb: "edited", icon: Edit02Icon },
  Write: { verb: "edited", icon: Edit02Icon },
  Grep: { verb: "searched", icon: Search01Icon },
  Glob: { verb: "searched", icon: Search01Icon },
  WebFetch: { verb: "browsed", icon: GlobalIcon },
  WebSearch: { verb: "browsed", icon: GlobalIcon },
  Bash: { verb: "ran commands", icon: CommandLineIcon },
  AskUserQuestion: {
    verb: "asked you",
    icon: BubbleChatQuestionIcon,
    label: "Asked",
    running: "Asking you",
  },
};

function toolKind(tool: ChatTool) {
  return TOOL_KINDS[tool.name] ?? { verb: `used ${tool.name}`, icon: Wrench01Icon };
}

/** Notes Claude wrote can be opened from the tool list, like a link. */
function opensNote(tool: ChatTool) {
  return (
    !!tool.path &&
    tool.done === true &&
    !tool.error &&
    ["Edit", "MultiEdit", "Write"].includes(tool.name) &&
    /\.(md|markdown)$/i.test(tool.path)
  );
}

function summarize(tools: ChatTool[]) {
  const verbs = [...new Set(tools.map((tool) => toolKind(tool).verb))];
  const sentence =
    verbs.length > 2
      ? `${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]}`
      : verbs.join(" and ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function Disclosure({
  label,
  count,
  children,
  listLabel,
}: {
  label: ReactNode;
  count: number;
  children: ReactNode;
  listLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="-ml-1.5 max-w-[calc(100%+6px)] self-start">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-lg pl-1.5 pr-2.5 text-[12px] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--surface-subtle)] hover:text-[var(--text-secondary)]"
      >
        <span
          className={`grid shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        >
          <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={2} />
        </span>
        {label}
        <span className="min-w-4 shrink-0 rounded-full bg-[var(--surface-subtle)] px-1 text-center text-[10px] leading-4 tabular-nums">
          {count}
        </span>
      </button>
      {open && (
        <div
          aria-label={listLabel}
          className="chat-enter ml-3 mt-1 border-l border-[var(--line-subtle)] py-0.5 pl-3 text-[12px] text-[var(--text-muted)]"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function ToolSummary({ tools, live }: { tools: ChatTool[]; live: boolean }) {
  const running = live ? tools.find((tool) => !tool.done && !tool.error) : undefined;
  const failed = tools.filter((tool) => tool.error).length;
  return (
    <Disclosure
      count={tools.length}
      listLabel="Tools"
      label={
        <>
          {running ? (
            <span className="chat-thinking-shimmer truncate">
              {toolKind(running).running ?? `Using ${running.name}`}
              {running.path ? ` · ${getFileName(running.path)}` : ""}
            </span>
          ) : (
            <span className="truncate">{summarize(tools)}</span>
          )}
          {failed > 0 && <span className="shrink-0">· {failed} failed</span>}
        </>
      }
    >
      <ul className="flex flex-col gap-1.5">
        {tools.map((tool) => (
          <li key={tool.id} title={tool.path} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-[7px]">
              <HugeiconsIcon
                icon={toolKind(tool).icon}
                size={13}
                strokeWidth={1.8}
                className="shrink-0"
              />
              <span className={`truncate ${tool.error ? "line-through" : ""}`}>
                {toolKind(tool).label ?? tool.name}
                {tool.path && " "}
                {tool.path &&
                  (opensNote(tool) ? (
                    <button
                      type="button"
                      onClick={() => void openLinkedFile(tool.path!)}
                      className="font-medium text-[var(--text-secondary)] underline decoration-[var(--line-subtle)] underline-offset-2 transition-colors duration-150 hover:text-[var(--text-primary)] hover:decoration-current"
                    >
                      {getFileName(tool.path)}
                    </button>
                  ) : (
                    <span className="font-medium text-[var(--text-secondary)]">
                      {getFileName(tool.path)}
                    </span>
                  ))}
              </span>
              <span className="ml-auto shrink-0">
                {tool.error ? "Denied / failed" : tool.done ? "" : "Running"}
              </span>
            </div>
            {tool.questions?.map(({ question, answer }) => (
              <p key={question} className="pl-5 leading-snug">
                {question}
                {answer && (
                  <span className="block font-medium text-[var(--text-secondary)]">{answer}</span>
                )}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function attachmentProps(path: string | null, attachment: ChatAttachment) {
  return {
    onPointerEnter: () => path && highlightAttachment(path, attachment.anchor, attachment.quote),
    onPointerLeave: clearAttachmentHighlight,
    onClick: () => path && revealAttachment(path, attachment.anchor),
  };
}

export const UserMessage = memo(function UserMessage({
  message,
  path,
}: {
  message: ChatMessage;
  path: string | null;
}) {
  const quotes = message.attachments?.filter((attachment) => attachment.note === undefined) ?? [];
  const notes = message.attachments?.filter((attachment) => attachment.note !== undefined) ?? [];
  return (
    <article
      aria-label="You"
      data-message-id={message.id}
      className="chat-enter flex flex-col items-end gap-1.5"
    >
      {message.files?.length ? (
        <div aria-label="Attached files" className="flex max-w-[85%] flex-wrap justify-end gap-1">
          {message.files.map((file) => (
            <FileChip key={file} path={file} />
          ))}
        </div>
      ) : null}
      {quotes.map((attachment, index) => (
        <button
          key={index}
          type="button"
          title={attachment.quote ?? attachment.anchor.text}
          {...attachmentProps(path, attachment)}
          className="flex max-w-[85%] items-start gap-1.5 text-left text-[11.5px] leading-[1.45] text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text-secondary)]"
        >
          <HugeiconsIcon
            icon={attachment.quote ? TextIcon : ParagraphIcon}
            size={12}
            strokeWidth={1.8}
            className="mt-0.5 shrink-0"
          />
          <span className="line-clamp-2">
            {attachmentLabel(attachment.anchor, attachment.quote, 120)}
          </span>
        </button>
      ))}
      {notes.length > 0 && (
        <div className="flex max-w-[85%] flex-col overflow-hidden rounded-[14px] border border-[var(--line-subtle)]">
          {notes.map((attachment, index) => (
            <button
              key={index}
              type="button"
              {...attachmentProps(path, attachment)}
              className="flex flex-col gap-px border-[var(--line-subtler)] px-3 py-2 text-left text-[12.5px] leading-normal text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--item-hover-bg)] [&:not(:first-child)]:border-t"
            >
              <span className="text-[11px] text-[var(--text-muted)]">
                {attachmentLabel(attachment.anchor, attachment.quote, 48)}
              </span>
              <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {attachment.note}
              </span>
            </button>
          ))}
        </div>
      )}
      <p
        data-chat-selectable
        className="max-w-[85%] whitespace-pre-wrap break-words rounded-[16px_16px_5px_16px] bg-[var(--surface-subtle)] px-[13px] py-[9px] text-[13px] leading-[1.55] text-[var(--text-primary)] [[data-theme=dark]_&]:bg-[var(--surface-subtle-strong)]"
      >
        {message.text}
      </p>
    </article>
  );
});

/** One reply: every assistant message between two user messages, with all of its tool use folded into a single summary. */
export const AssistantTurn = memo(
  function AssistantTurn({ messages, live }: { messages: ChatMessage[]; live: boolean }) {
    const tools = messages.flatMap((message) => message.tools);
    const texts = messages.filter((message) => message.text);
    return (
      <article aria-label="Assistant" className="chat-enter flex min-w-0 flex-col gap-2.5">
        {tools.length > 0 && <ToolSummary tools={tools} live={live} />}
        {texts.map((message) => (
          <MarkdownReply key={message.id} id={message.id} text={message.text} />
        ))}
      </article>
    );
  },
  (prev, next) =>
    prev.live === next.live &&
    prev.messages.length === next.messages.length &&
    prev.messages.every((message, index) => message === next.messages[index]),
);
