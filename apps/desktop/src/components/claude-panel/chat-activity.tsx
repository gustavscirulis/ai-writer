import {
  useChatActivity,
  useChatStatus,
  useToolPermissions,
  useHasChatMessages,
} from "@/hooks/use-claude";

export function ChatActivity() {
  const status = useChatStatus();
  const hasMessages = useHasChatMessages();
  const activity = useChatActivity();
  const permissions = useToolPermissions();
  const thinking = status === "running" && permissions.length === 0 && activity === "thinking";
  const label =
    status === "running"
      ? permissions.length > 0
        ? "Waiting for your approval."
        : thinking
          ? "Thinking…"
          : activity === "working"
            ? "Using tools…"
            : "Responding…"
      : status === "stopping"
        ? "Finishing…"
        : status === "idle" && hasMessages
          ? "Finished."
          : "";
  return (
    <div
      className="mt-5 text-[12px] text-[var(--text-muted)]"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className={thinking ? "chat-thinking-shimmer" : undefined}>{label}</span>
    </div>
  );
}
