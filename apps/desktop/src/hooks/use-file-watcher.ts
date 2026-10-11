import { agentIORevision, documentPath, isAgentEditing } from "@/lib/agent-turn";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import * as editorApi from "./editor-api";
import * as tauri from "@/lib/tauri";
import { cancelSave, isSaveInFlight } from "@/lib/save";
import { isWorkspaceEventCurrent, type WorkspaceIdentity } from "@/lib/workspace-events";
import type { WriteResult } from "@/types/fs";

interface FileChangePayload {
  path: string;
  kind: "modified" | "created" | "deleted" | "renamed";
  workspace: WorkspaceIdentity | null;
}

interface IndexCompletePayload {
  workspace: WorkspaceIdentity;
  fileCount: number;
}

const WATCHER_DEBUG = import.meta.env.DEV;

function currentWorkspaceIdentity(): WorkspaceIdentity | null {
  const { root, workspaceEpoch } = useWorkspaceStore.getState();
  return root !== null && workspaceEpoch !== null ? { root, epoch: workspaceEpoch } : null;
}

export function useFileWatcher() {
  useEffect(() => {
    const unlistenFile = listen<FileChangePayload>("fs:file-changed", (event) => {
      const { path, kind, workspace } = event.payload;
      if (!isWorkspaceEventCurrent(workspace, currentWorkspaceIdentity())) return;
      if (WATCHER_DEBUG) console.debug("[watcher] fs:file-changed", kind, path);
      useWorkspaceStore.getState().bumpSidebarMetadataVersion();
      const openFiles = editorApi.getOpenFiles();
      const target = documentPath(path);
      const aliases = [...openFiles.keys()].filter((display) => documentPath(display) === target);
      if (!aliases.length) return;
      if (kind === "deleted") return;
      if (aliases.some(isSaveInFlight) || isAgentEditing(target)) return;
      const ioRevision = agentIORevision(target);

      for (const alias of aliases) cancelSave(alias);
      void tauri.readFile(target).then((content) => {
        if (
          ioRevision !== agentIORevision(target) ||
          isAgentEditing(target) ||
          !isWorkspaceEventCurrent(workspace, currentWorkspaceIdentity())
        )
          return;
        for (const [alias, latest] of editorApi.getOpenFiles()) {
          if (documentPath(alias) !== target || content.content === latest.diskContent) continue;
          if (isSaveInFlight(alias)) continue;
          if (WATCHER_DEBUG) console.debug("[watcher] reload-from-disk", alias);
          editorApi.reloadFromDisk(alias, content.content);
        }
      });
    });

    const unlistenIndexComplete = listen<IndexCompletePayload>("index:complete", (event) => {
      if (isWorkspaceEventCurrent(event.payload.workspace, currentWorkspaceIdentity())) {
        useWorkspaceStore.setState((state) => ({
          fileCount: event.payload.fileCount,
          isIndexing: false,
          sidebarMetadataVersion: state.sidebarMetadataVersion + 1,
        }));
      }
    });

    const unlistenSidebarMetadata = listen<WriteResult>("sidebar:metadata-changed", (event) => {
      const { bumpSidebarMetadataVersion, updateEntryModifiedAt } = useWorkspaceStore.getState();
      bumpSidebarMetadataVersion();
      updateEntryModifiedAt(event.payload.path, event.payload.modified_at);
    });

    const unlistenSettings = listen<WorkspaceIdentity>("settings:changed", (event) => {
      if (!isWorkspaceEventCurrent(event.payload, currentWorkspaceIdentity())) return;
      void useSettingsStore.getState().loadSettings();
    });

    const unlistenDir = listen<FileChangePayload>("fs:directory-changed", (event) => {
      const { path, workspace } = event.payload;
      if (!isWorkspaceEventCurrent(workspace, currentWorkspaceIdentity())) return;
      if (WATCHER_DEBUG) console.debug("[watcher] fs:directory-changed", path);
      const { root, expandedDirs, invalidatePath, refreshDirectory, bumpSidebarMetadataVersion } =
        useWorkspaceStore.getState();
      bumpSidebarMetadataVersion();

      // For visible directories (expanded or root), refresh in-place so the
      // old entries stay visible until new data arrives.  Calling
      // invalidatePath first would delete the cache, causing the tree to
      // flash empty while the async refresh is in flight.
      if (expandedDirs.has(path) || path === root) {
        void refreshDirectory(path);
      } else {
        invalidatePath(path);
      }

      const parent = path.substring(0, path.lastIndexOf("/"));
      if (parent) {
        if (expandedDirs.has(parent) || parent === root) {
          void refreshDirectory(parent);
        } else {
          invalidatePath(parent);
        }
      }
    });

    return () => {
      void unlistenFile.then((fn) => fn());
      void unlistenIndexComplete.then((fn) => fn());
      void unlistenSidebarMetadata.then((fn) => fn());
      void unlistenSettings.then((fn) => fn());
      void unlistenDir.then((fn) => fn());
    };
  }, []);
}
