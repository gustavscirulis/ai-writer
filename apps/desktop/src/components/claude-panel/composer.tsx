import {
  sendChat,
  stopChat,
  useChatStatus,
  useChatError,
  useChatDraft,
  setChatDraft,
  clearChatDraftIfUnchanged,
} from "@/hooks/use-claude";
import { useActiveFilePath } from "@/hooks/use-tabs";

export function Composer() {
  const text = useChatDraft();
  const status = useChatStatus();
  const error = useChatError();
  const path = useActiveFilePath();
  const busy = status === "running" || status === "stopping";
  const send = async () => {
    const draft = text;
    if (await sendChat(draft)) clearChatDraftIfUnchanged(draft);
  };
  return (
    <form
      className="border-t border-[var(--line-subtle)] p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className="rounded-xl border border-[var(--line-subtle)] bg-[var(--bg)] p-3 focus-within:border-[var(--text-muted)]">
        <textarea
          aria-label="Message"
          placeholder={path ? "What would you like to change?" : "Open a note to start"}
          value={text}
          onChange={(event) => setChatDraft(event.target.value)}
          disabled={!path}
          rows={3}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!busy) void send();
            }
          }}
          className="block w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-[var(--text-muted)]"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[10px] text-[var(--text-muted)]">Shift + Enter for a new line</span>
          {busy ? (
            <button
              type="button"
              disabled={status === "stopping" && !error}
              onClick={() => void stopChat()}
              className="rounded-md bg-[var(--surface-subtle)] px-3 py-1.5 text-[12px] disabled:opacity-50"
            >
              {status === "stopping"
                ? error
                  ? error.startsWith("Could not stop Claude Code:")
                    ? "Retry Stop"
                    : "Retry reload"
                  : "Stopping…"
                : "Stop"}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!path || !text.trim()}
              className="rounded-md bg-[var(--text-primary)] px-3 py-1.5 text-[12px] text-[var(--bg)] disabled:opacity-30"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
