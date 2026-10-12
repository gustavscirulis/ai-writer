import { useCallback, useState, type KeyboardEvent } from "react";
import { useActiveFilePath } from "@/hooks/use-tabs";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import {
  decideToolPermission,
  stopChat,
  useChatStatus,
  useToolPermissions,
} from "@/hooks/use-claude";
import type { ToolPermission } from "@/lib/claude-stream";
import { summarizeToolRequest } from "@/lib/tool-request-summary";

const KBD =
  "hidden min-w-[22px] rounded bg-[var(--kbd-bg)] px-[5px] text-center text-[10.5px] leading-4 text-[var(--text-muted)] group-focus-within:inline-block";
const QUIET_BUTTON =
  "-mx-1.5 h-6 rounded-md px-1.5 text-[12px] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] disabled:opacity-50";

/** Takes the composer's place while Claude waits on a decision. */
export function PermissionRequest() {
  const path = useActiveFilePath();
  const permissions = useToolPermissions(path);
  const request = permissions[0];
  if (!request || !path) return null;
  return (
    <PermissionPrompt
      key={`${path}:${request.id}`}
      path={path}
      request={request}
      queued={permissions.length}
    />
  );
}

function PermissionPrompt({
  path,
  request,
  queued,
}: {
  path: string;
  request: ToolPermission;
  queued: number;
}) {
  const root = useWorkspaceRoot();
  const status = useChatStatus(path);
  const [showInput, setShowInput] = useState(false);
  const [focused, setFocused] = useState(0);
  const summary = summarizeToolRequest(request.tool, request.input, root);
  const decide = (allow: boolean) => void decideToolPermission(path, request.id, allow);
  // Never steal focus from the editor: a stray Space or Enter would approve.
  const focusDefault = useCallback((node: HTMLButtonElement | null) => {
    const active = document.activeElement;
    if (node && (active === document.body || node.closest("aside")?.contains(active)))
      node.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !request.pending) {
      event.preventDefault();
      decide(false);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-option]")];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    options[
      (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length
    ]?.focus();
  };
  const options = [
    { label: request.pending ? "Sending…" : summary.allowLabel, allow: true },
    { label: "No, deny this request", allow: false },
  ];
  return (
    <div className="shrink-0 px-3 pb-3">
      <section
        aria-label="Tool approval"
        onKeyDown={onKeyDown}
        className="group chat-rise max-h-[45vh] overflow-y-auto rounded-[18px] border border-[var(--line-subtle)] bg-[var(--bg-base)] px-2 pb-1.5 pt-3 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_20px_rgba(0,0,0,0.05)] [[data-theme=dark]_&]:bg-[var(--surface-subtle)]"
      >
        <div className="flex items-baseline justify-between gap-3 px-1.5">
          <p
            role="status"
            className="min-w-0 break-words text-[13.5px] text-[var(--text-secondary)]"
          >
            {summary.verb}{" "}
            <strong className="font-semibold text-[var(--text-primary)]">{summary.target}</strong>?
          </p>
          {queued > 1 && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--text-muted)]">
              1 of {queued}
            </span>
          )}
        </div>
        {summary.where && (
          <p
            title={summary.where}
            className="truncate px-1.5 text-[11.5px] text-[var(--text-muted)]"
          >
            {summary.where}
          </p>
        )}
        {showInput && (
          <pre
            tabIndex={0}
            aria-label="Tool inputs"
            className="mx-1.5 mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--code-bg)] p-[9px] font-[family-name:var(--mono-font)] text-[10.5px] leading-relaxed"
          >
            {JSON.stringify(request.input, null, 2)}
          </pre>
        )}
        {request.error && (
          <p role="alert" className="mt-2 px-1.5 text-[12px] leading-relaxed">
            {request.error}
          </p>
        )}
        <div role="group" aria-label="Decision" className="mt-2.5 flex flex-col gap-px">
          {options.map((option, index) => (
            <button
              key={String(option.allow)}
              type="button"
              data-option
              ref={index === 0 ? focusDefault : undefined}
              disabled={request.pending}
              onFocus={() => setFocused(index)}
              onClick={() => decide(option.allow)}
              className="flex h-8 items-center justify-between rounded-[9px] px-2 text-left text-[13px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--surface-subtle-strong)] focus-visible:outline-none forced-colors:focus-visible:outline focus-visible:text-[var(--text-primary)] disabled:opacity-60 disabled:hover:bg-transparent"
            >
              <span className="truncate">{option.label}</span>
              {focused === index ? (
                <kbd className={KBD}>↵</kbd>
              ) : (
                !option.allow && <kbd className={KBD}>esc</kbd>
              )}
            </button>
          ))}
        </div>
        <div className="mt-1 flex justify-between px-2">
          <button
            type="button"
            aria-expanded={showInput}
            onClick={() => setShowInput(!showInput)}
            className={QUIET_BUTTON}
          >
            {showInput ? "Hide request" : "Show request"}
          </button>
          <button
            type="button"
            disabled={status === "stopping"}
            onClick={() => void stopChat(path)}
            className={QUIET_BUTTON}
          >
            Stop
          </button>
        </div>
      </section>
    </div>
  );
}
