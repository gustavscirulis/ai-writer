import { useState, type CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowTurnBackwardIcon, QuillWrite01Icon } from "@hugeicons/core-free-icons";
import { sendChat } from "@/hooks/use-claude";
import { useMcpServers, useNoteSuggestions, type Suggestion } from "@/hooks/use-co-writer";
import { fallbackSuggestions, serversFootnote, suggestionIcon } from "@/lib/co-writer-suggestions";

const stagger = (index: number) => ({ "--i": index }) as CSSProperties;

export function EmptyState({ path, busy }: { path: string | null; busy: boolean }) {
  const servers = useMcpServers();
  const latest = useNoteSuggestions(path) ?? fallbackSuggestions(servers);
  // Freeze the list under the pointer or focus so a late swap can't change what a click sends.
  const [held, setHeld] = useState<Suggestion[] | null>(null);
  const shown = held ?? latest;
  const hold = () => setHeld((current) => current ?? latest);
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center pb-8 pt-6 text-center">
        <div
          className="co-writer-enter grid size-10 place-items-center rounded-xl bg-[var(--surface-card)] text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--line-subtle),0_1px_2px_rgba(0,0,0,0.06)]"
          style={stagger(0)}
        >
          <HugeiconsIcon icon={QuillWrite01Icon} size={18} strokeWidth={1.8} />
        </div>
        <h3
          className="co-writer-enter mt-3.5 text-[15px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]"
          style={stagger(1)}
        >
          What are we working on?
        </h3>
        <p
          className="co-writer-enter mt-1 text-[13px] leading-normal text-[var(--text-muted)] [text-wrap:balance]"
          style={stagger(2)}
        >
          Ask for research, a first draft or edits to this note.
        </p>
        <div
          key={shown.map((suggestion) => suggestion.label).join("\n")}
          className="co-writer-enter mt-[22px] flex w-full flex-col rounded-xl p-1 text-left shadow-[inset_0_0_0_1px_var(--line-subtler)]"
          style={stagger(3)}
          onPointerEnter={hold}
          onFocus={hold}
          onPointerLeave={(event) => {
            if (!event.currentTarget.contains(document.activeElement)) setHeld(null);
          }}
          onBlur={(event) => {
            const list = event.currentTarget;
            if (!list.contains(event.relatedTarget as Node | null) && !list.matches(":hover"))
              setHeld(null);
          }}
        >
          {shown.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              disabled={!path || busy}
              onClick={() => path && void sendChat(path, suggestion.label)}
              className="co-writer-suggestion relative flex min-h-[34px] items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] leading-snug text-[var(--text-secondary)] transition-colors duration-150 hover:enabled:bg-[var(--item-hover-bg)] hover:enabled:text-[var(--text-primary)] active:enabled:scale-[0.99] disabled:opacity-50"
            >
              <span className="grid text-[var(--text-icon-muted)]">
                <HugeiconsIcon icon={suggestionIcon(suggestion.tool)} size={15} strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1 pr-4 [text-wrap:pretty]">{suggestion.label}</span>
              <span className="co-writer-suggestion-enter absolute right-2.5 grid text-[var(--text-muted)]">
                <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={13} strokeWidth={1.8} />
              </span>
            </button>
          ))}
        </div>
      </div>
      <p
        className="co-writer-enter text-[11px] leading-normal text-[var(--text-icon-muted)]"
        style={stagger(4)}
      >
        {serversFootnote(servers)}
      </p>
    </div>
  );
}
