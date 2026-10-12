import type { NoteVersion } from "@/hooks/use-version-history";

export interface VersionGroup {
  label: string;
  versions: NoteVersion[];
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

/** Consecutive versions (newest first) grouped under day headings. */
export function groupVersions(versions: NoteVersion[], now = Date.now()): VersionGroup[] {
  const groups: VersionGroup[] = [];
  for (const version of versions) {
    const label = dayLabel(version.updatedAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.versions.push(version);
    else groups.push({ label, versions: [version] });
  }
  return groups;
}
