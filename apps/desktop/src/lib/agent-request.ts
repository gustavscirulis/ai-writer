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
  /** Composer feedback chips this message carries; they leave with the draft and return if it fails. */
  feedbackIds?: string[];
  /** Canonical paths of files the user attached; Claude reads them this turn. */
  files?: string[];
}
