import { useLayoutEffect, useRef } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BubbleChatIcon, Clock01Icon } from "@hugeicons/core-free-icons";
import { toggleChatPanel } from "@/hooks/use-claude";
import { toggleVersionHistory } from "@/hooks/use-version-history";

const SEGMENT =
  "flex h-7 items-center gap-1.5 rounded-[7px] pl-2 pr-2.5 text-[12.5px] text-[var(--text-muted)] transition-[background-color,color,scale] duration-150 ease-out hover:text-[var(--text-primary)] active:scale-[0.97] aria-pressed:bg-[var(--tab-active-bg)] aria-pressed:text-[var(--text-primary)]";

interface NoteToolsProps {
  filePath: string | null;
  historyOpen: boolean;
  chatOpen: boolean;
}

/**
 * Stays at the window's top right whether or not Co-writer is open, so the
 * button that opened something is the one that closes it. Publishes its width
 * as `--note-tools-width` so the tabs and the Co-writer header leave room.
 */
export function NoteTools({ filePath, historyOpen, chatOpen }: NoteToolsProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const layout = node?.closest<HTMLElement>("[data-app-layout]");
    if (!node || !layout) return;
    const publish = () => layout.style.setProperty("--note-tools-width", `${node.offsetWidth}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      layout.style.removeProperty("--note-tools-width");
    };
  }, []);

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Note tools"
      className="absolute right-2.5 z-50 flex gap-0.5 rounded-[9px] bg-[var(--surface-subtle)] p-0.5 shadow-[inset_0_0_0_1px_var(--line-subtler)]"
      style={{ top: "var(--chrome-control-padding)" }}
    >
      {filePath && (
        <button
          type="button"
          onClick={() => toggleVersionHistory(filePath)}
          aria-label="Version history"
          aria-pressed={historyOpen}
          title="Version history (⌘⇧H)"
          className={SEGMENT}
        >
          <HugeiconsIcon icon={Clock01Icon} size={15} strokeWidth={1.8} />
          History
        </button>
      )}
      <button
        type="button"
        onClick={toggleChatPanel}
        aria-label="Co-writer"
        aria-pressed={chatOpen}
        title="Co-writer (⌘⇧L)"
        className={SEGMENT}
      >
        <HugeiconsIcon icon={BubbleChatIcon} size={15} strokeWidth={1.8} />
        Co-writer
      </button>
    </div>
  );
}
