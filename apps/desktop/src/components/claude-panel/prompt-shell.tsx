import { useCallback, type KeyboardEvent, type ReactNode } from "react";
import { stopChat, useChatStatus } from "@/hooks/use-claude";
import type { ToolPermission } from "@/lib/claude-stream";

export interface PromptProps {
  path: string;
  request: ToolPermission;
  /** Requests waiting in this chat, this one included. */
  queued: number;
}

export const KBD =
  "hidden min-w-[22px] rounded bg-[var(--kbd-bg)] px-[5px] text-center text-[10.5px] leading-4 text-[var(--text-muted)] group-focus-within:inline-block";
export const QUIET_BUTTON =
  "-mx-1.5 h-6 rounded-md px-1.5 text-[12px] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-50";
/** Option rows add their own height. */
export const OPTION =
  "flex items-center justify-between gap-3 rounded-[9px] px-2 text-left text-[13px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--surface-subtle-strong)] focus-visible:outline-none forced-colors:focus-visible:outline focus-visible:text-[var(--text-primary)] disabled:opacity-60 disabled:hover:bg-transparent";

/** Focuses the default option on mount, but never takes focus from the editor: a stray Space or Enter would answer. */
export function useFocusDefault() {
  return useCallback((node: HTMLElement | null) => {
    const active = document.activeElement;
    if (node && (active === document.body || node.closest("aside")?.contains(active)))
      node.focus({ preventScroll: true });
  }, []);
}

/** Takes the composer's place while Claude waits on the user. ↑/↓ move between `[data-option]` rows and Esc calls `onEscape`. */
export function PromptCard({
  label,
  pending,
  onEscape,
  className = "max-h-[45vh]",
  children,
}: {
  label: string;
  pending?: boolean;
  onEscape: () => void;
  className?: string;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !pending) {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-option]")];
    const index = options.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    event.preventDefault();
    options[
      (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
    ]?.focus();
  };
  return (
    <div className="shrink-0 px-3 pb-3">
      <section
        aria-label={label}
        onKeyDown={onKeyDown}
        className={`group chat-rise overflow-y-auto rounded-[18px] border border-[var(--line-subtle)] bg-[var(--bg-base)] px-2 pb-1.5 pt-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.05)] [[data-theme=dark]_&]:bg-[var(--surface-subtle)] ${className}`}
      >
        {children}
      </section>
    </div>
  );
}

export function PromptError({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="mt-2 px-1.5 text-[12px] leading-relaxed">
      {error}
    </p>
  ) : null;
}

/** Quiet actions on the left, Stop on the right. */
export function PromptFooter({ path, children }: { path: string; children?: ReactNode }) {
  const status = useChatStatus(path);
  return (
    <div className="mt-1 flex justify-between gap-3 px-2">
      <div className="flex gap-3">{children}</div>
      <button
        type="button"
        disabled={status === "stopping"}
        onClick={() => void stopChat(path)}
        className={QUIET_BUTTON}
      >
        Stop
      </button>
    </div>
  );
}
