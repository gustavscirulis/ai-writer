import { needsAnswer, readQuestions, type ChatTool, type ClaudeEvent } from "@/lib/claude-stream";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown) {
  return typeof value === "string" ? value : "";
}
function array(value: unknown) {
  return Array.isArray(value) ? value.map(object) : [];
}

/** Shows Codex's items as the tools the chat already knows how to draw. */
function toolFor(item: Record<string, unknown>): ChatTool | null {
  const id = string(item.id);
  if (item.type === "commandExecution") {
    const actions = array(item.commandActions);
    const all = (type: string) => actions.length > 0 && actions.every((a) => a.type === type);
    if (all("read") && actions.every((action) => string(action.path)))
      return { id, name: "Read", path: string(actions[0].path) };
    if (all("search")) return { id, name: "Grep" };
    if (all("listFiles")) return { id, name: "Glob" };
    return { id, name: "Bash" };
  }
  if (item.type === "fileChange") {
    const change = array(item.changes)[0] ?? {};
    const name = object(change.kind).type === "add" ? "Write" : "Edit";
    return { id, name, path: string(change.path) || undefined };
  }
  if (item.type === "mcpToolCall")
    return { id, name: `mcp__${string(item.server)}__${string(item.tool)}` };
  if (item.type === "webSearch") return { id, name: "WebSearch" };
  return null;
}

/** Turns `codex app-server` notifications, plus the `writer/*` lines native code
 * adds, into the events Claude Code's stream produces. Each turn is one message. */
export function createCodexParser(): (line: string) => ClaudeEvent[] {
  let blocks = new Map<string, number>();
  let streamed = new Set<string>();
  let next = 0;
  const block = (id: string) => {
    const index = next++;
    blocks.set(id, index);
    return index;
  };
  return (line) => {
    const data = object(JSON.parse(line));
    const params = object(data.params);
    const item = object(params.item);
    const itemId = string(item.id);
    switch (data.method) {
      case "writer/thread": {
        if (!string(params.threadId)) throw new Error("Codex started a thread without an ID");
        return [{ type: "init", sessionId: string(params.threadId) }];
      }
      case "writer/failed":
        return [{ type: "result", error: string(params.message) || "Codex stopped unexpectedly" }];
      case "writer/request": {
        const id = string(params.requestId);
        const tool = string(params.tool);
        if (!id || !tool) throw new Error("Invalid Codex host request");
        const input = object(params.input);
        const target = object(params.target);
        const events: ClaudeEvent[] = [];
        // Questions and plans have no Codex item, so the request is their tool row.
        if (needsAnswer(tool))
          events.push({
            type: "block_start",
            index: block(id),
            kind: "tool_use",
            text: "",
            tool: {
              id,
              name: tool,
              ...(tool === "AskUserQuestion"
                ? { questions: readQuestions(input).map(({ question }) => ({ question })) }
                : string(input.plan)
                  ? { plan: string(input.plan) }
                  : {}),
            },
          });
        events.push({
          type: "permission",
          permission: {
            id,
            tool,
            input,
            description: string(params.description) || undefined,
            ...(string(target.path)
              ? { target: { path: string(target.path), exists: target.exists === true } }
              : {}),
          },
        });
        return events;
      }
      case "writer/resolved": {
        const answers = Object.entries(object(params.answers));
        return [
          {
            type: "tool_results",
            results: [
              {
                id: string(params.requestId),
                error: params.error === true,
                ...(answers.length
                  ? { answers: Object.fromEntries(answers.map(([q, a]) => [q, string(a)])) }
                  : {}),
              },
            ],
          },
        ];
      }
      case "writer/cancel":
        return [{ type: "permission_cancel", id: string(params.requestId) }];
      case "turn/started":
        blocks = new Map();
        streamed = new Set();
        next = 0;
        return [{ type: "start", id: string(object(params.turn).id) }];
      case "item/agentMessage/delta": {
        const index = blocks.get(string(params.itemId));
        if (index === undefined) return [];
        streamed.add(string(params.itemId));
        return [{ type: "delta", text: string(params.delta), index }];
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        return [{ type: "thinking" }];
      case "item/started": {
        if (item.type === "agentMessage")
          return [{ type: "block_start", index: block(itemId), kind: "text", text: "" }];
        if (item.type === "reasoning") return [{ type: "thinking" }];
        const tool = toolFor(item);
        return tool
          ? [{ type: "block_start", index: block(itemId), kind: "tool_use", text: "", tool }]
          : [];
      }
      case "item/completed": {
        if (item.type === "agentMessage") {
          const text = string(item.text);
          if (streamed.has(itemId) || !text) return [];
          const known = blocks.get(itemId);
          const index = known ?? block(itemId);
          return [
            ...(known === undefined
              ? [{ type: "block_start" as const, index, kind: "text", text: "" }]
              : []),
            { type: "delta", text, index },
          ];
        }
        if (!toolFor(item)) return [];
        const status = string(item.status);
        return [
          {
            type: "tool_results",
            results: [{ id: itemId, error: status === "failed" || status === "declined" }],
          },
        ];
      }
      case "turn/completed": {
        const turn = object(params.turn);
        const error =
          turn.status === "completed"
            ? null
            : string(object(turn.error).message) || "Codex could not complete this turn";
        return [{ type: "message_stop" }, { type: "result", error }];
      }
      default:
        return [];
    }
  };
}
