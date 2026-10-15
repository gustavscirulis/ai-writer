import { create } from "zustand";
import * as tauri from "@/lib/tauri";
import type { NoteVersion } from "@/lib/tauri";
import { parseDocument } from "@/lib/frontmatter";
import { flushSave } from "@/lib/save";
import {
  acquireAgentEditing,
  consumeAgentReload,
  documentPath,
  isAgentTurnActive,
  markAgentReload,
} from "@/lib/agent-turn";
import { synchronizeEditorView } from "@/lib/editor-views";
import { useEditorStore } from "@/stores/editor-store";

interface HistoryState {
  /** Display path of the note whose history is open, or null when closed. */
  path: string | null;
  versions: NoteVersion[];
  selectedId: string | null;
  /** Version bodies keyed by `bodyKey`, so a coalesced version reloads. */
  bodies: Map<string, string>;
  error: string | null;
  restoring: boolean;

  open: (path: string) => Promise<void>;
  close: () => void;
  refresh: (path: string) => Promise<void>;
  select: (id: string) => void;
  move: (delta: number) => void;
  restore: () => Promise<void>;
}

export function bodyKey(version: NoteVersion) {
  return `${version.id}:${version.updatedAt}`;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function aliasesOf(path: string) {
  const key = documentPath(path);
  return [...useEditorStore.getState().openFiles.keys()].filter(
    (alias) => documentPath(alias) === key,
  );
}

export const useHistoryStore = create<HistoryState>((set, get) => {
  const load = async (path: string, version: NoteVersion | undefined) => {
    if (!version || get().bodies.has(bodyKey(version))) return;
    try {
      const raw = await tauri.readVersion(path, version.id);
      if (get().path !== path) return;
      const bodies = new Map(get().bodies);
      bodies.set(bodyKey(version), parseDocument(raw).body);
      set({ bodies });
    } catch (error) {
      if (get().path === path) set({ error: errorText(error) });
    }
  };
  // The preview diffs the selected version against the one before it.
  const loadSelection = (path: string) => {
    const { versions, selectedId } = get();
    const index = versions.findIndex((version) => version.id === selectedId);
    if (index < 0) return;
    void load(path, versions[index]);
    void load(path, versions[index + 1]);
  };

  return {
    path: null,
    versions: [],
    selectedId: null,
    bodies: new Map(),
    error: null,
    restoring: false,

    open: async (path) => {
      set({ path, versions: [], selectedId: null, bodies: new Map(), error: null });
      // The newest version should match what's on screen.
      try {
        for (const alias of aliasesOf(path)) await flushSave(alias);
      } catch (error) {
        console.error("[history] Could not save before opening history", error);
      }
      await get().refresh(path);
    },

    close: () =>
      set({ path: null, versions: [], selectedId: null, bodies: new Map(), error: null }),

    refresh: async (path) => {
      try {
        const versions = await tauri.listVersions(path);
        if (get().path !== path) return;
        const { selectedId } = get();
        const keep = versions.some((version) => version.id === selectedId);
        set({ versions, selectedId: keep ? selectedId : (versions[0]?.id ?? null) });
        loadSelection(path);
      } catch (error) {
        if (get().path === path) set({ error: errorText(error) });
      }
    },

    select: (id) => {
      const { path } = get();
      if (!path) return;
      set({ selectedId: id });
      loadSelection(path);
    },

    move: (delta) => {
      const { versions, selectedId } = get();
      const index = versions.findIndex((version) => version.id === selectedId);
      const next = versions[Math.max(0, Math.min(versions.length - 1, index + delta))];
      if (next && next.id !== selectedId) get().select(next.id);
    },

    restore: async () => {
      const { path, selectedId, versions, restoring } = get();
      if (!path || !selectedId || restoring || selectedId === versions[0]?.id) return;
      if (isAgentTurnActive(path)) {
        set({ error: "Wait for Co-writer to finish before restoring." });
        return;
      }
      set({ restoring: true, error: null });
      let release: (() => void) | null = null;
      try {
        release = acquireAgentEditing(path);
        for (const alias of aliasesOf(path)) await flushSave(alias);
        const content = await tauri.restoreVersion(path, selectedId);
        // Applied like an AI edit: one undoable step in every open alias.
        for (const alias of aliasesOf(path)) {
          const file = useEditorStore.getState().openFiles.get(alias);
          if (!file || file.diskContent === content) continue;
          markAgentReload(alias, file.reloadVersion + 1, file.frontmatter);
          useEditorStore.getState().reloadFromDisk(alias, content);
          synchronizeEditorView(alias);
          consumeAgentReload(alias, file.reloadVersion + 1);
        }
        get().close();
      } catch (error) {
        set({ error: `Could not restore this version: ${errorText(error)}` });
      } finally {
        release?.();
        set({ restoring: false });
      }
    },
  };
});
