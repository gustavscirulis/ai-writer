import { useMemo, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkSquare02Icon, SquareIcon } from "@hugeicons/core-free-icons";
import { answerRequest } from "@/hooks/use-claude";
import { readQuestions } from "@/lib/claude-stream";
import {
  KBD,
  OPTION,
  PromptCard,
  PromptError,
  PromptFooter,
  QUIET_BUTTON,
  useFocusDefault,
  type PromptProps,
} from "./prompt-shell";

/** Co-writer's questions, one at a time; the answers go back together after the last one. */
export function QuestionPrompt({ path, request, queued }: PromptProps) {
  const questions = useMemo(() => readQuestions(request.input), [request.input]);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [typing, setTyping] = useState(false);
  const [custom, setCustom] = useState("");
  const [focused, setFocused] = useState(0);
  const focusDefault = useFocusDefault();
  const question = questions[step];
  if (!question) return null;
  const last = step === questions.length - 1;
  const disabled = request.pending === true;

  const goTo = (index: number) => {
    setStep(index);
    setPicked([]);
    setTyping(false);
    setCustom("");
    setFocused(0);
  };
  const submit = (answer: string) => {
    if (!answer || disabled) return;
    const next = { ...answers, [question.question]: answer };
    setAnswers(next);
    if (last) void answerRequest(path, request.id, { kind: "questions", answers: next });
    else goTo(step + 1);
  };
  const decline = () => void answerRequest(path, request.id, { kind: "questions", answers: null });
  const multiAnswer = [...picked, custom.trim()].filter(Boolean).join(", ");
  const choose = (label: string) => {
    if (!question.multiSelect) return submit(label);
    setPicked((current) =>
      current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label],
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    const option = question.options[Number(event.key) - 1];
    if (option && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      choose(option.label);
    } else if (event.key === "ArrowLeft" && step > 0) {
      event.preventDefault();
      goTo(step - 1);
    }
  };
  const onCustomKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setTyping(false);
      setCustom("");
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(question.multiSelect ? multiAnswer : custom.trim());
    }
  };
  const rowHint = (index: number, hint: string) =>
    focused === index ? <kbd className={KBD}>↵</kbd> : <kbd className={KBD}>{hint}</kbd>;
  const count =
    questions.length > 1
      ? `${step + 1} of ${questions.length}`
      : queued > 1
        ? `1 of ${queued}`
        : null;

  return (
    <PromptCard label="Co-writer's question" pending={disabled} onEscape={decline}>
      <div className="flex items-center justify-between gap-3 px-1.5">
        {question.header ? (
          <span className="truncate rounded-md bg-[var(--surface-subtle)] px-1.5 text-[11px] leading-[18px] text-[var(--text-muted)] [[data-theme=dark]_&]:bg-[var(--surface-subtle-strong)]">
            {question.header}
          </span>
        ) : (
          <span />
        )}
        {count && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-[var(--text-muted)]">
            {count}
          </span>
        )}
      </div>
      <p
        role="status"
        className="mt-1.5 break-words px-1.5 text-[13.5px] font-semibold leading-snug text-[var(--text-primary)]"
      >
        {question.question}
      </p>
      {question.multiSelect && (
        <p className="px-1.5 text-[11.5px] text-[var(--text-muted)]">Choose any that apply.</p>
      )}
      <PromptError error={request.error} />
      <div
        key={step}
        role="group"
        aria-label={question.question}
        onKeyDown={onKeyDown}
        className="mt-2.5 flex flex-col gap-px"
      >
        {question.options.map((option, index) => {
          const checked = picked.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              data-option
              ref={index === 0 ? focusDefault : undefined}
              disabled={disabled}
              aria-pressed={question.multiSelect ? checked : undefined}
              onFocus={() => setFocused(index)}
              onClick={() => choose(option.label)}
              className={`${OPTION} min-h-8 py-1.5`}
            >
              <span className="flex min-w-0 items-start gap-2">
                {question.multiSelect && (
                  <HugeiconsIcon
                    icon={checked ? CheckmarkSquare02Icon : SquareIcon}
                    size={14}
                    strokeWidth={1.8}
                    className={`mt-[3px] shrink-0 ${checked ? "text-[var(--accent)]" : ""}`}
                  />
                )}
                <span className="flex min-w-0 flex-col">
                  <span className="break-words">{option.label}</span>
                  {option.description && (
                    <span className="break-words text-[11.5px] leading-snug text-[var(--text-muted)]">
                      {option.description}
                    </span>
                  )}
                </span>
              </span>
              {index < 9 && rowHint(index, String(index + 1))}
            </button>
          );
        })}
        {typing ? (
          <input
            data-option
            autoFocus
            aria-label="Your answer"
            placeholder={question.multiSelect ? "Add your own…" : "Type your answer…"}
            value={custom}
            disabled={disabled}
            maxLength={2000}
            onFocus={() => setFocused(-1)}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={onCustomKeyDown}
            className="h-8 rounded-[9px] bg-[var(--surface-subtle)] px-2 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] [[data-theme=dark]_&]:bg-[var(--surface-subtle-strong)]"
          />
        ) : (
          <button
            type="button"
            data-option
            disabled={disabled}
            onFocus={() => setFocused(question.options.length)}
            onClick={() => setTyping(true)}
            className={`${OPTION} h-8 text-[var(--text-muted)]`}
          >
            <span className="truncate">Type your own answer…</span>
            {focused === question.options.length && <kbd className={KBD}>↵</kbd>}
          </button>
        )}
        {question.multiSelect && (
          <button
            type="button"
            data-option
            disabled={disabled || !multiAnswer}
            onFocus={() => setFocused(question.options.length + 1)}
            onClick={() => submit(multiAnswer)}
            className={`${OPTION} h-8 font-medium`}
          >
            <span className="truncate">
              {disabled ? "Sending…" : last ? "Send answers" : "Next question"}
            </span>
            {focused === question.options.length + 1 && <kbd className={KBD}>↵</kbd>}
          </button>
        )}
      </div>
      <PromptFooter path={path}>
        {step > 0 && (
          <button type="button" onClick={() => goTo(step - 1)} className={QUIET_BUTTON}>
            Back
          </button>
        )}
        <button type="button" disabled={disabled} onClick={decline} className={QUIET_BUTTON}>
          Don't answer
        </button>
      </PromptFooter>
    </PromptCard>
  );
}
