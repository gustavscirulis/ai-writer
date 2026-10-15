import { describe, expect, test } from "vite-plus/test";
import { reduceClaudeMessages, type ChatMessage, type ClaudeEvent } from "../src/lib/claude-stream";
import { createCodexParser } from "../src/lib/codex-stream";

const line = (method: string, params: unknown = {}) => JSON.stringify({ method, params });
const NOTE = "/notes/groceries.md";

/** Replays lines the way the chat store does, tracking the streaming message and block. */
function replay(lines: string[]) {
  const parse = createCodexParser();
  let messages: ChatMessage[] = [];
  let id: string | null = null;
  let block = 0;
  const events: ClaudeEvent[] = [];
  for (const entry of lines)
    for (const event of parse(entry)) {
      events.push(event);
      if (event.type === "start") [id, block] = [event.id, 0];
      if (event.type === "block_start") block = event.index;
      messages = reduceClaudeMessages(messages, event, id, block);
      if (event.type === "message_stop") id = null;
    }
  return { messages, events };
}

const message = (id: string, deltas: string[]) => [
  line("item/started", { item: { type: "agentMessage", id, text: "" } }),
  ...deltas.map((delta) => line("item/agentMessage/delta", { itemId: id, delta })),
  line("item/completed", { item: { type: "agentMessage", id, text: deltas.join("") } }),
];
const read = (id: string, status = "completed") =>
  line(status === "inProgress" ? "item/started" : "item/completed", {
    item: {
      type: "commandExecution",
      id,
      status,
      commandActions: [{ type: "read", command: "cat groceries.md", path: NOTE }],
    },
  });

