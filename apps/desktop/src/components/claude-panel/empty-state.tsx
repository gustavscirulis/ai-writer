import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { sendChat } from "@/hooks/use-claude";
import { useMcpServers } from "@/hooks/use-co-writer";
import { serversFootnote, suggestionIcon, toolSuggestions } from "@/lib/co-writer-suggestions";

const stagger = (index: number) => ({ "--i": index }) as CSSProperties;

export function EmptyState({ path, busy }: { path: string | null; busy: boolean }) {
  const loaded = useMcpServers();
  const servers = loaded === "unavailable" ? null : loaded;
  return (
    <div className="flex min-h-full flex-col justify-end pt-6">
      <h3
        className="co-writer-enter text-[21px] font-medium leading-tight tracking-[-0.02em] text-[var(--text-primary)] [text-wrap:balance]"
        style={stagger(0)}
      >
        What are we working on?
      </h3>
      <p
        className="co-writer-enter mt-1.5 text-[13px] leading-normal text-[var(--text-muted)]"
        style={stagger(1)}
      >
        Ask for research, a first draft or edits to this note.
      </p>
      {loaded && (
        <>
          <div className="-mx-2.5 mt-3 flex flex-col">
            {toolSuggestions(servers).map((suggestion, i) => (
              <button
                key={suggestion.label}
                type="button"
                disabled={!path || busy}
                onClick={() => path && void sendChat(path, suggestion.label)}
                className="co-writer-suggestion co-writer-enter relative flex min-h-[32px] items-center gap-2.5 rounded-lg px-2.5 py-[6px] text-left text-[13px] leading-snug text-[var(--text-secondary)] transition-colors duration-150 hover:enabled:bg-[var(--item-hover-bg)] hover:enabled:text-[var(--text-primary)] active:enabled:scale-[0.99] disabled:opacity-50"
                style={stagger(2 + i)}
              >
                <span className="grid text-[var(--text-icon-muted)]">
                  <HugeiconsIcon
                    icon={suggestionIcon(suggestion.tool)}
                    size={15}
                    strokeWidth={1.8}
                  />
                </span>
                <span className="min-w-0 flex-1 pr-5 [text-wrap:pretty]">{suggestion.label}</span>
                <span className="co-writer-suggestion-enter absolute right-2.5 grid text-[var(--text-muted)]">
                  <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={13} strokeWidth={1.8} />
                </span>
              </button>
            ))}
          </div>
          <p
            className="co-writer-enter mt-4 text-[11.5px] leading-normal text-[var(--text-icon-muted)] [text-wrap:pretty]"
            style={stagger(6)}
          >
            {serversFootnote(servers)}
          </p>
        </>
      )}
    </div>
  );
}
