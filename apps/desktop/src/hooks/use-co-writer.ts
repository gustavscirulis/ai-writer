import { useEffect } from "react";
import { isBlankNote, type McpServer } from "@/lib/co-writer-suggestions";
import type { Skill } from "@/lib/co-writer-skills";
import { loadCapabilities, useCoWriterStore } from "@/stores/co-writer-store";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export type McpServerList = McpServer[] | "unavailable";

const NO_SKILLS: Skill[] = [];

function useCapabilities() {
  const root = useWorkspaceStore((s) => s.root);
  useEffect(() => {
    if (root) void loadCapabilities(root);
  }, [root]);
  return useCoWriterStore((s) => (root ? (s.capabilities[root] ?? null) : null));
}

/** Claude Code's MCP servers for the workspace; `null` until known. */
export function useMcpServers(): McpServerList | null {
  const capabilities = useCapabilities();
  return capabilities === "unavailable" ? capabilities : (capabilities?.mcpServers ?? null);
}

/** Claude Code's skills for the workspace; empty until known. */
export function useSkills() {
  const capabilities = useCapabilities();
  return capabilities && capabilities !== "unavailable" ? capabilities.skills : NO_SKILLS;
}

/** Whether the note has nothing to work on yet; `null` while it loads. */
export function useNoteIsBlank(path: string | null) {
  return useEditorStore((s) => {
    const file = path ? s.openFiles.get(path) : undefined;
    return file && !file.isLoading ? isBlankNote(file.content) : null;
  });
}
