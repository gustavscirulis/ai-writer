import { useEffect } from "react";
import { isBlankNote } from "@/lib/co-writer-suggestions";
import { loadMcpServers, useCoWriterStore } from "@/stores/co-writer-store";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
export type { McpServerList } from "@/stores/co-writer-store";

/** Claude Code's MCP servers for the workspace; `null` until known. */
export function useMcpServers() {
  const root = useWorkspaceStore((s) => s.root);
  useEffect(() => {
    if (root) void loadMcpServers(root);
  }, [root]);
  return useCoWriterStore((s) => (root ? (s.servers[root] ?? null) : null));
}

/** Whether the note has nothing to work on yet; `null` while it loads. */
export function useNoteIsBlank(path: string | null) {
  return useEditorStore((s) => {
    const file = path ? s.openFiles.get(path) : undefined;
    return file && !file.isLoading ? isBlankNote(file.content) : null;
  });
}
