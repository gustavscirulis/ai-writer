import type { ChatAttachment } from "@/lib/claude-stream";

export interface AgentTurnOutcome {
  status: "completed" | "failed" | "cancelled";
  changed: boolean;
  error: string | null;
}

export interface AgentTurnOptions {
  path: string;
  prepare: (diskContent: string) => string | Promise<string>;
  complete: (outcome: AgentTurnOutcome) => void;
}

export interface SendOptions {
  /** A turn whose prompt is prepared from the saved file and whose outcome is reported back. */
  turn?: AgentTurnOptions;
  attachments?: ChatAttachment[];
}
