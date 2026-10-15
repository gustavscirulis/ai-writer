import { useCallback, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  closeVersionHistory,
  moveVersionSelection,
  restoreSelectedVersion,
  selectVersion,
  useHistoryError,
  useHistoryRestoring,
  useSelectedVersionId,
  useVersions,
  type NoteVersion,
} from "@/hooks/use-version-history";
import { groupVersions, timeLabel } from "./version-groups";

const HEADER_BUTTON =
  "grid size-7 place-items-center rounded-[7px] text-[var(--text-icon-muted)] transition-colors duration-150 hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]";

const SOURCE_TAGS: Partial<Record<NoteVersion["source"], string>> = {
  agent: "Co-writer",
  restore: "Restored",
};

function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveVersionSelection(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeVersionHistory();
  }
}

export function HistoryPanel() {
  const versions = useVersions();
  const selectedId = useSelectedVersionId();
  const error = useHistoryError();
  const restoring = useHistoryRestoring();
  const currentId = versions[0]?.id;
  const focusList = useCallback((list: HTMLDivElement | null) => list?.focus(), []);
  const keepSelectedVisible = useCallback(
    (row: HTMLButtonElement | null) => row?.scrollIntoView({ block: "nearest" }),
    [],
  );

  return (
    <aside
      aria-label="Version history"
      onKeyDown={handleKeyDown}
      className="relative flex h-full min-w-0 shrink-0 flex-col border-l border-[var(--line-subtler)] bg-[var(--bg)] text-[13px] text-[var(--text-primary)]"
      style={{ width: "var(--agent-panel-width)" }}
    >
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center justify-between gap-3 pl-[18px] pr-2.5"
        style={{
          height: "calc(var(--chrome-control-height) + var(--chrome-control-padding) * 2)",
          paddingBlock: "var(--chrome-control-padding)",
        }}
      >
        <h2 data-tauri-drag-region className="text-[13px] font-semibold">
          Version history
        </h2>
        <button
          type="button"
          title="Close (Esc)"
          aria-label="Close version history"
          onClick={closeVersionHistory}
          className={HEADER_BUTTON}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.8} />
        </button>
      </header>
      <div
        ref={focusList}
        role="listbox"
        aria-label="Versions"
        aria-activedescendant={selectedId ? `version-${selectedId}` : undefined}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none"
      >
        {versions.length === 0 && !error && (
          <p className="px-2.5 py-2 text-[var(--text-muted)]">No earlier versions yet.</p>
        )}
        {groupVersions(versions).map((group) => (
          <div key={group.label} role="group" aria-label={group.label}>
            <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium text-[var(--text-muted)]">
              {group.label}
            </div>
            {group.versions.map((version) => {
              const selected = version.id === selectedId;
              const tag = SOURCE_TAGS[version.source];
              return (
                <button
                  key={version.id}
                  id={`version-${version.id}`}
                  ref={selected ? keepSelectedVisible : undefined}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  onClick={() => selectVersion(version.id)}
                  className="flex w-full items-baseline gap-2 rounded-[7px] px-2.5 py-1.5 text-left transition-colors duration-100 hover:bg-[var(--surface-subtle)] aria-selected:bg-[var(--surface-subtle)] aria-selected:font-medium"
                >
                  <span className="tabular-nums">
                    {version.id === currentId ? "Current version" : timeLabel(version.updatedAt)}
                  </span>
                  {version.id === currentId && (
                    <span className="tabular-nums text-[12px] font-normal text-[var(--text-muted)]">
                      {timeLabel(version.updatedAt)}
                    </span>
                  )}
                  {tag && (
                    <span className="ml-auto text-[11px] font-normal text-[var(--text-muted)]">
                      {tag}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <footer className="flex shrink-0 flex-col gap-2 border-t border-[var(--line-subtler)] p-3">
        {error && <p className="text-[12px] text-[var(--text-muted)]">{error}</p>}
        <button
          type="button"
          disabled={!selectedId || selectedId === currentId || restoring}
          onClick={() => void restoreSelectedVersion()}
          className="h-8 rounded-[7px] bg-[var(--surface-subtle)] text-[13px] font-medium transition-colors duration-150 hover:bg-[var(--line-subtle)] disabled:opacity-40 disabled:hover:bg-[var(--surface-subtle)]"
        >
          {restoring ? "Restoring…" : "Restore this version"}
        </button>
      </footer>
    </aside>
  );
}
