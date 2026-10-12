import { useState, type ReactNode } from "react";
import { useActiveFilePath } from "@/hooks/use-tabs";
import { useWorkspaceRoot } from "@/hooks/use-workspace";
import { decideToolPermission, useToolPermissions } from "@/hooks/use-claude";
import { alwaysAllowLabel, summarizeToolRequest } from "@/lib/tool-request-summary";
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
import { QuestionPrompt } from "./question-prompt";

const PROMPTS: Partial<Record<string, (props: PromptProps) => ReactNode>> = {
  AskUserQuestion: QuestionPrompt,
};

/** Takes the composer's place while Claude waits on a decision. */
export function PermissionRequest() {
  const path = useActiveFilePath();
  const permissions = useToolPermissions(path);
  const request = permissions[0];
  if (!request || !path) return null;
  const Prompt = PROMPTS[request.tool] ?? PermissionPrompt;
  return (
    <Prompt
      key={`${path}:${request.id}`}
      path={path}
      request={request}
      queued={permissions.length}
    />
  );
}

function PermissionPrompt({ path, request, queued }: PromptProps) {
  const root = useWorkspaceRoot();
  const [showInput, setShowInput] = useState(false);
  const [focused, setFocused] = useState(0);
  const focusDefault = useFocusDefault();
  const summary = summarizeToolRequest(request.tool, request.input, root, request.target);
  const decide = (allow: boolean, always = false) =>
    void decideToolPermission(path, request.id, allow, always);
  const options = [
    { label: request.pending ? "Sending…" : summary.allowLabel, allow: true, always: false },
    { label: alwaysAllowLabel(request.tool), allow: true, always: true },
    { label: "No, deny this request", allow: false, always: false },
  ];
  return (
    <PromptCard label="Tool approval" pending={request.pending} onEscape={() => decide(false)}>
      <div className="flex items-baseline justify-between gap-3 px-1.5">
        <p role="status" className="min-w-0 break-words text-[13.5px] text-[var(--text-secondary)]">
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
        <p title={summary.where} className="truncate px-1.5 text-[11.5px] text-[var(--text-muted)]">
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
      <PromptError error={request.error} />
      <div role="group" aria-label="Decision" className="mt-2.5 flex flex-col gap-px">
        {options.map((option, index) => (
          <button
            key={index}
            type="button"
            data-option
            ref={index === 0 ? focusDefault : undefined}
            disabled={request.pending}
            onFocus={() => setFocused(index)}
            onClick={() => decide(option.allow, option.always)}
            className={`${OPTION} h-8`}
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
      <PromptFooter path={path}>
        <button
          type="button"
          aria-expanded={showInput}
          onClick={() => setShowInput(!showInput)}
          className={QUIET_BUTTON}
        >
          {showInput ? "Hide request" : "Show request"}
        </button>
      </PromptFooter>
    </PromptCard>
  );
}
