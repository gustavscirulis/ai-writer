import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { focusChatComposer, sendChat, setChatDraft } from "@/hooks/use-claude";
import { useAgent, useMcpServers, useNoteIsBlank } from "@/hooks/use-co-writer";
import {
  newNoteSuggestions,
  serversFootnote,
  starterText,
  suggestionIcon,
  toolSuggestions,
  type Suggestion,
} from "@/lib/co-writer-suggestions";

const stagger = (index: number) => ({ "--i": index }) as CSSProperties;

function pick(path: string, suggestion: Suggestion) {
  if (!suggestion.starter) return void sendChat(path, suggestion.label);
  setChatDraft(path, starterText(suggestion.label));
  focusChatComposer(path);
}

export function EmptyState({ path, busy }: { path: string; busy: boolean }) {
  const loaded = useMcpServers();
  const agent = useAgent();
  const blank = useNoteIsBlank(path);
  const servers = loaded === "unavailable" ? null : loaded;
  const suggestions = blank ? newNoteSuggestions(servers) : toolSuggestions(servers);
  return (
    <div className="flex min-h-full flex-col pt-3">
      <h3
        className="co-writer-enter text-[21px] font-medium leading-tight tracking-[-0.02em] text-[var(--text-primary)] [text-wrap:balance]"
        style={stagger(0)}
      >
        {blank ? "What are we writing?" : "What are we working on?"}
      </h3>
      <p
        className="co-writer-enter mt-1.5 text-[13px] leading-normal text-[var(--text-muted)]"
        style={stagger(1)}
      >
        {blank
          ? "Start with research, an outline or a first draft."
          : "Ask for research, a first draft or edits to this note."}
      </p>
      {loaded && blank !== null && (
        <div className="mt-auto pt-6">
          <div className="-mx-2.5 flex flex-col">
            {suggestions.map((suggestion, i) => (
              <button
                key={suggestion.label}
                type="button"
                disabled={busy}
                onClick={() => pick(path, suggestion)}
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
                {!suggestion.starter && (
                  <span className="co-writer-suggestion-enter absolute right-2.5 grid text-[var(--text-muted)]">
                    <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={13} strokeWidth={1.8} />
                  </span>
                )}
              </button>
            ))}
          </div>
          <p
            className="co-writer-enter mt-4 text-[11.5px] leading-normal text-[var(--text-icon-muted)] [text-wrap:pretty]"
            style={stagger(6)}
          >
            {serversFootnote(servers, agent.label)}
          </p>
        </div>
      )}
    </div>
  );
}
