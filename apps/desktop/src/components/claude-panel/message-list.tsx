import { Fragment } from "react";
import { useConversationScroll } from "./use-conversation-scroll";
import {
  sendChat,
  useChatError,
  useChatMessages,
  useChatNotices,
  useChatStatus,
} from "@/hooks/use-claude";
import { useActiveFilePath } from "@/hooks/use-tabs";
import { isVisibleMessage, type ChatMessage } from "@/lib/claude-stream";
import type { ChatNotice } from "@/stores/claude-store";
import { AssistantTurn, Disclosure, UserMessage } from "./chat-message";
import { ChatActivity } from "./chat-activity";
import "./chat-panel.css";

type Turn = { role: ChatMessage["role"]; messages: ChatMessage[]; notices: string[] };

function groupTurns(messages: ChatMessage[], notices: ChatNotice[]) {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (!isVisibleMessage(message)) continue;
    let last = turns[turns.length - 1];
    if (message.role === "assistant" && last?.role === "assistant") last.messages.push(message);
    else {
      last = { role: message.role, messages: [message], notices: [] };
      turns.push(last);
    }
    for (const notice of notices) if (notice.afterId === message.id) last.notices.push(notice.text);
  }
  return turns;
}

const SUGGESTIONS = [
  "Tighten the opening paragraph",
  "Find sentences that repeat an idea",
  "Suggest three alternative titles",
  "Check the quotes are accurate",
];

export function MessageList() {
  const path = useActiveFilePath();
  const messages = useChatMessages(path);
  const error = useChatError(path);
  const notices = useChatNotices(path);
  const status = useChatStatus(path);
  const scrollRef = useConversationScroll();
  const turns = groupTurns(messages, notices);
  const lastId = messages[messages.length - 1]?.id;
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-5 pt-2"
      ref={scrollRef}
      tabIndex={0}
      role="log"
      aria-label="Conversation"
      aria-live="off"
    >
      <div>
        {messages.length === 0 && (
          <div className="chat-enter pt-7 text-[13px] leading-relaxed">
            <p className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              A second pair of eyes.
            </p>
            <p className="mt-1.5 text-[var(--text-muted)]">
              Ask for feedback or edits to your open note. Select text and press ⌘L, or ⌥-click a
              paragraph, to point at it.
            </p>
            <div className="mt-[18px] flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={!path || status === "running" || status === "stopping"}
                  onClick={() => path && void sendChat(path, suggestion)}
                  className="rounded-full border border-[var(--line-subtle)] px-[11px] py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors duration-150 hover:border-transparent hover:bg-[var(--surface-subtle)] active:scale-[0.97] disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <p className="mt-7 text-[11px] leading-relaxed text-[var(--text-muted)]">
              Uses your installed Claude Code and its terminal sign-in. It reads workspace context
              and edits only this note. You can run another agent on a different note.
            </p>
          </div>
        )}
        <div className="flex flex-col gap-5">
          {turns.map((turn) => (
            <Fragment key={turn.messages[0].id}>
              {turn.role === "user" ? (
                <UserMessage message={turn.messages[0]} path={path} />
              ) : (
                <AssistantTurn
                  messages={turn.messages}
                  live={
                    status === "running" && turn.messages[turn.messages.length - 1].id === lastId
                  }
                />
              )}
              {turn.notices.length > 0 && (
                <Disclosure
                  label={<span>CLI notices</span>}
                  count={turn.notices.length}
                  listLabel="CLI notices"
                >
                  <p className="whitespace-pre-wrap break-words font-[family-name:var(--mono-font)] text-[11px] leading-relaxed">
                    {turn.notices.join("\n")}
                  </p>
                </Disclosure>
              )}
            </Fragment>
          ))}
        </div>
        {<ChatActivity path={path} />}
        {error && (
          <p
            role="alert"
            className="mt-4 whitespace-pre-wrap break-words rounded-xl bg-[var(--surface-subtle)] p-3 text-[12px] leading-relaxed"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
