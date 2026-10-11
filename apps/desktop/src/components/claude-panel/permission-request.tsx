import { useActiveFilePath } from "@/hooks/use-tabs";
import { useCallback, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Shield01Icon } from "@hugeicons/core-free-icons";
import { useToolPermissions, decideToolPermission } from "@/hooks/use-claude";
import type { ToolPermission } from "@/lib/claude-stream";

function inputPreview(input: Record<string, unknown>) {
  const value = Object.values(input).find((entry) => typeof entry === "string" && entry.trim());
  return typeof value === "string" ? value : null;
}

export function PermissionRequest() {
  const path = useActiveFilePath();
  const permissions = useToolPermissions(path);
  const request = permissions[0];
  if (!request || !path) return null;
  return (
    <PermissionCard
      key={`${path}:${request.id}`}
      path={path}
      request={request}
      queued={permissions.length}
    />
  );
}

function PermissionCard({
  path,
  request,
  queued,
}: {
  path: string;
  request: ToolPermission;
  queued: number;
}) {
  const [showInput, setShowInput] = useState(false);
  const approvalRef = useCallback((node: HTMLButtonElement | null) => {
    node?.focus({ preventScroll: true });
  }, []);
  const preview = inputPreview(request.input);
  return (
    <section
      aria-label="Tool approval"
      className="chat-rise mx-3 mb-2.5 max-h-[45%] shrink-0 overflow-y-auto rounded-[14px] border border-[var(--line-subtle)] bg-[var(--surface-subtle)] p-3.5"
    >
      <div className="flex gap-2.5">
        <span className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]">
          <HugeiconsIcon icon={Shield01Icon} size={15} strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <p role="status" className="break-words text-[13px] font-semibold">
            Allow {request.tool}?
            {queued > 1 && (
              <span className="font-normal text-[var(--text-muted)]"> · {queued} requests</span>
            )}
          </p>
          {request.description && (
            <p className="mt-0.5 break-words text-[12px] leading-normal text-[var(--text-muted)]">
              {request.description}
            </p>
          )}
        </div>
      </div>
      {preview && !showInput && (
        <p
          title={preview}
          className="mt-2.5 truncate rounded-lg bg-[var(--code-bg)] px-[9px] py-[7px] font-[family-name:var(--mono-font)] text-[11px] text-[var(--text-secondary)]"
        >
          {preview}
        </p>
      )}
      <button
        type="button"
        aria-expanded={showInput}
        onClick={() => setShowInput(!showInput)}
        className="mt-2 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        {showInput ? "Hide request" : "Show full request"}
      </button>
      {showInput && (
        <pre
          tabIndex={0}
          aria-label="Tool inputs"
          className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--code-bg)] p-[9px] font-[family-name:var(--mono-font)] text-[10.5px] leading-relaxed"
        >
          {JSON.stringify(request.input, null, 2)}
        </pre>
      )}
      {request.error && (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed">
          {request.error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-1.5">
        <button
          type="button"
          ref={approvalRef}
          disabled={request.pending}
          onClick={() => void decideToolPermission(path, request.id, false)}
          className="h-7 rounded-lg border border-[var(--line-subtle)] px-3 text-[12px] font-medium hover:bg-[var(--surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-[0.97] disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={request.pending}
          onClick={() => void decideToolPermission(path, request.id, true)}
          className="h-7 rounded-lg bg-[var(--text-primary)] px-3 text-[12px] font-medium text-[var(--bg-base)] hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-[0.97] disabled:opacity-50"
        >
          {request.pending ? "Sending…" : "Allow once"}
        </button>
      </div>
    </section>
  );
}
