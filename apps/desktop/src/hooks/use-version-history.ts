import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useShallow } from "zustand/react/shallow";
import { bodyKey, useHistoryStore } from "@/stores/history-store";
import { documentPath } from "@/lib/agent-turn";
import { getActiveFilePath } from "@/hooks/editor-api";
import type { NoteVersion } from "@/lib/tauri";

export type { NoteVersion, VersionSource } from "@/lib/tauri";

export function useHistoryPath() {
  return useHistoryStore((s) => s.path);
}
export function useVersions() {
  return useHistoryStore((s) => s.versions);
}
export function useSelectedVersionId() {
  return useHistoryStore((s) => s.selectedId);
}
export function useHistoryError() {
  return useHistoryStore((s) => s.error);
}
export function useHistoryRestoring() {
  return useHistoryStore((s) => s.restoring);
}

export interface VersionPreview {
  version: NoteVersion;
  body: string;
  /** The previous version's body; equal to `body` for the oldest version. */
  original: string;
}

function selectPreview(
  versions: NoteVersion[],
  selectedId: string | null,
  bodies: Map<string, string>,
): VersionPreview | null {
  const index = versions.findIndex((version) => version.id === selectedId);
  if (index < 0) return null;
  const body = bodies.get(bodyKey(versions[index]));
  const previous = versions[index + 1];
  const original = previous ? bodies.get(bodyKey(previous)) : body;
  return body === undefined || original === undefined
    ? null
    : { version: versions[index], body, original };
}

/** Null while the selected version (or the one it is compared with) is loading. */
export function useVersionPreview() {
  return useHistoryStore(useShallow((s) => selectPreview(s.versions, s.selectedId, s.bodies)));
}

export const openVersionHistory = (path: string) => useHistoryStore.getState().open(path);
export const closeVersionHistory = () => useHistoryStore.getState().close();
export const selectVersion = (id: string) => useHistoryStore.getState().select(id);
export const moveVersionSelection = (delta: number) => useHistoryStore.getState().move(delta);
export const restoreSelectedVersion = () => useHistoryStore.getState().restore();

export function toggleVersionHistory(path = getActiveFilePath()) {
  if (useHistoryStore.getState().path !== null) closeVersionHistory();
  else if (path) void openVersionHistory(path);
}

/** Refresh the open history list whenever native code records a version of that note. */
export function useVersionHistoryEvents() {
  useEffect(() => {
    const unlisten = listen<{ path: string }>("history:changed", (event) => {
      const { path } = useHistoryStore.getState();
      if (path && documentPath(path) === event.payload.path)
        void useHistoryStore.getState().refresh(path);
    });
    return () => void unlisten.then((fn) => fn());
  }, []);
}
