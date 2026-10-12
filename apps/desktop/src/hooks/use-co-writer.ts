import { useEffect } from "react";
import { documentPath } from "@/lib/agent-turn";
import {
  canSuggestFor,
  loadMcpServers,
  requestSuggestions,
  useCoWriterStore,
} from "@/stores/co-writer-store";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
export type { McpServer, Suggestion } from "@/lib/co-writer-suggestions";

/** Claude Code's MCP servers for the workspace; `null` until known. */
export function useMcpServers() {
  const root = useWorkspaceStore((s) => s.root);
  useEffect(() => {
    if (root) void loadMcpServers(root);
  }, [root]);
  return useCoWriterStore((s) => (root ? (s.servers[root] ?? null) : null));
}

/** Prompts written for this note by a quick model run; `null` until ready or if it failed. */
export function useNoteSuggestions(path: string | null) {
  const root = useWorkspaceStore((s) => s.root);
  const ready = useEditorStore((s) => !!path && canSuggestFor(s.openFiles.get(path)));
  useEffect(() => {
    if (root && path && ready) requestSuggestions(root, path);
  }, [root, path, ready]);
  return useCoWriterStore((s) => (path ? (s.suggestions[documentPath(path)] ?? null) : null));
}
