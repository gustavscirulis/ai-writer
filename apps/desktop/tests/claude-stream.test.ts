import { describe, expect, test } from "vite-plus/test";
import { parseClaudeLine, reduceClaudeMessages, type ChatMessage } from "../src/lib/claude-stream";
const parse = (data: unknown) => parseClaudeLine(JSON.stringify(data))!;
describe("Claude stream", () => {
  test("reconciles streaming/final text without duplicating tool-turn messages", () => {
    let messages: ChatMessage[] = [];
    let id: string | null = null;
    const events = [
      { type: "stream_event", event: { type: "message_start", message: { id: "a" } } },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "I will edit." } },
      },
      {
        type: "assistant",
        message: {
          id: "a",
          content: [
            { type: "text", text: "I will edit." },
            { type: "tool_use", id: "tool", name: "Edit", input: { file_path: "/note.md" } },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tool", is_error: true }] },
      },
      { type: "stream_event", event: { type: "message_start", message: { id: "b" } } },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Denied." } },
      },
      { type: "assistant", message: { id: "b", content: [{ type: "text", text: "Denied." }] } },
    ];
    for (const data of events) {
      const event = parse(data);
      if (event.type === "start") id = event.id;
      messages = reduceClaudeMessages(messages, event, id);
    }
    expect(messages.map((m) => m.text)).toEqual(["I will edit.", "Denied."]);
    expect(messages[0].tools).toEqual([
      { id: "tool", name: "Edit", path: "/note.md", done: true, error: true },
    ]);
  });
  test("handles initialization, errors, cost, unknown events and bad JSON", () => {
    expect(parse({ type: "system", subtype: "init", session_id: "session" })).toEqual({
      type: "init",
      sessionId: "session",
    });
    expect(
      parse({ type: "result", is_error: true, errors: ["Not signed in"], total_cost_usd: 0 }),
    ).toEqual({ type: "result", error: "Not signed in", cost: 0 });
    expect(parse({ type: "result", is_error: false })).toEqual({
      type: "result",
      error: null,
      cost: undefined,
    });
    expect(parse({ type: "future_event" })).toBeNull();
    expect(() => parse({ type: "control_request" })).toThrow("Missing permission request ID");
    expect(() => parseClaudeLine("broken")).toThrow();
  });
});

test("tool-only assistant snapshots preserve streamed text and batch tool results", () => {
  let messages: ChatMessage[] = [
    { id: "same", role: "assistant", text: "Editing both notes.", tools: [] },
  ];
  const snapshot = {
    type: "assistant",
    message: {
      id: "same",
      content: [
        { type: "tool_use", id: "one", name: "Edit", input: { file_path: "/a.md" } },
        { type: "tool_use", id: "two", name: "Edit", input: { file_path: "/b.md" } },
      ],
    },
  };
  messages = reduceClaudeMessages(messages, parse(snapshot), "same");
  messages = reduceClaudeMessages(
    messages,
    parse({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "one" },
          { type: "tool_result", tool_use_id: "two", is_error: true },
        ],
      },
    }),
    "same",
  );
  messages = reduceClaudeMessages(messages, parse(snapshot), "same");
  expect(messages[0].text).toBe("Editing both notes.");
  expect(messages[0].tools.map((t) => [t.id, t.done, t.error])).toEqual([
    ["one", true, false],
    ["two", true, true],
  ]);
});

test("validates host permission input and recognizes cancellation and unsupported controls", () => {
  expect(
    parse({
      type: "control_request",
      request_id: "permission",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "pwd" },
        description: "Read current directory",
      },
    }),
  ).toEqual({
    type: "permission",
    permission: {
      id: "permission",
      tool: "Bash",
      input: { command: "pwd" },
      description: "Read current directory",
    },
  });
  expect(parse({ type: "control_cancel_request", request_id: "permission" })).toEqual({
    type: "permission_cancel",
    id: "permission",
  });
  expect(
    parse({ type: "control_request", request_id: "other", request: { subtype: "elicitation" } }),
  ).toEqual({ type: "unsupported_control", id: "other", subtype: "elicitation" });
  expect(() =>
    parse({
      type: "control_request",
      request_id: "bad",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: [] },
    }),
  ).toThrow("Invalid tool permission request");
});

test("streams separate text blocks and reconciles per-block snapshots without replacing earlier text", () => {
  let messages: ChatMessage[] = [];
  let id: string | null = null;
  let index = 0;
  const accept = (data: unknown) => {
    const event = parse(data);
    if (!event) return;
    if (event.type === "start") id = event.id;
    if (event.type === "block_start") index = event.index;
    messages = reduceClaudeMessages(messages, event, id, index);
    if (event.type === "message_stop") id = null;
  };
  const stream = (event: unknown) => accept({ type: "stream_event", event });
  const snapshot = (uuid: string, text: string) => ({
    type: "assistant",
    uuid,
    message: { id: "reply", content: [{ type: "text", text }] },
  });
  stream({ type: "message_start", message: { id: "reply" } });
  expect(messages).toEqual([]);
  stream({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "Private reasoning" },
  });
  stream({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Private reasoning" },
  });
  expect(messages).toEqual([]);
  stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "First " } });
  expect(messages[0].text).toBe("First ");
  stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer." } });
  accept(snapshot("first", "First answer."));
  stream({
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", id: "read", name: "Read", input: {} },
  });
  expect(messages[0].tools[0].name).toBe("Read");
  accept({
    type: "assistant",
    uuid: "tool",
    message: {
      id: "reply",
      content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: "/note.md" } }],
    },
  });
  accept({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read" }] } });
  stream({ type: "content_block_start", index: 3, content_block: { type: "text", text: "" } });
  stream({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Second " } });
  expect(messages[0].text).toBe("First answer.\n\nSecond ");
  stream({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "answer." } });
  accept(snapshot("second", "Second answer."));
  accept(snapshot("first", "First answer."));
  stream({ type: "message_stop" });
  accept(snapshot("second", "Second answer."));
  expect(messages).toHaveLength(1);
  expect(messages[0].text).toBe("First answer.\n\nSecond answer.");
  expect(messages[0].tools[0]).toMatchObject({ path: "/note.md", done: true });
});

test("snapshot-only blocks reconcile repeated UUIDs and independent message IDs", () => {
  let messages: ChatMessage[] = [];
  const snapshot = (id: string, uuid: string, text: string) =>
    parse({ type: "assistant", uuid, message: { id, content: [{ type: "text", text }] } });
  messages = reduceClaudeMessages(messages, snapshot("one", "a", "First."), null);
  messages = reduceClaudeMessages(messages, snapshot("one", "b", "Second."), null);
  messages = reduceClaudeMessages(messages, snapshot("one", "a", "First."), null);
  messages = reduceClaudeMessages(messages, snapshot("two", "c", "Another reply."), null);
  expect(messages.map((message) => message.text)).toEqual(["First.\n\nSecond.", "Another reply."]);
});
