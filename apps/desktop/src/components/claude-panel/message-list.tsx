import { useConversationScroll } from "./use-conversation-scroll";
import {
  sendChat,
  useChatError,
  useChatMessages,
  useChatNotices,
  useChatStatus,
  useOwnsChatTurn,
} from "@/hooks/use-claude";
import { useActiveFilePath } from "@/hooks/use-tabs";
import type { ChatMessage } from "@/lib/claude-stream";
import { AssistantTurn, Disclosure, UserMessage } from "./chat-message";
import { ChatActivity } from "./chat-activity";
import "./chat-panel.css";

type Turn = { role: ChatMessage["role"]; messages: ChatMessage[] };

function groupTurns(messages: ChatMessage[]) {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (!message.text && message.tools.length === 0) continue;
    const last = turns[turns.length - 1];
    if (message.role === "assistant" && last?.role === "assistant") last.messages.push(message);
    else turns.push({ role: message.role, messages: [message] });
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
  const owns = useOwnsChatTurn(path);
  const error = useChatError();
  const notices = useChatNotices();
  const status = useChatStatus();
  const scrollRef = useConversationScroll();
  const turns = groupTurns(messages);
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
                  onClick={() => void sendChat(suggestion)}
                  className="rounded-full border border-[var(--line-subtle)] px-[11px] py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors duration-150 hover:border-transparent hover:bg-[var(--surface-subtle)] active:scale-[0.97] disabled:opacity-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <p className="mt-7 text-[11px] leading-relaxed text-[var(--text-muted)]">
              Uses your installed Claude Code and its terminal sign-in. It can edit workspace files
              and run tools allowed by your Claude Code settings.
            </p>
          </div>
        )}
        <div className="flex flex-col gap-5">
          {turns.map((turn) =>
            turn.role === "user" ? (
              <UserMessage key={turn.messages[0].id} message={turn.messages[0]} path={path} />
            ) : (
              <AssistantTurn
                key={turn.messages[0].id}
                messages={turn.messages}
                live={
                  owns &&
                  status === "running" &&
                  turn.messages[turn.messages.length - 1].id === lastId
                }
              />
            ),
          )}
        </div>
        {owns && <ChatActivity path={path} />}
        {owns && notices.length > 0 && (
          <div className="mt-4 flex">
            <Disclosure
              label={<span>CLI notices</span>}
              count={notices.length}
              listLabel="CLI notices"
            >
              <p className="whitespace-pre-wrap break-words font-[family-name:var(--mono-font)] text-[11px] leading-relaxed">
                {notices.join("\n")}
              </p>
            </Disclosure>
          </div>
        )}
        {owns && error && (
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
