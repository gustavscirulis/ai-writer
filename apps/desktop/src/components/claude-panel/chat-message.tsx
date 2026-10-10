import { memo } from "react";
import type { ChatMessage } from "@/lib/claude-stream";
import { getFileName } from "@/lib/paths";

export const ChatMessageItem = memo(function ChatMessageItem({
  message,
}: {
  message: ChatMessage;
}) {
  return (
    <article className="min-w-0">
      <p className="mb-2 text-[11px] font-medium text-[var(--text-muted)]">
        {message.role === "user" ? "You" : "Assistant"}
      </p>
      {message.text && (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-[var(--text-primary)]">
          {message.text}
        </p>
      )}
      {message.tools.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Tools">
          {message.tools.map((tool) => (
            <li
              key={tool.id}
              title={tool.path}
              className="rounded-md border border-[var(--line-subtle)] px-2 py-1 text-[11px] text-[var(--text-muted)]"
            >
              {tool.error ? "Denied / failed: " : tool.done ? "Completed: " : "Using: "}
              {tool.name}
              {tool.path ? ` · ${getFileName(tool.path)}` : ""}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
});
