import "./agent-indicator.css";

export type AgentState = "running" | "approval" | "error";

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  running: "Agent running",
  approval: "Agent needs your input",
  error: "Agent needs attention",
};

export function AgentIndicator({ state }: { state: AgentState }) {
  return <span aria-hidden="true" data-state={state} className="agent-indicator" />;
}
