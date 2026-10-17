import { useLayoutEffect, useRef } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Clock01Icon, SidebarRightIcon } from "@hugeicons/core-free-icons";
import { toggleChatPanel } from "@/hooks/use-claude";
import { toggleVersionHistory } from "@/hooks/use-version-history";

// The free icon set has no solid variants, so the pressed glyphs are drawn here.
const CLOCK_FILLED: IconSvgElement = [
  [
    "path",
    {
      d: "M12 1.25a10.75 10.75 0 1 0 0 21.5a10.75 10.75 0 1 0 0-21.5ZM11.15 7.5H12.85V11.65L14.6 13.4L13.4 14.6L11.15 12.35Z",
      fill: "currentColor",
      fillRule: "evenodd",
      key: "0",
    },
  ],
];
const SIDEBAR_RIGHT_FILLED: IconSvgElement = [
  ...SidebarRightIcon.filter(([, attrs]) => attrs.key !== "2").map(
    ([tag, attrs]) => [tag, { ...attrs, strokeWidth: "2" }] as const,
  ),
  [
    "path",
    {
      d: "M14.5 3C17.5 3 19 3 20.08 3.92C20.51 4.25 20.89 4.68 21.19 5.16C22 6.47 22 8.31 22 12C22 15.69 22 17.53 21.19 18.84C20.89 19.33 20.51 19.75 20.08 20.08C19 21 17.5 21 14.5 21Z",
      fill: "currentColor",
      key: "fill",
    },
  ],
];

const TOOL =
  "group flex size-7 items-center justify-center rounded-md text-[var(--fg-base)] transition-[background-color,scale] duration-150 ease-out hover:bg-[var(--surface-subtle)] active:scale-[0.94]";
const GLYPH =
  "opacity-60 transition-opacity group-hover:opacity-100 group-aria-pressed:opacity-100";

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
      className="absolute right-2.5 z-50 flex h-8 items-center gap-1.5"
      style={{ top: "var(--chrome-control-padding)" }}
    >
      {filePath && (
        <button
          type="button"
          onClick={() => toggleVersionHistory(filePath)}
          aria-label="Version history"
          aria-pressed={historyOpen}
          title="Version history (⌘⇧H)"
          className={TOOL}
        >
          <span className={GLYPH}>
            {historyOpen ? (
              <HugeiconsIcon icon={CLOCK_FILLED} size={18} />
            ) : (
              <HugeiconsIcon icon={Clock01Icon} size={18} strokeWidth={2} />
            )}
          </span>
        </button>
      )}
      <button
        type="button"
        onClick={toggleChatPanel}
        aria-label="Co-writer"
        aria-pressed={chatOpen}
        title="Co-writer (⌘⇧L)"
        className={TOOL}
      >
        <span className={GLYPH}>
          {chatOpen ? (
            <HugeiconsIcon icon={SIDEBAR_RIGHT_FILLED} size={18} />
          ) : (
            <HugeiconsIcon icon={SidebarRightIcon} size={18} strokeWidth={2} />
          )}
        </span>
      </button>
    </div>
  );
}
