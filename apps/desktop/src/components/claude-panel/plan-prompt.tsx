import { useState, type KeyboardEvent } from "react";
import { answerRequest } from "@/hooks/use-claude";
import { MarkdownReply } from "./markdown-reply";
import {
  KBD,
  OPTION,
  PromptCard,
  PromptError,
  PromptFooter,
  useFocusDefault,
  type PromptProps,
} from "./prompt-shell";

/** Co-writer's plan from plan mode; approving it lets Co-writer start writing in the same reply. */
export function PlanPrompt({ path, request, queued }: PromptProps) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [focused, setFocused] = useState(0);
  const focusDefault = useFocusDefault();
  const plan = typeof request.input.plan === "string" ? request.input.plan.trim() : "";
  const disabled = request.pending === true;
  const decide = (approve: boolean) =>
    void answerRequest(path, request.id, {
      kind: "plan",
      approve,
      feedback: approve ? null : feedback.trim() || null,
    });
  const onFeedbackKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setRevising(false);
      setFeedback("");
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      decide(false);
    }
  };
  return (
    <PromptCard
      label="Plan approval"
      pending={disabled}
      onEscape={() => decide(false)}
      className="max-h-[70vh]"
    >
      <div className="flex items-baseline justify-between gap-3 px-1.5">
        <p role="status" className="text-[13.5px] font-semibold text-[var(--text-primary)]">
          Ready to start writing?
        </p>
        {queued > 1 && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--text-muted)]">
            1 of {queued}
          </span>
        )}
      </div>
      <p className="px-1.5 text-[11.5px] text-[var(--text-muted)]">
        Co-writer made a plan. It won&apos;t change anything until you approve it.
      </p>
      <div
        tabIndex={0}
        aria-label="Plan"
        className="mx-1.5 mt-2.5 max-h-[min(42vh,440px)] overflow-y-auto rounded-xl border border-[var(--line-subtle)] px-3.5 py-2.5 text-[13px] outline-none focus-visible:border-[var(--focus-border)]"
      >
        {plan ? (
          <MarkdownReply id={`plan-${request.id}`} text={plan} />
        ) : (
          <p className="text-[var(--text-muted)]">Co-writer didn&apos;t include the plan text.</p>
        )}
      </div>
      <PromptError error={request.error} />
      <div role="group" aria-label="Decision" className="mt-2.5 flex flex-col gap-px">
        <button
          type="button"
          data-option
          ref={focusDefault}
          disabled={disabled}
          onFocus={() => setFocused(0)}
          onClick={() => decide(true)}
          className={`${OPTION} h-8`}
        >
          <span className="truncate">{disabled ? "Sending…" : "Yes, start writing"}</span>
          {focused === 0 && <kbd className={KBD}>↵</kbd>}
        </button>
        {revising ? (
          <input
            data-option
            autoFocus
            aria-label="What should change in the plan?"
            placeholder="What should change? Enter to send"
            value={feedback}
            disabled={disabled}
            maxLength={4000}
            onFocus={() => setFocused(-1)}
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={onFeedbackKeyDown}
            className="h-8 rounded-[9px] bg-[var(--surface-subtle)] px-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] [[data-theme=dark]_&]:bg-[var(--surface-subtle-strong)]"
          />
        ) : (
          <button
            type="button"
            data-option
            disabled={disabled}
            onFocus={() => setFocused(1)}
            onClick={() => setRevising(true)}
            className={`${OPTION} h-8`}
          >
            <span className="truncate">No, keep planning</span>
            {focused === 1 ? <kbd className={KBD}>↵</kbd> : <kbd className={KBD}>esc</kbd>}
          </button>
        )}
      </div>
      <PromptFooter path={path} />
    </PromptCard>
  );
}
