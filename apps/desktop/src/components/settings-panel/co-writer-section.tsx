import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { allowedToolLabel } from "@/lib/tool-request-summary";
import { useAllowedTools } from "./use-allowed-tools";

export const ALLOWED_TOOLS_KEY = "co-writer.allowed-tools";
const DEF = SETTINGS_SCHEMA.find((def) => def.key === ALLOWED_TOOLS_KEY)!;

export function CoWriterSection({ isActive }: { isActive: boolean }) {
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
    <section className="mb-10">
      <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">{DEF.category}</h2>
      <div className="-mx-4 overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
        <div className="px-4 py-3.5">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">{DEF.label}</div>
          <div className="mt-0.5 text-[13px] text-[var(--text-muted)]">{DEF.description}</div>
          {error && (
            <div role="alert" className="mt-2 text-[13px] text-[var(--text-error)]">
              {error}
            </div>
          )}
        </div>
        {tools?.length === 0 && (
          <div className="border-t border-[var(--line-subtler)] px-4 py-3.5 text-[13px] text-[var(--text-muted)]">
            Nothing yet.
          </div>
        )}
        {tools?.map((tool) => (
          <div
            key={tool}
            className="flex items-center justify-between gap-4 border-t border-[var(--line-subtler)] px-4 py-2.5"
          >
            <div className="min-w-0">
              <div className="truncate text-[13px] text-[var(--text-primary)]">
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
          </div>
        ))}
      </div>
    </section>
  );
}
