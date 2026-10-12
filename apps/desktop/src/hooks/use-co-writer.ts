import { useEffect } from "react";
import { loadMcpServers, useCoWriterStore } from "@/stores/co-writer-store";
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
