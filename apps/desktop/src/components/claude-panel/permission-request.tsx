import { useToolPermissions, decideToolPermission } from "@/hooks/use-claude";

export function PermissionRequest() {
  const permissions = useToolPermissions();
  const request = permissions[0];
  if (!request) return null;
  return (
    <section
      key={request.id}
      aria-label="Tool approval"
      className="max-h-[45%] shrink-0 overflow-y-auto border-t border-[var(--line-subtle)] px-4 py-4"
    >
      <p role="status" className="text-[12px] font-medium">
        Approval needed{permissions.length > 1 ? ` · ${permissions.length} requests` : ""}
      </p>
      <p className="mt-2 break-words text-[12px] font-medium">{request.tool}</p>
      {request.description && (
        <p className="mt-1 break-words text-[12px] text-[var(--text-muted)]">
          {request.description}
        </p>
      )}
      <pre
        tabIndex={0}
        aria-label="Tool inputs"
        className="my-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--surface-subtle)] p-3 text-[11px] leading-relaxed"
      >
        {JSON.stringify(request.input, null, 2)}
      </pre>
      <p className="text-[11px] text-[var(--text-muted)]">Applies to this request only.</p>
      {request.error && (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed">
          {request.error}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={request.pending}
          onClick={() => void decideToolPermission(request.id, false)}
          className="rounded-md border border-[var(--line-subtle)] px-3 py-1.5 text-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        >
          Deny
        </button>
        <button
          type="button"
          disabled={request.pending}
          onClick={() => void decideToolPermission(request.id, true)}
          className="rounded-md bg-[var(--text-primary)] px-3 py-1.5 text-[12px] text-[var(--bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
        >
          {request.pending ? "Sending…" : "Approve once"}
        </button>
      </div>
    </section>
  );
}
