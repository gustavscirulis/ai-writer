import { useEffect, useMemo, useState } from "react";
import { useFuzzySearch } from "@/components/command-palette/use-fuzzy-search";
import * as tauri from "@/lib/tauri";
import { getRelativePath } from "@/lib/paths";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { SearchResult } from "@/types/fs";

const LIMIT = 8;

/** Notes for the `@` menu: recent ones for a bare `@`, index matches otherwise; never `exclude`. */
export function useMentionFiles(query: string | null, exclude: string | null) {
  const root = useWorkspaceStore((s) => s.root);
  const active = root ? query : null;
  const browsing = active === "";
  // One extra so leaving out `exclude` still fills the menu.
  const searched = useFuzzySearch(active ?? "", LIMIT + 1);
  const [recent, setRecent] = useState<SearchResult[]>([]);
  useEffect(() => {
    if (!browsing || !root) return;
    let cancelled = false;
    tauri.readRecentFiles(LIMIT + 1, 0).then(
      (entries) => {
        if (cancelled) return;
        setRecent(
          entries.map((entry) => ({
            path: entry.path,
            filename: entry.name,
            relative_path: getRelativePath(entry.path, root),
            score: 0,
            match_indices: [],
          })),
        );
      },
      (error) => console.error("[chat] Could not list recent notes", error),
    );
    return () => {
      cancelled = true;
    };
  }, [browsing, root]);
  const files = active === null ? null : browsing ? recent : searched;
  return useMemo(
    () => (files ? files.filter((file) => file.path !== exclude).slice(0, LIMIT) : []),
    [files, exclude],
  );
}
