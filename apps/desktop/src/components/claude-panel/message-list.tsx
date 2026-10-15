import { Fragment } from "react";
import { useConversationScroll } from "./use-conversation-scroll";
import {
  useChatError,
  useChatMessages,
  useChatNotices,
  useChatPath,
  useChatStatus,
} from "@/hooks/use-claude";
import { isVisibleMessage, type ChatMessage } from "@/lib/claude-stream";
import type { ChatNotice } from "@/stores/claude-store";
import { AssistantTurn, Disclosure, UserMessage } from "./chat-message";
import { ChatActivity } from "./chat-activity";
import { EmptyState } from "./empty-state";
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

export function MessageList() {
  const path = useChatPath();
  const messages = useChatMessages(path);
  const error = useChatError(path);
  const notices = useChatNotices(path);
  const status = useChatStatus(path);
  const last = messages[messages.length - 1];
  const lastId = last?.id;
  const { scrollRef, spacerRef } = useConversationScroll(
    last?.role === "user" ? last.id : undefined,
    messages.length === 0,
  );
  const turns = groupTurns(messages, notices);
  return (
    <div
      className="relative min-h-0 flex-1 overflow-y-auto px-[18px] pb-5 pt-2"
      ref={scrollRef}
      tabIndex={0}
      role="log"
      aria-label="Conversation"
      aria-live="off"
    >
      <div className={messages.length === 0 ? "h-full" : undefined}>
        {messages.length === 0 && (
          <EmptyState path={path} busy={status === "running" || status === "stopping"} />
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
      <div ref={spacerRef} aria-hidden />
    </div>
  );
}
