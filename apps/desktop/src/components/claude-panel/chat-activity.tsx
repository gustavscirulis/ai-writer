import {
  useChatActivity,
  useChatStatus,
  useToolPermissions,
  useHasChatMessages,
} from "@/hooks/use-claude";
import { needsAnswer } from "@/lib/claude-stream";

export function ChatActivity({ path }: { path: string | null }) {
  const status = useChatStatus(path);
  const hasMessages = useHasChatMessages(path);
  const activity = useChatActivity(path);
  const permissions = useToolPermissions(path);
  const shown =
    status === "stopping" ||
    (status === "running" && permissions.length === 0 && activity !== "working");
  const thinking = status === "running" && permissions.length === 0 && activity === "thinking";
  const label =
    status === "running"
      ? permissions.length > 0
        ? needsAnswer(permissions[0].tool)
          ? "Waiting for your answer."
          : "Waiting for your approval."
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
      className={shown ? "mt-5 flex items-center gap-2 text-[12px]" : "sr-only"}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {shown && (
        <span
          aria-hidden="true"
          className="chat-pulse size-1.5 shrink-0 rounded-full bg-[var(--accent)]"
        />
      )}
      <span className={thinking ? "chat-thinking-shimmer" : "text-[var(--text-muted)]"}>
        {label}
      </span>
    </div>
  );
}
