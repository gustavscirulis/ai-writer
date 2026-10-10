import { useConversationScroll } from "./use-conversation-scroll";
import { useChatError, useChatMessages, useChatNotices } from "@/hooks/use-claude";
import { ChatMessageItem } from "./chat-message";
import { ChatActivity } from "./chat-activity";
import "./chat-activity.css";

export function MessageList() {
  const messages = useChatMessages();
  const error = useChatError();
  const notices = useChatNotices();
  const scrollRef = useConversationScroll();
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-5 py-6"
      ref={scrollRef}
      tabIndex={0}
      role="log"
      aria-label="Conversation"
      aria-live="off"
    >
      <div>
        {messages.length === 0 && (
          <div className="pt-8 text-[13px] leading-relaxed text-[var(--text-muted)]">
            <p className="mb-2 text-[15px] font-medium text-[var(--text-primary)]">
              A second pair of eyes.
            </p>
            <p>Ask for feedback or edits to your open note. Your selection is included.</p>
            <p className="mt-4">
              Uses your installed Claude Code and its terminal sign-in. It can edit workspace files
              and run tools allowed by your Claude Code settings.
            </p>
          </div>
        )}
        <div className="space-y-6">
          {messages
            .filter((message) => message.text || message.tools.length > 0)
            .map((message) => (
              <ChatMessageItem key={message.id} message={message} />
            ))}
        </div>
        <ChatActivity />
        {notices.length > 0 && (
          <details className="mt-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
            <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">
              CLI notices ({notices.length})
            </summary>
            <p className="mt-2 whitespace-pre-wrap break-words">{notices.join("\n")}</p>
          </details>
        )}
        {error && (
          <p
            role="alert"
            className="mt-4 whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-subtle)] p-3 text-[12px] leading-relaxed"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
