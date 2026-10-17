import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
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
import { useLensStrength } from "./use-lens-strength";
import { useVersionTrack } from "./use-version-track";
import {
  dayLabel,
  isCrowded,
  magnify,
  nearestMark,
  timeLabel,
  timelineMarks,
  visibleDays,
} from "./version-timeline";
import "./version-history.css";

const SOURCE_TAGS: Partial<Record<NoteVersion["source"], string>> = {
  agent: "Co-writer",
  restore: "Restored",
};

/** Comfortably longer than the 150ms exit transition. */
const EXIT_FALLBACK_MS = 400;

/** Room a day label needs, so neighbouring labels never overlap. */
const DAY_LABEL_WIDTH = 72;

/** Older versions sit to the left, so ← and ↓ step back in time. */
const STEPS: Record<string, number> = { ArrowLeft: 1, ArrowDown: 1, ArrowRight: -1, ArrowUp: -1 };

const BUTTON =
  "h-[26px] rounded-[7px] px-2.5 text-[12px] transition-[background-color,color,scale] duration-150 ease-out enabled:active:scale-[0.96]";
const GHOST_BUTTON = `${BUTTON} text-[var(--text-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--text-primary)]`;
const PRIMARY_BUTTON = `${BUTTON} bg-[var(--text-primary)] font-medium text-[var(--bg-base)] enabled:hover:bg-[color-mix(in_srgb,var(--text-primary)_86%,transparent)] disabled:opacity-60`;

/**
 * Ticks swell with their closeness to the pointer, like icons in the macOS
 * Dock, so the one under it stands out without snapping from tick to tick.
 */
function markTransform(x: number, pointerX: number | null, strength: number) {
  if (pointerX === null || strength === 0) return `translateX(${x}px)`;
  const near = (reach: number) => Math.exp(-(((x - pointerX) / reach) ** 2));
  const tall = 1 + strength * (0.5 * near(30) + 0.5 * near(7));
  const wide = 1 + strength * 0.6 * near(7);
  return `translateX(${x}px) scale(${wide.toFixed(3)}, ${tall.toFixed(3)})`;
}

function whenLabel(version: NoteVersion) {
  return `${dayLabel(version.updatedAt)}, ${timeLabel(version.updatedAt)}`;
}

interface HistoryDockProps {
  /** False while the dock plays its exit transition. */
  open: boolean;
  onExited: () => void;
}

