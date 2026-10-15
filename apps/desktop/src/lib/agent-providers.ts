import { parseClaudeLine, type ClaudeEvent } from "@/lib/claude-stream";
import { createCodexParser } from "@/lib/codex-stream";
import type { Capabilities } from "@/lib/co-writer-skills";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import * as tauri from "@/lib/tauri";
import { useSettingsStore } from "@/stores/settings-store";

export type AgentId = "claude-code" | "codex";

/** An agent CLI Co-writer can run on; everything else about a turn is shared. */
export interface AgentProvider {
  id: AgentId;
  label: string;
  start: tauri.AgentStart;
  capabilities: (root: string) => Promise<Capabilities>;
  /** A fresh parser per turn; one line may produce several chat events. */
  createParser: () => (line: string) => ClaudeEvent[];
  /** The error the agent reports when a saved session can't be resumed. */
  isExpiredSession: (error: string) => boolean;
  modelKey: "co-writer.model" | "co-writer.codex-model";
}

export const AGENT_KEY = "co-writer.agent" as const;

export const AGENTS: Record<AgentId, AgentProvider> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    start: tauri.claudeStart,
    capabilities: tauri.claudeCapabilities,
    createParser: () => (line) => {
      const event = parseClaudeLine(line);
      return event ? [event] : [];
    },
    isExpiredSession: (error) => error.startsWith("No conversation found with session ID"),
    modelKey: "co-writer.model",
  },
  codex: {
    id: "codex",
    label: "Codex",
    start: tauri.codexStart,
    capabilities: tauri.codexCapabilities,
    createParser: createCodexParser,
    isExpiredSession: (error) => error.includes("no rollout found for thread id"),
    modelKey: "co-writer.codex-model",
  },
};

export const DEFAULT_AGENT = SETTINGS_SCHEMA.find((def) => def.key === AGENT_KEY)!
  .default as AgentId;

export function isAgentId(id: unknown): id is AgentId {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(AGENTS, id);
}

/** The agent new turns run on, from Settings. */
export function currentAgent(): AgentProvider {
  const id = useSettingsStore.getState().settings[AGENT_KEY] ?? DEFAULT_AGENT;
  if (!isAgentId(id))
    throw new Error(`Unknown Co-writer agent "${String(id)}". Choose one in Settings → Co-writer.`);
  return AGENTS[id];
}
