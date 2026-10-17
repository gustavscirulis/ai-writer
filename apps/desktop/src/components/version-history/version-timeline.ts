import type { NoteVersion } from "@/hooks/use-version-history";

/** Extra room between days, in versions. */
const DAY_GAP = 0.9;
/** Track inset at both ends, in percent. */
const EDGE = 2;

export interface TimelineMark {
  version: NoteVersion;
  /** Centre of the mark, as a percentage of the track width. */
  at: number;
  /** The day label, on the first version of each day. */
  day: string | null;
}

function dayStart(ms: number) {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayLabel(ms: number, now = Date.now()): string {
  const days = Math.round((dayStart(now) - dayStart(ms)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

export function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * Versions (newest first) laid out oldest to newest along the track: every
 * version gets equal room, and a little more opens up between days.
 */
export function timelineMarks(versions: NoteVersion[], now = Date.now()): TimelineMark[] {
  const oldestFirst = [...versions].reverse();
  const units: number[] = [];
  const newDay: boolean[] = [];
  let x = 0;
  oldestFirst.forEach((version, i) => {
    newDay.push(i === 0 || dayStart(version.updatedAt) !== dayStart(oldestFirst[i - 1].updatedAt));
    if (i > 0) x += newDay[i] ? 1 + DAY_GAP : 1;
    units.push(x);
  });
  const total = x + 1;
  return oldestFirst.map((version, i) => ({
    version,
    at: EDGE + ((units[i] + 0.5) / total) * (100 - 2 * EDGE),
    day: newDay[i] ? dayLabel(version.updatedAt, now) : null,
  }));
}

/** Below this many pixels between versions, ticks are too close to point at. */
const CROWDED_SPACING = 8;

/** Whether versions sit too close together on a track `width` pixels wide to pick out one. */
export function isCrowded(positions: number[], width: number): boolean {
  for (let i = 1; i < positions.length; i++) {
    if (((positions[i] - positions[i - 1]) / 100) * width < CROWDED_SPACING) return true;
  }
  return false;
}

/** How far the pointer lens spreads the versions around it, as in the macOS Dock. */
const LENS_STRENGTH = 5;

/**
 * Positions bent by a fisheye lens at `focus` percent: close neighbours spread
 * apart, and the first and last versions stay put.
 */
export function magnify(positions: number[], focus: number, strength = 1): number[] {
  if (positions.length === 0) return positions;
  const lens = LENS_STRENGTH * strength;
  const first = positions[0];
  const last = positions[positions.length - 1];
  const centre = Math.max(first, Math.min(last, focus));
  return positions.map((at) => {
    const span = at >= centre ? last - centre : centre - first;
    if (span === 0) return at;
    const x = Math.abs(at - centre) / span;
    const bent = ((lens + 1) * x) / (lens * x + 1);
    return centre + Math.sign(at - centre) * bent * span;
  });
}

/** Indexes of the day labels that fit `minGap` percent apart, keeping the newest day. */
export function visibleDays(marks: TimelineMark[], positions: number[], minGap: number): number[] {
  const shown: number[] = [];
  for (let i = marks.length - 1; i >= 0; i--) {
    if (marks[i].day === null) continue;
    const last = shown[shown.length - 1];
    if (last === undefined || positions[last] - positions[i] >= minGap) shown.push(i);
  }
  return shown.reverse();
}

/** Index of the position closest to `at` percent along the track. */
export function nearestMark(positions: number[], at: number): number {
  let best = 0;
  positions.forEach((position, i) => {
    if (Math.abs(position - at) < Math.abs(positions[best] - at)) best = i;
  });
  return best;
}