export function HistoryDock({ open, onExited }: HistoryDockProps) {
  const versions = useVersions();
  const selectedId = useSelectedVersionId();
  const error = useHistoryError();
  const restoring = useHistoryRestoring();
  const track = useVersionTrack(open);
  // `focus` is the pointer's last spot on the track, in percent; the lens eases out there.
  const [hover, setHover] = useState<{ index: number; focus: number | null; active: boolean }>({
    index: -1,
    focus: null,
    active: false,
  });
  const strength = useLensStrength(hover.active);
  // A hidden window runs no transitions, so transitionend alone could leave the dock mounted.
  useEffect(() => {
    if (open) return;
    const timer = setTimeout(onExited, EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [open, onExited]);
  const [dragging, setDragging] = useState(false);
  const marks = useMemo(() => timelineMarks(versions), [versions]);
  const base = useMemo(() => marks.map((mark) => mark.at), [marks]);
  // Only a crowded track needs the lens; with room to spare, hovering just highlights the tick.
  const crowded = useMemo(() => isCrowded(base, track.width), [base, track.width]);
  const lens = crowded && hover.focus !== null ? strength : 0;
  const positions = useMemo(
    () => (lens === 0 || hover.focus === null ? base : magnify(base, hover.focus, lens)),
    [base, hover.focus, lens],
  );

  const position = marks.findIndex((mark) => mark.version.id === selectedId);
  const selected = marks[position]?.version;
  const atNewest = !selected || selected.id === versions[0]?.id;
  const tag = selected && SOURCE_TAGS[selected.source];
  const shownDays = new Set(
    track.width ? visibleDays(marks, positions, (DAY_LABEL_WIDTH / track.width) * 100) : [],
  );
  const pointerX = hover.focus === null ? null : (hover.focus / 100) * track.width;
  const tip = marks[hover.index];
  const tipAt = positions[hover.index];

  const pick = (index: number) => {
    const id = marks[index]?.version.id;
    if (id && id !== selectedId) selectVersion(id);
  };
  // The lens is centred on the pointer, so the pointer's spot on the track is also its focus.
  const aim = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const focus = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const index = nearestMark(crowded ? magnify(base, focus) : base, focus);
    setHover({ index, focus, active: true });
    return index;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = STEPS[event.key];
    if (step) moveVersionSelection(step);
    else if (event.key === "Home") pick(0);
    else if (event.key === "End") pick(marks.length - 1);
    else if (event.key === "Escape") closeVersionHistory();
    else return;
    event.preventDefault();
  };

  return (
    <section
      aria-label="Version history"
      data-open={open || undefined}
      inert={!open}
      className="history-dock"
      onKeyDown={handleKeyDown}
      onTransitionEnd={(event) => {
        if (!open && event.target === event.currentTarget && event.propertyName === "opacity")
          onExited();
      }}
    >
      <div className="history-dock-row">
        <p className="history-dock-when">
          {selected &&
            (atNewest ? (
              <>
                Current version
                <span className="history-dock-muted">{timeLabel(selected.updatedAt)}</span>
              </>
            ) : (
              whenLabel(selected)
            ))}
          {(error ?? tag) && <span className="history-dock-note">{error ?? tag}</span>}
        </p>
        <div className="history-dock-actions" data-shown={!atNewest || undefined} inert={atNewest}>
          <button
            type="button"
            className={GHOST_BUTTON}
            onClick={() => {
              pick(marks.length - 1);
              track.focus();
            }}
          >
            Back to now
          </button>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={restoring}
            onClick={() => void restoreSelectedVersion()}
          >
            {restoring ? "Restoring…" : "Restore"}
          </button>
        </div>
      </div>
      <div className="history-dock-timeline" data-magnified={lens > 0 || undefined}>
        <div
          ref={track.ref}
          role="slider"
          tabIndex={0}
          aria-label="Version"
          aria-valuemin={1}
          aria-valuemax={Math.max(1, marks.length)}
          aria-valuenow={position + 1}
          aria-valuetext={selected && (atNewest ? "Current version" : whenLabel(selected))}
          data-dragging={dragging || undefined}
          data-lens={hover.active || undefined}
          className="history-track"
          onPointerDown={(event) => {
            if (event.button !== 0 || marks.length === 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
            pick(aim(event));
          }}
          onPointerMove={(event) => {
            if (marks.length === 0) return;
            const index = aim(event);
            if (dragging) pick(index);
          }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onPointerLeave={() => setHover((last) => ({ ...last, active: false }))}
        >
          <span className="history-rail" />
          {track.width > 0 &&
            marks.map((mark, index) => (
              <span
                key={mark.version.id}
                className="history-mark"
                data-agent={mark.version.source === "agent" || undefined}
                data-future={index > position || undefined}
                data-hover={(hover.active && index === hover.index) || undefined}
                style={{
                  transform: markTransform(
                    (positions[index] / 100) * track.width,
                    pointerX,
                    strength,
                  ),
                }}
              />
            ))}
          {selected && (
            <span
              className="history-head-layer"
              style={{ transform: `translateX(${positions[position]}%)` }}
            >
              <span className="history-head" />
            </span>
          )}
        </div>
        <div className="history-days" aria-hidden="true">
          {track.width > 0 &&
            marks.map((mark, index) => {
              if (mark.day === null) return null;
              const x = (positions[index] / 100) * track.width;
              return (
                <span
                  key={mark.version.id}
                  data-hidden={!shownDays.has(index) || undefined}
                  data-end={x + DAY_LABEL_WIDTH > track.width || undefined}
                  style={{ transform: `translateX(${x}px)` }}
                >
                  {mark.day}
                </span>
              );
            })}
        </div>
      </div>
      {tip && (
        <div
          aria-hidden="true"
          className="history-tip-layer"
          data-show={(hover.active && !dragging) || undefined}
          style={{ transform: `translateX(${tipAt}%)` }}
        >
          <div
            className="history-tip"
            data-align={tipAt < 12 ? "start" : tipAt > 88 ? "end" : undefined}
          >
            {whenLabel(tip.version)}
            {SOURCE_TAGS[tip.version.source] && <span>{SOURCE_TAGS[tip.version.source]}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
