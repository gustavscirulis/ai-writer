import { useCallback } from "react";
import {
  useRefreshDirectory,
  useRewriteExpandedDir,
  useRewritePinnedPath,
} from "@/hooks/use-file-tree";
import { renameOpenFile, rewritePathPrefix } from "@/hooks/editor-api";
import * as tauri from "@/lib/tauri";
import { getParentDir } from "@/lib/paths";
import type { DirEntry } from "@/types/fs";
import { canMoveInto, computeMovePath } from "./tree-move";
import { workspaceIdentity } from "@/hooks/use-workspace";
import { beginPathMutation } from "@/lib/agent-turn";
import { captureFeedbackPathRewrite } from "@/hooks/feedback-api";
import { rewriteChatPaths } from "@/hooks/use-claude";

export type MoveOutcome =
  | { status: "moved"; entry: DirEntry; newPath: string }
  | { status: "skipped"; entry: DirEntry }
  | { status: "exists"; entry: DirEntry; newPath: string }
  | { status: "error"; entry: DirEntry; error: unknown };

/**
 * The single write path for relocating a file or folder. Both inline rename and
 * drag-to-move funnel through here so on-disk renames and the corresponding
 * editor/workspace state rewrites stay in lockstep.
 */
export function useMoveEntry() {
  const refreshDirectory = useRefreshDirectory();
  const rewriteExpandedDir = useRewriteExpandedDir();
  const rewritePinnedPath = useRewritePinnedPath();

  // Rename `entry` on disk to `newPath`, then rewrite editor/workspace state and
  // refresh the affected directories. `newPath` may differ from `entry.path` in
  // its name (rename) or its parent (move) — the handling is identical.
  const applyPathChange = useCallback(
    async (entry: DirEntry, newPath: string): Promise<void> => {
      const release = beginPathMutation();
      const origin = workspaceIdentity();
      const rewriteFeedback = captureFeedbackPathRewrite();
      try {
        const identity = await tauri.renameEntry(entry.path, newPath);
        await rewriteFeedback(entry.path, newPath, entry.is_dir);
        if (origin.root)
          await rewriteChatPaths(origin.root, identity.from, identity.to, entry.is_dir);
        const current = workspaceIdentity();
        if (current.root !== origin.root || current.generation !== origin.generation) return;
        if (entry.is_dir) {
          rewritePathPrefix(entry.path, newPath);
          rewriteExpandedDir(entry.path, newPath);
          rewritePinnedPath(entry.path, newPath);
        } else {
          renameOpenFile(entry.path, newPath);
          rewritePinnedPath(entry.path, newPath);
        }
        const fromParent = getParentDir(entry.path);
        const toParent = getParentDir(newPath);
        await refreshDirectory(fromParent);
        if (toParent !== fromParent) await refreshDirectory(toParent);
      } finally {
        release();
      }
    },
    [refreshDirectory, rewriteExpandedDir, rewritePinnedPath],
  );

  // Move `entry` into `destDir`, preserving its name. Returns an outcome instead
  // of alerting so callers can batch many moves and surface a single summary.
  const moveEntry = useCallback(
    async (entry: DirEntry, destDir: string): Promise<MoveOutcome> => {
      if (!canMoveInto(entry.path, entry.is_dir, destDir)) {
        return { status: "skipped", entry };
      }
      const newPath = computeMovePath(entry, destDir);
      if (await tauri.fileExists(newPath)) {
        return { status: "exists", entry, newPath };
      }
      try {
        await applyPathChange(entry, newPath);
        return { status: "moved", entry, newPath };
      } catch (error) {
        return { status: "error", entry, error };
      }
    },
    [applyPathChange],
  );

  return { applyPathChange, moveEntry };
}