describe("Codex stream", () => {
  test("a planned edit reads as one reply per turn, with the plan and edit as tools", () => {
    const fileChange = (status: string) => ({
      type: "fileChange",
      id: "patch-1",
      status,
      changes: [{ path: NOTE, kind: { type: "update", move_path: null }, diff: "+- bread" }],
    });
    const { messages, events } = replay([
      line("writer/thread", { threadId: "thread-1" }),
      line("turn/started", { turn: { id: "turn-1" } }),
      line("item/started", { item: { type: "userMessage", id: "u1" } }),
      ...message("m1", ["I’ll read", " the list."]),
      read("read-1", "inProgress"),
      read("read-1"),
      line("item/started", { item: { type: "reasoning", id: "r1" } }),
      line("item/completed", { item: { type: "plan", id: "turn-1-plan", text: "Add bread." } }),
      line("writer/request", {
        requestId: "writer-plan-1",
        tool: "ExitPlanMode",
        input: { plan: "Add bread." },
      }),
      line("writer/resolved", { requestId: "writer-plan-1", error: false }),
      line("turn/started", { turn: { id: "turn-2" } }),
      ...message("m2", ["Adding bread."]),
      line("item/started", { item: fileChange("inProgress") }),
      line("item/completed", { item: fileChange("completed") }),
      ...message("m3", ["Done."]),
      line("turn/completed", { turn: { id: "turn-2", status: "completed", error: null } }),
    ]);
    expect(events[0]).toEqual({ type: "init", sessionId: "thread-1" });
    expect(events).toContainEqual({ type: "thinking" });
    expect(events).toContainEqual({
      type: "permission",
      permission: {
        id: "writer-plan-1",
        tool: "ExitPlanMode",
        input: { plan: "Add bread." },
        description: undefined,
      },
    });
    expect(events.at(-1)).toEqual({ type: "result", error: null });
    expect(messages.map((entry) => [entry.id, entry.text])).toEqual([
      ["turn-1", "I’ll read the list."],
      ["turn-2", "Adding bread.\n\nDone."],
    ]);
    expect(messages[0]!.tools).toEqual([
      { id: "read-1", name: "Read", path: NOTE, done: true, error: false },
      { id: "writer-plan-1", name: "ExitPlanMode", plan: "Add bread.", done: true, error: false },
    ]);
    expect(messages[1]!.tools).toEqual([
      { id: "patch-1", name: "Edit", path: NOTE, done: true, error: false },
    ]);
  });

  test("names each item as the tool the chat already draws", () => {
    const parse = createCodexParser();
    parse(line("turn/started", { turn: { id: "t" } }));
    const tool = (item: object) =>
      parse(line("item/started", { item }))
        .map((event) => (event.type === "block_start" ? event.tool : null))
        .at(0);
    const command = (id: string, ...types: string[]) => ({
      type: "commandExecution",
      id,
      commandActions: types.map((type) => ({ type, path: type === "read" ? NOTE : undefined })),
    });
    expect(tool(command("a", "search", "search"))).toEqual({ id: "a", name: "Grep" });
    expect(tool(command("b", "listFiles"))).toEqual({ id: "b", name: "Glob" });
    expect(tool(command("c", "read", "unknown"))).toEqual({ id: "c", name: "Bash" });
    expect(tool(command("d"))).toEqual({ id: "d", name: "Bash" });
    expect(
      tool({ type: "fileChange", id: "e", changes: [{ path: NOTE, kind: { type: "add" } }] }),
    ).toEqual({ id: "e", name: "Write", path: NOTE });
    expect(tool({ type: "mcpToolCall", id: "f", server: "glean", tool: "search" })).toEqual({
      id: "f",
      name: "mcp__glean__search",
    });
    expect(tool({ type: "webSearch", id: "g" })).toEqual({ id: "g", name: "WebSearch" });
    expect(tool({ type: "userMessage", id: "h" })).toBeUndefined();
  });

  test("declined and failed items show as errors, and a failed turn reports why", () => {
    const parse = createCodexParser();
    parse(line("turn/started", { turn: { id: "t" } }));
    expect(
      parse(line("item/completed", { item: { type: "fileChange", id: "p", status: "declined" } })),
    ).toEqual([{ type: "tool_results", results: [{ id: "p", error: true }] }]);
    expect(
      parse(
        line("turn/completed", {
          turn: { status: "failed", error: { message: "Usage limit reached" } },
        }),
      ),
    ).toEqual([{ type: "message_stop" }, { type: "result", error: "Usage limit reached" }]);
    expect(parse(line("turn/completed", { turn: { status: "interrupted" } })).at(-1)).toEqual({
      type: "result",
      error: "Codex could not complete this turn",
    });
    expect(parse(line("writer/failed", { message: "Codex 0.150.0 is too old" }))).toEqual([
      { type: "result", error: "Codex 0.150.0 is too old" },
    ]);
  });

  test("a message that never streamed shows its final text", () => {
    const { messages } = replay([
      line("turn/started", { turn: { id: "t" } }),
      line("item/completed", { item: { type: "agentMessage", id: "m", text: "All at once." } }),
    ]);
    expect(messages.map((entry) => entry.text)).toEqual(["All at once."]);
  });

  test("questions become a tool row and a request, and answers and cancels resolve them", () => {
    const parse = createCodexParser();
    parse(line("turn/started", { turn: { id: "t" } }));
    const questions = [{ question: "Which tone?", options: [{ label: "Warm" }] }];
    const events = parse(
      line("writer/request", {
        requestId: "q1",
        tool: "AskUserQuestion",
        input: { questions },
      }),
    );
    expect(events.map((event) => event.type)).toEqual(["block_start", "permission"]);
    expect(events[0]).toMatchObject({
      tool: { id: "q1", name: "AskUserQuestion", questions: [{ question: "Which tone?" }] },
    });
    expect(
      parse(line("writer/resolved", { requestId: "q1", answers: { "Which tone?": "Warm" } })),
    ).toEqual([
      {
        type: "tool_results",
        results: [{ id: "q1", error: false, answers: { "Which tone?": "Warm" } }],
      },
    ]);
    expect(parse(line("writer/cancel", { requestId: "q2" }))).toEqual([
      { type: "permission_cancel", id: "q2" },
    ]);
  });

  test("a cross-note edit request carries its target", () => {
    const [event] = createCodexParser()(
      line("writer/request", {
        requestId: "e1",
        tool: "Edit",
        input: { file_path: "/notes/other.md" },
        target: { path: "/notes/other.md", exists: true },
      }),
    );
    expect(event).toMatchObject({
      type: "permission",
      permission: { id: "e1", tool: "Edit", target: { path: "/notes/other.md", exists: true } },
    });
  });

  test("malformed lines throw so the store can stop the turn", () => {
    const parse = createCodexParser();
    expect(() => parse("not JSON")).toThrow();
    expect(() => parse(line("writer/thread", {}))).toThrow("Codex started a thread without an ID");
    expect(() => parse(line("writer/request", { requestId: "x" }))).toThrow(
      "Invalid Codex host request",
    );
    expect(parse(line("thread/tokenUsage/updated", {}))).toEqual([]);
  });
});
