import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { allowedToolLabel } from "@/lib/tool-request-summary";
import { useAllowedTools } from "./use-allowed-tools";

export const ALLOWED_TOOLS_KEY = "co-writer.allowed-tools";
const DEF = SETTINGS_SCHEMA.find((def) => def.key === ALLOWED_TOOLS_KEY)!;
export const CO_WRITER_CATEGORY = DEF.category;

/** Rows appended to the Co-writer settings card. */
export function AllowedToolsRows({ isActive }: { isActive: boolean }) {
  const { tools, error, revoke } = useAllowedTools(isActive);
  return <AllowedTools tools={tools} error={error} onRevoke={revoke} />;
}

export function AllowedTools({
  tools,
  error,
  onRevoke,
}: {
  tools: string[] | null;
  error: string | null;
  onRevoke: (tool: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-[var(--line-subtler)] px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{DEF.label}</div>
        <div className="mt-0.5 text-[13px] text-[var(--text-muted)]">{DEF.description}</div>
        {error && (
          <div role="alert" className="mt-2 text-[13px] text-[var(--text-error)]">
            {error}
          </div>
        )}
      </div>
      {tools && (
        <ul className="w-72 shrink-0 overflow-hidden rounded-lg bg-[var(--surface-input)]">
          {tools.length === 0 && (
            <li className="px-3 py-2.5 text-[13px] text-[var(--text-muted)]">Nothing yet.</li>
          )}
          {tools.map((tool, i) => (
            <li
              key={tool}
              className={`flex items-center justify-between gap-2 py-2 pr-1.5 pl-3 ${
                i === 0 ? "" : "border-t border-[var(--line-subtler)]"
              }`}
            >
              <div className="min-w-0" title={tool}>
                <div className="truncate text-[13px] text-[var(--text-secondary)]">
                  {allowedToolLabel(tool)}
                </div>
                <div className="truncate [font-family:var(--mono-font)] text-[11px] text-[var(--text-muted)]">
                  {tool}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRevoke(tool)}
                aria-label={`Revoke ${allowedToolLabel(tool)}`}
                className="shrink-0 rounded-full px-2 py-0.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-subtle-strong)] hover:text-[var(--text-primary)]"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
