import type { FeedbackAnchor } from "@/lib/feedback-anchors";

/** Text the user pointed at when sending; `note` is set when it was a saved note. */
export interface ChatAttachment {
  anchor: FeedbackAnchor;
  quote: string | null;
  note?: string;
}
export interface ChatTool {
  id: string;
  name: string;
  path?: string;
  error?: boolean;
  done?: boolean;
  /** What Claude asked with AskUserQuestion, with the user's answers once given. */
  questions?: { question: string; answer?: string }[];
}
export interface ChatQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}
/** Requests that wait for the user's answer rather than an allow/deny decision. */
export function needsAnswer(tool: string) {
  return tool === "AskUserQuestion";
}
/** Questions from an AskUserQuestion input; native code already rejected ones without text. */
export function readQuestions(input: Record<string, unknown>): ChatQuestion[] {
  const questions = Array.isArray(input.questions) ? input.questions.map(object) : [];
  return questions.map((question) => ({
    question: string(question.question),
    header: string(question.header),
    options: (Array.isArray(question.options) ? question.options.map(object) : []).map(
      (option) => ({ label: string(option.label), description: string(option.description) }),
    ),
    multiSelect: question.multiSelect === true,
  }));
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ChatTool[];
  attachments?: ChatAttachment[];
  /** Absolute paths of files attached to a user message. */
  files?: string[];
  textBlocks?: { key: string; text: string; snapshotId?: string; snapshotIndex?: number }[];
}
export function isVisibleMessage(message: ChatMessage) {
  return message.text !== "" || message.tools.length > 0;
}
export interface ToolPermission {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  description?: string;
  /** Canonical note Writer resolved for an Edit/Write outside the chat's own note. */
  target?: { path: string; exists: boolean };
  pending?: boolean;
  error?: string;
}
export type ClaudeEvent =
  | { type: "permission"; permission: ToolPermission }
  | { type: "permission_cancel"; id: string }
  | { type: "unsupported_control"; id: string; subtype: string }
  | { type: "init"; sessionId: string }
  | { type: "start"; id: string }
  | { type: "block_start"; index: number; kind: string; text: string; tool?: ChatTool }
  | { type: "thinking" }
  | { type: "message_stop" }
  | { type: "delta"; text: string; index: number }
  | {
      type: "assistant";
      id: string;
      text: string;
      texts: { index: number; text: string }[];
      snapshotId: string;
      tools: ChatTool[];
    }
  | {
      type: "tool_results";
      results: { id: string; error: boolean; answers?: Record<string, string> }[];
    }
  | { type: "result"; error: string | null; cost?: number };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

/** Unknown protocol events are ignored. Malformed JSON is a transport error. */
export function parseClaudeLine(line: string): ClaudeEvent | null {
  const data = object(JSON.parse(line));
  if (data.type === "control_cancel_request") {
    if (!string(data.request_id)) throw new Error("Missing permission request ID");
    return { type: "permission_cancel", id: string(data.request_id) };
  }
  if (data.type === "control_request") {
    const request = object(data.request);
    const id = string(data.request_id);
    if (!id) throw new Error("Missing permission request ID");
    if (request.subtype !== "can_use_tool")
      return { type: "unsupported_control", id, subtype: string(request.subtype) };
    if (
      !string(request.tool_name) ||
      !request.input ||
      typeof request.input !== "object" ||
      Array.isArray(request.input)
    )
      throw new Error("Invalid tool permission request");
    const target = object(data.writer_target);
    return {
      type: "permission",
      permission: {
        id,
        tool: string(request.tool_name),
        input: object(request.input),
        description: string(request.description) || undefined,
        ...(string(target.path)
          ? { target: { path: string(target.path), exists: target.exists === true } }
          : {}),
      },
    };
  }
  if (data.type === "system" && data.subtype === "init" && typeof data.session_id === "string")
    return { type: "init", sessionId: data.session_id };
  if (data.type === "stream_event") {
    const event = object(data.event);
    if (event.type === "message_start")
      return { type: "start", id: string(object(event.message).id) };
    const index = typeof event.index === "number" ? event.index : 0;
    if (event.type === "content_block_start") {
      const block = object(event.content_block);
      return {
        type: "block_start",
        index,
        kind: string(block.type),
        text: string(block.text),
        tool:
          block.type === "tool_use"
            ? { id: string(block.id), name: string(block.name) }
            : undefined,
      };
    }
    if (event.type === "message_stop") return { type: "message_stop" };
    const delta = object(event.delta);
    if (event.type === "content_block_delta" && delta.type === "text_delta")
      return { type: "delta", text: string(delta.text), index };
    if (event.type === "content_block_delta" && delta.type === "thinking_delta")
      return { type: "thinking" };
  }
  if (data.type === "assistant") {
    const message = object(data.message);
    const blocks = Array.isArray(message.content) ? message.content.map(object) : [];
    return {
      type: "assistant",
      id: string(message.id) || string(data.uuid),
      text: blocks
        .filter((b) => b.type === "text")
        .map((b) => string(b.text))
        .join("\n"),
      texts: blocks.flatMap((block, index) =>
        block.type === "text" ? [{ index, text: string(block.text) }] : [],
      ),
      snapshotId: string(data.uuid),
      tools: blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const input = object(b.input);
          return {
            id: string(b.id),
            name: string(b.name),
            path: string(input.file_path) || undefined,
            ...(b.name === "AskUserQuestion"
              ? { questions: readQuestions(input).map(({ question }) => ({ question })) }
              : {}),
          };
        }),
    };
  }
  if (data.type === "user") {
    const content = object(data.message).content;
    if (Array.isArray(content)) {
      const results = content.map(object).filter((b) => b.type === "tool_result");
      // The structured result describes the message's only tool result.
      const answers = object(object(data.tool_use_result).answers);
      if (results.length)
        return {
          type: "tool_results",
          results: results.map((result) => ({
            id: string(result.tool_use_id),
            error: result.is_error === true,
            ...(results.length === 1 && Object.keys(answers).length
              ? {
                  answers: Object.fromEntries(
                    Object.entries(answers).map(([question, answer]) => [question, string(answer)]),
                  ),
                }
              : {}),
          })),
        };
    }
  }
  if (data.type === "result")
    return {
      type: "result",
      error:
        data.is_error === true
          ? (Array.isArray(data.errors)
              ? data.errors.map(string).join("\n")
              : string(data.result)) || "Claude could not complete this turn"
          : null,
      cost: typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined,
    };
  return null;
}

