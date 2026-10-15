import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import { groupAllowedTools } from "@/lib/tool-request-summary";
import { useAllowedTools } from "./use-allowed-tools";

export const ALLOWED_TOOLS_KEY = "co-writer.allowed-tools";
const DEF = SETTINGS_SCHEMA.find((def) => def.key === ALLOWED_TOOLS_KEY)!;
export const CO_WRITER_CATEGORY = DEF.category;

/** Rows appended to the Co-writer settings card. */
export function AllowedToolsRows({ isActive }: { isActive: boolean }) {
  const { tools, error, revoke } = useAllowedTools(isActive);
  return <AllowedTools tools={tools} error={error} onRevoke={revoke} />;
}

const REVEAL_ON_HOVER =
  "opacity-0 transition-[opacity,background-color,color] duration-150 focus-visible:opacity-100";

export function AllowedTools({
  tools,
  error,
  onRevoke,
}: {
  tools: string[] | null;
  error: string | null;
  onRevoke: (tools: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--line-subtler)] px-4 py-3.5">
      <div>
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{DEF.label}</div>
        <div className="mt-0.5 text-[13px] text-[var(--text-muted)]">{DEF.description}</div>
        {error && (
          <div role="alert" className="mt-2 text-[13px] text-[var(--text-error)]">
            {error}
          </div>
        )}
      </div>
      {tools && (
        <div className="rounded-[10px] bg-[var(--surface-input)] p-1">
          {tools.length === 0 && (
            <div className="px-2 py-1.5 text-[13px] text-[var(--text-muted)]">Nothing yet.</div>
          )}
          {groupAllowedTools(tools).map((group, i) => (
            <section
              key={group.source}
              aria-label={group.source}
              className={`group/source ${i === 0 ? "" : "mt-1 border-t border-[var(--line-subtler)] pt-1"}`}
            >
              <div className="flex h-[30px] items-center gap-1.5 pr-1 pl-2 text-[12px]">
                <span className="font-medium text-[var(--text-muted)]">{group.source}</span>
                <span className="text-[var(--text-icon-muted)] tabular-nums">
                  {group.tools.length}
                </span>
                {group.tools.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onRevoke(group.tools.map((t) => t.tool))}
                    aria-label={`Revoke all ${group.source} tools`}
                    className={`ml-auto rounded-full px-2 py-0.5 text-[var(--text-muted)] group-hover/source:opacity-100 hover:bg-[var(--surface-subtle-strong)] hover:text-[var(--text-primary)] ${REVEAL_ON_HOVER}`}
                  >
                    Revoke all
                  </button>
                )}
              </div>
              <ul>
                {group.tools.map(({ tool, name }) => (
                  <li
                    key={tool}
                    title={tool}
                    className="group/tool flex h-[30px] items-center justify-between gap-2 rounded-md pr-1 pl-2 hover:bg-[var(--item-hover-bg)]"
                  >
                    <span className="truncate text-[13px] text-[var(--text-secondary)]">
                      {name}
                    </span>
                    <button
                      type="button"
                      onClick={() => onRevoke([tool])}
                      aria-label={`Revoke ${name} (${group.source})`}
                      className={`grid size-[22px] shrink-0 place-items-center rounded-full text-[var(--text-muted)] group-hover/tool:opacity-100 hover:bg-[var(--surface-subtle-strong)] hover:text-[var(--text-primary)] active:scale-[0.92] ${REVEAL_ON_HOVER}`}
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
