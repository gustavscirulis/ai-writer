import { useCallback } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { getWorkspaceChromeMode } from "@/lib/compact-mode";

export function useWorkspace() {
  const root = useWorkspaceStore((s) => s.root);
  const rawChromeMode = useWorkspaceStore((s) => s.chromeMode);
  const chromeMode = getWorkspaceChromeMode(root, rawChromeMode);
  const isIndexing = useWorkspaceStore((s) => s.isIndexing);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const recentWorkspaces = useWorkspaceStore((s) => s.recentWorkspaces);
  const removeRecentWorkspace = useWorkspaceStore((s) => s.removeRecentWorkspace);
  return {
    root,
    chromeMode,
    isIndexing,
    openWorkspace,
    recentWorkspaces,
    removeRecentWorkspace,
  };
}

export function useWorkspaceChromeMode() {
  const root = useWorkspaceStore((s) => s.root);
  const chromeMode = useWorkspaceStore((s) => s.chromeMode);
  return getWorkspaceChromeMode(root, chromeMode);
}

export function useIsCompactFileMode() {
  return useWorkspaceChromeMode() === "compact-file";
}

export function useIsStartupResolved() {
  return useWorkspaceStore((s) => s.isStartupResolved);
}

export function useWorkspaceRoot() {
  return useWorkspaceStore((s) => s.root);
}

export function useWorkspaceGeneration() {
  return useWorkspaceStore((s) => s.workspaceGeneration);
}

/** Close feedback is owned here so every close-workspace entry point reports
 * the same failure and callers cannot silently diverge. */
export function useCloseWorkspace() {
  const closeWorkspace = useWorkspaceStore((s) => s.closeWorkspace);
  return useCallback(() => {
    void closeWorkspace().catch((error: unknown) => {
      window.alert(
        `Failed to close workspace: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, [closeWorkspace]);
}

export const workspaceIdentity = () => {
  const { root, workspaceGeneration } = useWorkspaceStore.getState();
  return { root, generation: workspaceGeneration };
};