export function reduceClaudeMessages(
  messages: ChatMessage[],
  event: ClaudeEvent,
  streamingId: string | null,
  streamingBlockIndex = 0,
): ChatMessage[] {
  if (event.type === "tool_results")
    return messages.map((message) => {
      if (!message.tools.some((tool) => event.results.some((result) => result.id === tool.id)))
        return message;
      return {
        ...message,
        tools: message.tools.map((tool) => {
          const result = event.results.find((r) => r.id === tool.id);
          if (!result) return tool;
          const answers = result.answers;
          return {
            ...tool,
            done: true,
            error: result.error,
            ...(answers && tool.questions
              ? { questions: tool.questions.map((q) => ({ ...q, answer: answers[q.question] })) }
              : {}),
          };
        }),
      };
    });
  if (event.type === "start") {
    if (!event.id) throw new Error("Claude emitted a message without an ID");
    return messages; // A protocol start is not yet visible assistant content.
  }
  if (event.type !== "delta" && event.type !== "assistant" && event.type !== "block_start")
    return messages;
  if (event.type === "block_start" && event.kind !== "text" && !event.tool) return messages;
  const id = event.type === "assistant" ? event.id : streamingId;
  if (!id) throw new Error("Claude emitted content without a message ID");
  const existing = messages.find((m) => m.id === id);
  const message: ChatMessage = existing ?? { id, role: "assistant", text: "", tools: [] };
  let textBlocks =
    message.textBlocks ?? (message.text ? [{ key: "block:0", text: message.text }] : []);
  let tools = message.tools;
  if (event.type === "delta" || (event.type === "block_start" && event.kind === "text")) {
    const key = `block:${event.index}`;
    const block = textBlocks.find((entry) => entry.key === key);
    const next = {
      ...block,
      key,
      text: event.type === "delta" ? (block?.text ?? "") + event.text : (block?.text ?? event.text),
    };
    textBlocks = block
      ? textBlocks.map((entry) => (entry === block ? next : entry))
      : [...textBlocks, next];
  }
  if (event.type === "assistant") {
    for (const text of event.texts) {
      const completed =
        event.snapshotId &&
        textBlocks.find(
          (block) => block.snapshotId === event.snapshotId && block.snapshotIndex === text.index,
        );
      const key = completed
        ? completed.key
        : event.id === streamingId
          ? `block:${event.texts.length === 1 ? streamingBlockIndex : text.index}`
          : `snapshot:${event.snapshotId || event.id}:${text.index}`;
      const block = textBlocks.find((entry) => entry.key === key);
      const next = {
        key,
        text: text.text,
        snapshotId: event.snapshotId,
        snapshotIndex: text.index,
      };
      textBlocks = block
        ? textBlocks.map((entry) => (entry === block ? next : entry))
        : [...textBlocks, next];
    }
  }
  const nextTools =
    event.type === "assistant"
      ? event.tools
      : event.type === "block_start" && event.tool
        ? [event.tool]
        : [];
  if (nextTools.length)
    tools = [
      ...tools.filter((tool) => !nextTools.some((next) => next.id === tool.id)),
      ...nextTools.map((tool) => ({
        ...tools.find((existing) => existing.id === tool.id),
        ...tool,
      })),
    ];
  const next = {
    ...message,
    text: textBlocks
      .map((block) => block.text)
      .filter(Boolean)
      .join("\n\n"),
    textBlocks,
    tools,
  };
  return existing ? messages.map((m) => (m === existing ? next : m)) : [...messages, next];
}

export type ClaudeActivity = "thinking" | "responding" | "working" | null;

/** Protocol phase, with tool execution scoped to the latest user turn. */
export function getClaudeActivity(
  event: ClaudeEvent,
  messages: ChatMessage[],
  previous: ClaudeActivity,
): ClaudeActivity {
  switch (event.type) {
    case "start":
    case "thinking":
      return "thinking";
    case "delta":
      return "responding";
    case "block_start":
      return event.kind === "text" ? "responding" : event.tool ? "working" : "thinking";
    case "assistant":
      return event.tools.length ? "working" : event.texts.length ? "responding" : previous;
    case "tool_results":
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.role === "user") break;
        if (message.tools.some((tool) => !tool.done)) return "working";
      }
      return "thinking";
    default:
      return previous;
  }
}
