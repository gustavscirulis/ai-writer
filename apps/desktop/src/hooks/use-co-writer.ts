import { useCallback, useEffect } from "react";
import {
  AGENT_KEY,
  AGENTS,
  DEFAULT_AGENT,
  isAgentId,
  type AgentProvider,
} from "@/lib/agent-providers";
import { isWorkspaceChat } from "@/lib/agent-turn";
import { modelOptionLabel } from "@/lib/claude-models";
import { isBlankNote, type McpServer } from "@/lib/co-writer-suggestions";
import type { Skill } from "@/lib/co-writer-skills";
import { capabilityKey, loadCapabilities, useCoWriterStore } from "@/stores/co-writer-store";
import { useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSetting } from "@/hooks/use-settings";

export type McpServerList = McpServer[] | "unavailable";

const NO_SKILLS: Skill[] = [];

/** The agent Settings names; an unknown one shows the default's details, and sending reports it. */
export function useAgent(): AgentProvider {
  const id = useSetting(AGENT_KEY) ?? DEFAULT_AGENT;
  return AGENTS[isAgentId(id) ? id : DEFAULT_AGENT];
}

/** The current agent's capabilities for the workspace, loaded once `load` is set. */
function useCapabilities(load = true) {
  const agent = useAgent();
  const root = useWorkspaceStore((s) => s.root);
  useEffect(() => {
    if (load && root) void loadCapabilities(agent, root);
  }, [load, agent, root]);
  return useCoWriterStore((s) =>
    root ? (s.capabilities[capabilityKey(agent, root)] ?? null) : null,
  );
}

/** The agent's MCP servers for the workspace; `null` until known. */
export function useMcpServers(): McpServerList | null {
  const capabilities = useCapabilities();
  return capabilities === "unavailable" ? capabilities : (capabilities?.mcpServers ?? null);
}

/** The agent's skills for the workspace; empty until known. */
export function useSkills() {
  const capabilities = useCapabilities();
  return capabilities && capabilities !== "unavailable" ? capabilities.skills : NO_SKILLS;
}

/** The agent's models, with options labeled by the versions it reports, asking it only when `load` is set. */
export function useModels(load: boolean) {
  const capabilities = useCapabilities(load);
  const label = useCallback(
    (option: string) =>
      modelOptionLabel(
        option,
        capabilities && capabilities !== "unavailable" ? capabilities : null,
      ),
    [capabilities],
  );
  const models = capabilities && capabilities !== "unavailable" ? (capabilities.models ?? []) : [];
  return { label, models };
}

/** Whether the note has nothing to work on yet; `null` while it loads. No note counts as blank. */
export function useNoteIsBlank(path: string) {
  return useEditorStore((s) => {
    if (isWorkspaceChat(path)) return true;
    const file = s.openFiles.get(path);
    return file && !file.isLoading ? isBlankNote(file.content) : null;
  });
}
