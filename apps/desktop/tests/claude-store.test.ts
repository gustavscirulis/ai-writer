import { beforeEach, expect, test, vi } from "vite-plus/test";
const channels = vi.hoisted(() => [] as { onmessage: (event: unknown) => void }[]);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = (_event: unknown) => {};
    constructor() {
      channels.push(this);
    }
  },
}));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn() }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async () => null),
  setPreference: vi.fn(async () => {}),
  readPreferenceStrict: vi.fn(async () => undefined),
  writePreferenceStrict: vi.fn(async () => {}),
}));
import { invoke } from "@tauri-apps/api/core";
import { useClaudeStore } from "../src/stores/claude-store";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import {
  useFeedbackStore,
  flushAllFeedbackPersistence,
  resumeFeedbackPersistence,
} from "../src/stores/feedback-store";
import { feedbackTargets } from "../src/lib/feedback-anchors";
import { writePreferenceStrict } from "../src/lib/preferences";
import { applyFeedback } from "../src/hooks/use-feedback";
import { useSettingsStore } from "../src/stores/settings-store";
import { agentIORevision, isAgentEditing, beginPathMutation } from "../src/lib/agent-turn";
import { registerEditorView } from "../src/lib/editor-views";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
const mockedInvoke = vi.mocked(invoke);
let disk = new Map<string, string>();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const emit = (data: unknown, channel = channels[channels.length - 1]) =>
  channel.onmessage({ type: "claude", line: JSON.stringify(data) });
const chatMessages = (path: string) => useClaudeStore.getState().chats[path]?.messages ?? [];
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function defaultInvoke(command: string, payload: unknown): Promise<unknown> {
  const args = payload as { path: string; content: string };
  if (command === "read_file") {
    if (!disk.has(args.path)) return Promise.reject(new Error("Not found"));
    return Promise.resolve({ path: args.path, content: disk.get(args.path), modified_at: 1 });
  }
  if (command === "write_file") {
    disk.set(args.path, args.content);
    return Promise.resolve({ path: args.path, modified_at: 2 });
  }
  if (command === "file_exists") return Promise.resolve(disk.has(args.path));
  if (command === "claude_start") return Promise.resolve(`process-${channels.length}`);
  return Promise.resolve(null);
}
beforeEach(async () => {
  resumeFeedbackPersistence();
  vi.mocked(writePreferenceStrict).mockReset().mockResolvedValue(undefined);
  vi.clearAllMocks();
  channels.length = 0;
  disk = new Map([["/notes/a.md", "Original"]]);
  mockedInvoke.mockImplementation(defaultInvoke);
  useWorkspaceStore.setState((s) => ({
    root: "/notes",
    workspaceEpoch: 1,
    workspaceGeneration: s.workspaceGeneration + 1,
  }));
  useEditorStore.setState({
    openFiles: new Map(),
    tabs: [],
    activeFilePath: null,
    activeTabId: null,
  });
  useSettingsStore.setState({
    settings: { "files.trim-trailing-whitespace": false, "files.insert-final-newline": false },
  });
  await useEditorStore.getState().openFile("/notes/a.md");
  await useFeedbackStore
    .getState()
    .load("/notes", useWorkspaceStore.getState().workspaceGeneration);
});
test("sending clears the composer immediately, before startup/delivery, and preserves the next draft", async () => {
  const start = deferred<string>();
  const delivery = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start"
      ? start.promise
      : command === "claude_send"
        ? delivery.promise
        : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "  Edit this\n");
  const sending = useClaudeStore.getState().send("  Edit this\n");
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("");
  await tick();
  start.resolve("process");
  await tick();
  expect(chatMessages("/notes/a.md").at(-1)?.text).toBe("Edit this");
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("");
  useClaudeStore.getState().setDraft("/notes/a.md", "Next message");
  delivery.resolve(null);
  expect(await sending).toBe(true);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Next message");
});

test.each(["write_file", "claude_start", "claude_send"])(
  "%s failure restores the original composer draft",
  async (failedCommand) => {
    mockedInvoke.mockImplementation((command, args) =>
      command === failedCommand
        ? Promise.reject(new Error("Unavailable"))
        : defaultInvoke(command, args),
    );
    useEditorStore.getState().updateContent("/notes/a.md", "Dirty buffer");
    useClaudeStore.getState().setDraft("/notes/a.md", "  Retry this\n");
    expect(await useClaudeStore.getState().send("  Retry this\n")).toBe(false);
    expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("  Retry this\n");
  },
);

test("a failed send keeps a newer draft", async () => {
  const start = deferred<string>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start" ? start.promise : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "First");
  const sending = useClaudeStore.getState().send("First");
  await tick();
  useClaudeStore.getState().setDraft("/notes/a.md", "New draft");
  start.reject(new Error("Startup failed"));
  expect(await sending).toBe(false);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("New draft");
});

test("an older failed acknowledgement cannot restore a draft during a newer send", async () => {
  const firstDelivery = deferred<unknown>();
  const secondDelivery = deferred<unknown>();
  let deliveries = 0;
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_send"
      ? ++deliveries === 1
        ? firstDelivery.promise
        : secondDelivery.promise
      : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "First");
  const first = useClaudeStore.getState().send("First");
  await tick();
  emit({ type: "result", is_error: false });
  await tick();
  useClaudeStore.getState().setDraft("/notes/a.md", "Second");
  const second = useClaudeStore.getState().send("Second");
  await tick();
  expect(deliveries).toBe(2);
  firstDelivery.reject(new Error("Late failure"));
  expect(await first).toBe(false);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("");
  secondDelivery.resolve(null);
  expect(await second).toBe(true);
});

test.each(["stop", "new-chat"])(
  "%s during startup prevents stale draft recovery",
  async (action) => {
    const start = deferred<string>();
    mockedInvoke.mockImplementation((command, args) =>
      command === "claude_start" ? start.promise : defaultInvoke(command, args),
    );
    useClaudeStore.getState().setDraft("/notes/a.md", "Cancelled");
    const sending = useClaudeStore.getState().send("Cancelled");
    await tick();
    const cancel =
      action === "stop"
        ? useClaudeStore.getState().stop()
        : useClaudeStore.getState().newChat("/notes/a.md");
    start.resolve("cancelled-process");
    expect(await sending).toBe(false);
    await cancel;
    expect(useClaudeStore.getState().chats["/notes/a.md"]?.draft ?? "").toBe("");
  },
);

test("failed delivery restores only the originating note's draft after tab switching", async () => {
  const delivery = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_send" ? delivery.promise : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "For A");
  const sending = useClaudeStore.getState().send("For A");
  await tick();
  disk.set("/notes/b.md", "B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  useClaudeStore.getState().setDraft("/notes/b.md", "For B");
  delivery.reject(new Error("Delivery failed"));
  expect(await sending).toBe(false);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("For A");
  expect(useClaudeStore.getState().chats["/notes/b.md"].draft).toBe("For B");
});

test("an abandoned workspace send never restores a draft into the new workspace", async () => {
  const start = deferred<string>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start" ? start.promise : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "Old workspace");
  const sending = useClaudeStore.getState().send("Old workspace");
  await tick();
  useWorkspaceStore.setState((state) => ({
    workspaceGeneration: state.workspaceGeneration + 1,
  }));
  start.reject(new Error("Old startup failed"));
  expect(await sending).toBe(false);
  expect(useClaudeStore.getState().chats).toEqual({});
});

test("suggestion and feedback sends keep unrelated composer drafts", async () => {
  useClaudeStore.getState().setDraft("/notes/a.md", "Unsent draft");
  expect(await useClaudeStore.getState().send("Suggestion")).toBe(true);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Unsent draft");
  await useClaudeStore.getState().stop();
  expect(
    await useClaudeStore.getState().send("Unsent draft", {
      turn: { path: "/notes/a.md", prepare: () => "Feedback prompt", complete: vi.fn() },
    }),
  ).toBe(true);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Unsent draft");
});

test("empty and busy sends leave the composer draft intact", async () => {
  useClaudeStore.getState().setDraft("/notes/a.md", "Draft");
  expect(await useClaudeStore.getState().send(" ")).toBe(false);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Draft");
  await useClaudeStore.getState().send("First");
  expect(await useClaudeStore.getState().send("Draft")).toBe(false);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Draft");
});

test("saves and locks before starting, reloads all newly opened files, rejects store edits", async () => {
  useEditorStore.getState().updateContent("/notes/a.md", "Latest draft");
  const revision = agentIORevision();
  const sending = useClaudeStore.getState().send("Tighten this");
  expect(isAgentEditing()).toBe(true);
  useEditorStore.getState().updateContent("/notes/a.md", "Forbidden");
  expect(await sending).toBe(true);
  expect(disk.get("/notes/a.md")).toBe("Latest draft");
  disk.set("/notes/b.md", "Before B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  disk.set("/notes/a.md", "Revised A");
  disk.set("/notes/b.md", "Revised B");
  emit({ type: "result", is_error: false });
  await tick();
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Revised A");
  expect(useEditorStore.getState().openFiles.get("/notes/b.md")?.content).toBe("Revised B");
  expect(isAgentEditing()).toBe(false);
  expect(agentIORevision()).toBeGreaterThan(revision);
});
test("attachments reach Claude as saved-file lines and stay on the user message", async () => {
  disk.set("/notes/a.md", "---\ntitle: A\n---\nIntro\n\nOne two three");
  useEditorStore.getState().reloadFromDisk("/notes/a.md", disk.get("/notes/a.md")!);
  const body = useEditorStore.getState().openFiles.get("/notes/a.md")!.content;
  const view = { state: EditorState.create({ doc: body }) } as EditorView;
  const unregister = registerEditorView("/notes/a.md", view, () => {});
  const [, paragraph] = feedbackTargets(body);
  const attachments = [{ anchor: paragraph!, quote: "two" }];
  expect(await useClaudeStore.getState().send("Cut this", { attachments })).toBe(true);
  unregister();
  const payload = mockedInvoke.mock.calls.filter(([c]) => c === "claude_send").at(-1)![1] as {
    line: string;
  };
  const content = JSON.parse(payload.line).message.content as string;
  const context = JSON.parse(content.match(/<writer_context>(.*)<\/writer_context>/)![1]!);
  expect(context.attachments).toEqual([{ fromLine: 6, toLine: 6, text: "two" }]);
  expect(chatMessages("/notes/a.md").at(-1)).toMatchObject({ text: "Cut this", attachments });
});
test("save failure does not start Claude or discard the dirty buffer", async () => {
  mockedInvoke.mockImplementation((command, args) =>
    command === "write_file"
      ? Promise.reject(new Error("Disk full"))
      : defaultInvoke(command, args),
  );
  useEditorStore.getState().updateContent("/notes/a.md", "Unsaved");
  expect(await useClaudeStore.getState().send("Edit")).toBe(false);
  expect(mockedInvoke.mock.calls.some(([command]) => command === "claude_start")).toBe(false);
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Unsaved");
  expect(isAgentEditing()).toBe(false);
});
test("failed Stop keeps process ownership and lock until termination retry succeeds", async () => {
  await useClaudeStore.getState().send("Edit");
  let failures = 1;
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_stop" && failures-- > 0
      ? Promise.reject(new Error("IPC failure"))
      : defaultInvoke(command, args),
  );
  await useClaudeStore.getState().stop();
  expect(isAgentEditing()).toBe(true);
  await useClaudeStore.getState().stop();
  expect(isAgentEditing()).toBe(false);
  const stops = mockedInvoke.mock.calls.filter(([c]) => c === "claude_stop");
  expect(stops).toHaveLength(2);
  expect(stops[0][1]).toEqual(stops[1][1]);
});
test("Stop waits for deferred startup despite a duplicate Send and retries failed teardown", async () => {
  const start = deferred<string>();
  let failures = 2;
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start"
      ? start.promise
      : command === "claude_stop" && failures-- > 0
        ? Promise.reject(new Error("IPC failure"))
        : defaultInvoke(command, args),
  );
  const send = useClaudeStore.getState().send("Edit");
  await tick();
  expect(await useClaudeStore.getState().send("Duplicate")).toBe(false);
  const stop = useClaudeStore.getState().stop();
  expect(isAgentEditing()).toBe(true);
  start.resolve("late-process");
  await send;
  await stop;
  expect(isAgentEditing()).toBe(true);
  expect(mockedInvoke.mock.calls.some(([c]) => c === "claude_send")).toBe(false);
  await useClaudeStore.getState().stop();
  expect(isAgentEditing()).toBe(false);
});
test("old process callbacks cannot finish a newer turn", async () => {
  await useClaudeStore.getState().send("First");
  const old = channels[0];
  await useClaudeStore.getState().stop();
  await useClaudeStore.getState().send("Second");
  old.onmessage({ type: "exit", code: 0 });
  emit({ type: "result", is_error: false }, old);
  await tick();
  expect(useClaudeStore.getState().status).toBe("running");
  expect(isAgentEditing()).toBe(true);
  await useClaudeStore.getState().stop();
});
test("deleting an open file reports deletion without leaving all notes locked", async () => {
  await useClaudeStore.getState().send("Delete this note");
  disk.delete("/notes/a.md");
  emit({ type: "result", is_error: false });
  await tick();
  expect(isAgentEditing()).toBe(false);
  expect(useClaudeStore.getState().error).toContain("deleted on disk");
  expect(useEditorStore.getState().openFiles.has("/notes/a.md")).toBe(false);
});
test("a delayed navigation read cannot overwrite the final reload", async () => {
  await useClaudeStore.getState().send("Edit both");
  disk.set("/notes/b.md", "Old B");
  const stale = deferred<unknown>();
  let reads = 0;
  mockedInvoke.mockImplementation((command, args) =>
    command === "read_file" && (args as { path: string }).path === "/notes/b.md" && reads++ === 0
      ? stale.promise
      : defaultInvoke(command, args),
  );
  const loading = useEditorStore.getState().openFileInNewTab("/notes/b.md");
  disk.set("/notes/b.md", "New B");
  emit({ type: "result", is_error: false });
  await tick();
  stale.resolve({ path: "/notes/b.md", content: "Old B", modified_at: 1 });
  await loading;
  expect(useEditorStore.getState().openFiles.get("/notes/b.md")?.content).toBe("New B");
  expect(isAgentEditing()).toBe(false);
});

test("New chat stop failure rejects sends until termination is confirmed", async () => {
  await useClaudeStore.getState().send("First");
  emit({ type: "result", is_error: false });
  await tick();
  let failures = 1;
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_stop" && failures-- > 0
      ? Promise.reject(new Error("IPC failure"))
      : defaultInvoke(command, args),
  );
  await useClaudeStore.getState().newChat("/notes/a.md");
  expect(useClaudeStore.getState().status).toBe("stopping");
  expect(await useClaudeStore.getState().send("Unsafe reuse")).toBe(false);
  await useClaudeStore.getState().stop();
  expect(useClaudeStore.getState().status).toBe("idle");
  await useClaudeStore.getState().send("Fresh");
  expect(channels).toHaveLength(2);
  await useClaudeStore.getState().stop();
});
test("a rejected stale navigation read preserves the final reload and its tab", async () => {
  await useClaudeStore.getState().send("Edit both");
  disk.set("/notes/b.md", "Old B");
  const stale = deferred<unknown>();
  let reads = 0;
  mockedInvoke.mockImplementation((command, args) =>
    command === "read_file" && (args as { path: string }).path === "/notes/b.md" && reads++ === 0
      ? stale.promise
      : defaultInvoke(command, args),
  );
  const loading = useEditorStore.getState().openFileInNewTab("/notes/b.md");
  disk.set("/notes/b.md", "New B");
  emit({ type: "result", is_error: false });
  await tick();
  useEditorStore.getState().updateContent("/notes/b.md", "New user edit");
  stale.reject(new Error("Delayed I/O failure"));
  await loading;
  expect(useEditorStore.getState().openFiles.get("/notes/b.md")?.content).toBe("New user edit");
  expect(useEditorStore.getState().activeFilePath).toBe("/notes/b.md");
});

test("malformed protocol data stops the process and preserves the visible error", async () => {
  await useClaudeStore.getState().send("Edit");
  channels[channels.length - 1].onmessage({ type: "claude", line: "invalid JSON" });
  await tick();
  expect(isAgentEditing()).toBe(false);
  expect(useClaudeStore.getState().error).toContain("Invalid Claude stream:");
  expect(mockedInvoke.mock.calls.some(([command]) => command === "claude_stop")).toBe(true);
});

test("CLI warnings remain inspectable after success without becoming turn errors", async () => {
  await useClaudeStore.getState().send("Hello");
  const channel = channels[channels.length - 1];
  const warning = "Warning: claude.ai MCP servers blocked by enterprise policy: example";
  channel.onmessage({ type: "stderr", message: warning });
  channel.onmessage({ type: "stderr", message: warning });
  expect(useClaudeStore.getState().error).toBeNull();
  expect(useClaudeStore.getState().status).toBe("running");
  emit({ type: "result", is_error: false });
  await tick();
  expect(useClaudeStore.getState().notices).toEqual([warning]);
  expect(useClaudeStore.getState().error).toBeNull();
  expect(isAgentEditing()).toBe(false);
  await useClaudeStore.getState().send("Second");
  expect(useClaudeStore.getState().notices).toEqual([warning]);
  emit({ type: "result", is_error: true, errors: ["Actual turn failure"] });
  await tick();
  expect(useClaudeStore.getState().error).toBe("Actual turn failure");
  expect(useClaudeStore.getState().notices).toEqual([warning]);
  await useClaudeStore.getState().newChat("/notes/a.md");
  expect(useClaudeStore.getState().notices).toEqual([]);
  channel.onmessage({ type: "stderr", message: "Stale notice" });
  expect(useClaudeStore.getState().notices).toEqual([]);
});
test("CLI notice buffer is bounded and cleared on process restart or workspace change", async () => {
  await useClaudeStore.getState().send("First");
  const channel = channels[channels.length - 1];
  for (let i = 0; i < 60; i++) channel.onmessage({ type: "stderr", message: `Notice ${i}` });
  expect(useClaudeStore.getState().notices).toHaveLength(50);
  expect(useClaudeStore.getState().notices[0]).toBe("Notice 10");
  await useClaudeStore.getState().stop();
  await useClaudeStore.getState().send("Restart");
  expect(useClaudeStore.getState().notices).toEqual([]);
  channels[channels.length - 1].onmessage({ type: "stderr", message: "Current notice" });
  useWorkspaceStore.setState((s) => ({ workspaceGeneration: s.workspaceGeneration + 1 }));
  expect(useClaudeStore.getState().notices).toEqual([]);
});

function requestPermission(id: string, tool = "mcp__plugin__search") {
  emit({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "can_use_tool",
      tool_name: tool,
      input: { query: "A writer's notes", limit: 3 },
    },
  });
}
function sentDecisions() {
  return mockedInvoke.mock.calls
    .filter(
      ([command, payload]) =>
        command === "claude_send" &&
        JSON.parse((payload as { line: string }).line).type === "control_response",
    )
    .map(([, payload]) => JSON.parse((payload as { line: string }).line));
}
test("queues distinct approvals, opens the panel and sends allow/deny once without persisting rules", async () => {
  await useClaudeStore.getState().send("Search");
  requestPermission("first");
  requestPermission("second", "Bash");
  requestPermission("first");
  expect(useClaudeStore.getState().permissions.map((entry) => entry.id)).toEqual([
    "first",
    "second",
  ]);
  expect(useSettingsStore.getState().settings["appearance.agent-panel-visible"]).toBe(true);
  expect(isAgentEditing()).toBe(true);
  const approving = useClaudeStore.getState().decidePermission("first", true);
  await useClaudeStore.getState().decidePermission("first", false);
  await approving;
  await useClaudeStore.getState().decidePermission("second", false);
  expect(sentDecisions()).toEqual([
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "first",
        response: {
          behavior: "allow",
          updatedInput: { query: "A writer's notes", limit: 3 },
        },
      },
    },
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "second",
        response: {
          behavior: "deny",
          message: "Denied by the user in Writer.",
        },
      },
    },
  ]);
  expect(useClaudeStore.getState().permissions).toEqual([]);
  expect(useClaudeStore.getState().status).toBe("running");
  emit({ type: "result", is_error: false });
  await tick();
});
test("canceling an approval invalidates its in-flight completion without losing another request", async () => {
  await useClaudeStore.getState().send("Search");
  requestPermission("first");
  requestPermission("second");
  const delivery = deferred<null>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_send" ? delivery.promise : defaultInvoke(command, args),
  );
  const approving = useClaudeStore.getState().decidePermission("first", true);
  emit({ type: "control_cancel_request", request_id: "first" });
  expect(useClaudeStore.getState().permissions.map((entry) => entry.id)).toEqual(["second"]);
  delivery.reject(new Error("Canceled write"));
  await approving;
  expect(useClaudeStore.getState().permissions[0].error).toBeUndefined();
  await useClaudeStore.getState().decidePermission("first", true);
  expect(sentDecisions()).toHaveLength(1);
  emit({ type: "result", is_error: false });
  await tick();
});
test("decision transport errors retain a retryable request and the editor lock", async () => {
  await useClaudeStore.getState().send("Search");
  requestPermission("request");
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_send"
      ? Promise.reject(new Error("Pipe unavailable"))
      : defaultInvoke(command, args),
  );
  await useClaudeStore.getState().decidePermission("request", true);
  expect(useClaudeStore.getState().permissions[0]).toMatchObject({
    pending: false,
    error: expect.stringContaining("Pipe unavailable"),
  });
  expect(isAgentEditing()).toBe(true);
  mockedInvoke.mockImplementation(defaultInvoke);
  await useClaudeStore.getState().decidePermission("request", false);
  expect(useClaudeStore.getState().permissions).toEqual([]);
  emit({ type: "result", is_error: false });
  await tick();
});
test("Stop removes approvals immediately and ignores late decisions and old requests", async () => {
  await useClaudeStore.getState().send("Search");
  requestPermission("request");
  const delivery = deferred<null>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_send" ? delivery.promise : defaultInvoke(command, args),
  );
  const approving = useClaudeStore.getState().decidePermission("request", true);
  const oldChannel = channels.at(-1)!;
  const stopping = useClaudeStore.getState().stop();
  expect(useClaudeStore.getState().permissions).toEqual([]);
  delivery.reject(new Error("Stopped"));
  await approving;
  await stopping;
  expect(useClaudeStore.getState().error).toBeNull();
  mockedInvoke.mockImplementation(defaultInvoke);
  await useClaudeStore.getState().send("New turn");
  emit(
    {
      type: "control_request",
      request_id: "old",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "old" } },
    },
    oldChannel,
  );
  expect(useClaudeStore.getState().permissions).toEqual([]);
  emit({ type: "result", is_error: false });
  await tick();
});
test.each(["result", "exit", "workspace"])("%s clears pending approvals", async (boundary) => {
  await useClaudeStore.getState().send("Search");
  requestPermission("request");
  if (boundary === "result") emit({ type: "result", is_error: false });
  else if (boundary === "exit") channels.at(-1)!.onmessage({ type: "exit", code: 0 });
  else
    useWorkspaceStore.setState((state) => ({ workspaceGeneration: state.workspaceGeneration + 1 }));
  await tick();
  expect(useClaudeStore.getState().permissions).toEqual([]);
  await useClaudeStore.getState().decidePermission("request", true);
  expect(sentDecisions()).toEqual([]);
});
test("unsupported interactive requests receive an explicit error response and diagnostic", async () => {
  await useClaudeStore.getState().send("Search");
  emit({ type: "control_request", request_id: "elicitation", request: { subtype: "unsupported" } });
  await tick();
  expect(sentDecisions()[0].response).toMatchObject({
    subtype: "error",
    request_id: "elicitation",
    error: expect.stringContaining("unsupported"),
  });
  expect(useClaudeStore.getState().notices).toContain(
    "Writer does not support this interactive request: unsupported",
  );
  emit({ type: "result", is_error: false });
  await tick();
});

test("terminal reconciliation rejects late approvals and completed IDs cannot be answered twice", async () => {
  await useClaudeStore.getState().send("Search");
  requestPermission("done");
  await useClaudeStore.getState().decidePermission("done", true);
  requestPermission("done");
  expect(useClaudeStore.getState().permissions).toEqual([]);
  const reload = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "read_file" ? reload.promise : defaultInvoke(command, args),
  );
  emit({ type: "result", is_error: false });
  requestPermission("late");
  expect(useClaudeStore.getState().status).toBe("stopping");
  expect(useClaudeStore.getState().permissions).toEqual([]);
  await tick();
  expect(sentDecisions().at(-1).response.response).toMatchObject({
    behavior: "deny",
    message: "No active Writer turn.",
  });
  reload.resolve({ path: "/notes/a.md", content: "Original", modified_at: 1 });
  await tick();
});
test("unsupported control transport failure remains visible after confirmed Stop", async () => {
  await useClaudeStore.getState().send("Search");
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_send"
      ? Promise.reject(new Error("Broken pipe"))
      : defaultInvoke(command, args),
  );
  emit({ type: "control_request", request_id: "unsupported", request: { subtype: "elicitation" } });
  await tick();
  expect(useClaudeStore.getState().status).toBe("error");
  expect(useClaudeStore.getState().error).toContain("Could not answer Claude Code: Broken pipe");
  expect(isAgentEditing()).toBe(false);
});

test("a delayed control transport failure survives terminal reconciliation", async () => {
  await useClaudeStore.getState().send("Search");
  const response = deferred<null>();
  const reload = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_send"
      ? response.promise
      : command === "read_file"
        ? reload.promise
        : defaultInvoke(command, args),
  );
  emit({ type: "control_request", request_id: "unsupported", request: { subtype: "elicitation" } });
  emit({ type: "result", is_error: false });
  expect(useClaudeStore.getState().status).toBe("stopping");
  response.reject(new Error("Late broken pipe"));
  await tick();
  reload.resolve({ path: "/notes/a.md", content: "Original", modified_at: 1 });
  await tick();
  expect(useClaudeStore.getState().status).toBe("error");
  expect(useClaudeStore.getState().error).toContain(
    "Could not answer Claude Code: Late broken pipe",
  );
  expect(isAgentEditing()).toBe(false);
});

test("exposes thinking immediately, streams answers before result and preserves multiple text blocks", async () => {
  const sending = useClaudeStore.getState().send("Explain");
  expect(useClaudeStore.getState().activity).toBe("thinking");
  await sending;
  emit({ type: "stream_event", event: { type: "message_start", message: { id: "reply" } } });
  expect(chatMessages("/notes/a.md").filter((message) => message.role === "assistant")).toEqual([]);
  emit({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Private reasoning" },
    },
  });
  expect(useClaudeStore.getState().activity).toBe("thinking");
  emit({
    type: "stream_event",
    event: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "First answer." },
    },
  });
  expect(useClaudeStore.getState().activity).toBe("responding");
  expect(chatMessages("/notes/a.md").at(-1)?.text).toBe("First answer.");
  expect(useClaudeStore.getState().status).toBe("running");
  emit({
    type: "assistant",
    uuid: "first",
    message: { id: "reply", content: [{ type: "text", text: "First answer." }] },
  });
  emit({
    type: "stream_event",
    event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 2,
      delta: { type: "text_delta", text: "Second answer." },
    },
  });
  emit({
    type: "assistant",
    uuid: "second",
    message: { id: "reply", content: [{ type: "text", text: "Second answer." }] },
  });
  expect(chatMessages("/notes/a.md").at(-1)?.text).toBe("First answer.\n\nSecond answer.");
  emit({ type: "result", is_error: false });
  await tick();
  expect(useClaudeStore.getState().activity).toBeNull();
});

test("tool progress returns to thinking and approval does not erase activity", async () => {
  await useClaudeStore.getState().send("Read");
  emit({ type: "stream_event", event: { type: "message_start", message: { id: "tool" } } });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "read", name: "Read" },
    },
  });
  expect(useClaudeStore.getState().activity).toBe("working");
  requestPermission("read");
  expect(useClaudeStore.getState().permissions).toHaveLength(1);
  await useClaudeStore.getState().decidePermission("read", true);
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read" }] } });
  expect(useClaudeStore.getState().activity).toBe("thinking");
  await useClaudeStore.getState().stop();
  expect(useClaudeStore.getState().activity).toBeNull();
});

test.each(["stop", "error", "workspace"])(
  "%s ends thinking while preserving partial answers where applicable",
  async (boundary) => {
    await useClaudeStore.getState().send("Explain");
    emit({ type: "stream_event", event: { type: "message_start", message: { id: "reply" } } });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "A partial answer" },
      },
    });
    if (boundary === "stop") await useClaudeStore.getState().stop();
    else if (boundary === "error")
      emit({ type: "result", is_error: true, errors: ["Disconnected"] });
    else
      useWorkspaceStore.setState((state) => ({
        workspaceGeneration: state.workspaceGeneration + 1,
      }));
    await tick();
    expect(useClaudeStore.getState().activity).toBeNull();
    if (boundary !== "workspace")
      expect(chatMessages("/notes/a.md").at(-1)?.text).toBe("A partial answer");
  },
);

test("abandoned tools from a stopped turn do not suppress thinking after later tools finish", async () => {
  await useClaudeStore.getState().send("First");
  emit({ type: "stream_event", event: { type: "message_start", message: { id: "old" } } });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "old-tool", name: "Read" },
    },
  });
  await useClaudeStore.getState().stop();
  await useClaudeStore.getState().send("Second");
  emit({ type: "stream_event", event: { type: "message_start", message: { id: "new" } } });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "new-tool", name: "Read" },
    },
  });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "new-tool" }] } });
  expect(useClaudeStore.getState().activity).toBe("thinking");
  emit({ type: "result", is_error: false });
  await tick();
});

test.each(["new-chat", "exit", "malformed", "send-failure"])(
  "%s clears activity",
  async (boundary) => {
    if (boundary === "send-failure")
      mockedInvoke.mockImplementation((command, args) =>
        command === "claude_send"
          ? Promise.reject(new Error("Delivery failed"))
          : defaultInvoke(command, args),
      );
    await useClaudeStore.getState().send("Explain");
    if (boundary === "new-chat") await useClaudeStore.getState().newChat("/notes/a.md");
    else if (boundary === "exit") channels.at(-1)!.onmessage({ type: "exit", code: 1 });
    else if (boundary === "malformed")
      channels.at(-1)!.onmessage({ type: "claude", line: "not JSON" });
    await tick();
    expect(useClaudeStore.getState().activity).toBeNull();
    expect(useClaudeStore.getState().status).not.toBe("running");
  },
);

test("each note keeps its own conversation and resumes its own session", async () => {
  const starts = () =>
    mockedInvoke.mock.calls
      .filter(([command]) => command === "claude_start")
      .map(([, payload]) => (payload as { resumeSessionId: string | null }).resumeSessionId);
  await useClaudeStore.getState().send("About A");
  emit({ type: "system", subtype: "init", session_id: "session-a" });
  emit({ type: "result", is_error: false });
  await tick();
  disk.set("/notes/b.md", "Before B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  await useClaudeStore.getState().send("About B");
  emit({ type: "system", subtype: "init", session_id: "session-b" });
  emit({ type: "result", is_error: false });
  await tick();
  expect(chatMessages("/notes/a.md").map((message) => message.text)).toEqual(["About A"]);
  expect(chatMessages("/notes/b.md").map((message) => message.text)).toEqual(["About B"]);
  useEditorStore.getState().setActiveFile("/notes/a.md");
  await useClaudeStore.getState().send("Back to A");
  expect(starts()).toEqual([null, null, "session-a"]);
  emit({ type: "result", is_error: false });
  await tick();
  await useClaudeStore.getState().newChat("/notes/b.md");
  expect(chatMessages("/notes/b.md")).toEqual([]);
  expect(chatMessages("/notes/a.md")).toHaveLength(2);
  await useClaudeStore.getState().rewriteChatPaths("/notes", "/notes/a.md", "/notes/c.md", false);
  expect(chatMessages("/notes/c.md")).toHaveLength(2);
  expect(chatMessages("/notes/a.md")).toEqual([]);
});

test("captured feedback path is independent of the active tab and survives tab closure", async () => {
  disk.set("/notes/b.md", "Before B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  const complete = vi.fn();
  const prepare = vi.fn((content: string) => `Feedback for A: ${content}`);
  expect(
    await useClaudeStore
      .getState()
      .send("Feedback", { turn: { path: "/notes/a.md", prepare, complete } }),
  ).toBe(true);
  const payload = mockedInvoke.mock.calls.filter(([c]) => c === "claude_send").at(-1)![1] as {
    line: string;
  };
  expect(payload.line).toContain('openFile\\\":\\\"/notes/a.md');
  expect(payload.line).toContain("Feedback for A:");
  useEditorStore.getState().closeFile("/notes/a.md");
  disk.set("/notes/a.md", "Revised A");
  disk.set("/notes/b.md", "Revised B");
  emit({ type: "result", is_error: false });
  await tick();
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    status: "completed",
    changed: true,
    error: null,
  });
  emit({ type: "result", is_error: false });
  await tick();
  expect(complete).toHaveBeenCalledTimes(1);
});

test("successive feedback turns on one process settle their own request; unrelated changes are no-op", async () => {
  const first = vi.fn(),
    second = vi.fn();
  await useClaudeStore
    .getState()
    .send("First", { turn: { path: "/notes/a.md", prepare: () => "First", complete: first } });
  emit({ type: "result", is_error: false });
  await tick();
  expect(first).toHaveBeenCalledExactlyOnceWith({
    status: "completed",
    changed: false,
    error: null,
  });
  await useClaudeStore
    .getState()
    .send("Second", { turn: { path: "/notes/a.md", prepare: () => "Second", complete: second } });
  disk.set("/notes/a.md", "Revised");
  emit({ type: "result", is_error: false });
  await tick();
  expect(second).toHaveBeenCalledExactlyOnceWith({
    status: "completed",
    changed: true,
    error: null,
  });
  expect(first).toHaveBeenCalledTimes(1);
});

test("Stop during feedback preparation settles cancellation exactly once without sending", async () => {
  const prepare = deferred<string>(),
    complete = vi.fn();
  const send = useClaudeStore
    .getState()
    .send("Feedback", { turn: { path: "/notes/a.md", prepare: () => prepare.promise, complete } });
  await tick();
  const stop = useClaudeStore.getState().stop();
  prepare.resolve("Prepared");
  await Promise.all([send, stop]);
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    status: "cancelled",
    changed: false,
    error: null,
  });
  expect(mockedInvoke.mock.calls.some(([command]) => command === "claude_send")).toBe(false);
});

test("partial changes survive failed Stop and require cancelled completion after termination retry", async () => {
  const complete = vi.fn();
  await useClaudeStore
    .getState()
    .send("Feedback", { turn: { path: "/notes/a.md", prepare: () => "Prepared", complete } });
  disk.set("/notes/a.md", "Partly revised");
  let failures = 1;
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_stop" && failures-- > 0
      ? Promise.reject(new Error("IPC failure"))
      : defaultInvoke(command, args),
  );
  await useClaudeStore.getState().stop();
  expect(complete).not.toHaveBeenCalled();
  await useClaudeStore.getState().stop();
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    status: "cancelled",
    changed: true,
    error: null,
  });
});

test("reconciliation failure cannot resolve feedback; retry settles only after reload", async () => {
  const complete = vi.fn();
  await useClaudeStore
    .getState()
    .send("Feedback", { turn: { path: "/notes/a.md", prepare: () => "Prepared", complete } });
  disk.set("/notes/a.md", "Revised");
  let failures = 1;
  mockedInvoke.mockImplementation((command, args) =>
    command === "read_file" && failures-- > 0
      ? Promise.reject(new Error("Cannot read"))
      : defaultInvoke(command, args),
  );
  emit({ type: "result", is_error: false });
  await tick();
  expect(complete).not.toHaveBeenCalled();
  expect(isAgentEditing()).toBe(true);
  await useClaudeStore.getState().stop();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]![0]).toMatchObject({ status: "cancelled", changed: true });
});

test("post-save preparation validates normalized disk content and rejects stale targets", async () => {
  useSettingsStore.setState({
    settings: { "files.trim-trailing-whitespace": true, "files.insert-final-newline": true },
  });
  useEditorStore.getState().updateContent("/notes/a.md", "Draft   ");
  const complete = vi.fn(),
    prepare = vi.fn(() => {
      throw new Error("Reattach target");
    });
  expect(
    await useClaudeStore
      .getState()
      .send("Feedback", { turn: { path: "/notes/a.md", prepare, complete } }),
  ).toBe(false);
  expect(prepare).toHaveBeenCalledWith("Draft\n");
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    status: "failed",
    changed: false,
    error: "Reattach target",
  });
  expect(mockedInvoke.mock.calls.some(([command]) => command === "claude_start")).toBe(false);
});

test("an in-flight relocation rejects an agent handoff and a handoff rejects new moves", async () => {
  const release = beginPathMutation();
  try {
    expect(await useClaudeStore.getState().send("Feedback")).toBe(false);
  } finally {
    release();
  }
  await useClaudeStore.getState().send("Feedback");
  expect(() => beginPathMutation()).toThrow("AI editing");
  await useClaudeStore.getState().stop();
});

test("deleted captured feedback file is a terminal failure and releases the global lock", async () => {
  const complete = vi.fn();
  await useClaudeStore
    .getState()
    .send("Feedback", { turn: { path: "/notes/a.md", prepare: () => "Prepared", complete } });
  disk.delete("/notes/a.md");
  emit({ type: "result", is_error: false });
  await tick();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]![0]).toMatchObject({ status: "failed", changed: true });
  expect(isAgentEditing()).toBe(false);
  expect(useEditorStore.getState().openFiles.has("/notes/a.md")).toBe(false);
});

function createFeedback(source: string, target = 0) {
  const store = useFeedbackStore.getState();
  store.reconcile("/notes/a.md", null, source);
  store.attach("/notes/a.md", feedbackTargets(source)[target]!);
  const id = feedbackItems().at(-1)!.id;
  store.saveNotes(
    "/notes/a.md",
    target === 0 ? "Shorten the opening" : "Clarify the second paragraph",
  );
  return id;
}
const feedbackItems = () => useFeedbackStore.getState().byPath["/notes/a.md"]!;

test("applying one note resolves only that note after closed-file reconciliation", async () => {
  disk.set("/notes/a.md", "Original\n\nSecond");
  useEditorStore.getState().reloadFromDisk("/notes/a.md", disk.get("/notes/a.md")!);
  const first = createFeedback("Original\n\nSecond");
  createFeedback("Original\n\nSecond", 1);
  disk.set("/notes/b.md", "Other");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  await applyFeedback("/notes/a.md", [first]);
  expect(feedbackItems().map((x) => x.status)).toEqual(["running", "pending"]);
  useEditorStore.getState().closeFile("/notes/a.md");
  disk.set("/notes/a.md", "Revised\n\nSecond");
  emit({ type: "result", is_error: false });
  await tick();
  expect(feedbackItems().map((x) => x.status)).toEqual(["pending"]);
  expect(feedbackItems()[0]!.anchor.attached).toBe(true);
});

test("real batch does not resolve when the feedback reconciliation read fails", async () => {
  const id = createFeedback("Original");
  await applyFeedback("/notes/a.md", [id]);
  disk.set("/notes/a.md", "Revised");
  let reads = 0;
  mockedInvoke.mockImplementation((command, args) =>
    command === "read_file" && ++reads === 3
      ? Promise.reject(new Error("Feedback reconciliation failed"))
      : defaultInvoke(command, args),
  );
  emit({ type: "result", is_error: false });
  await tick();
  expect(reads).toBe(3);
  expect(feedbackItems()[0]!.status).toBe("running");
  expect(isAgentEditing()).toBe(true);
  expect(useClaudeStore.getState().error).toContain("Feedback reconciliation failed");
  await useClaudeStore.getState().stop();
  expect(feedbackItems()[0]).toMatchObject({ status: "pending", reviewRequired: true });
  expect(isAgentEditing()).toBe(false);
});

test("real batch success clears request errors; a no-op and Stop stay pending", async () => {
  const id = createFeedback("Original");
  await applyFeedback("/notes/a.md", [id]);
  emit({ type: "result", is_error: false });
  await tick();
  expect(feedbackItems()[0]!.status).toBe("pending");
  expect(useFeedbackStore.getState().error).toContain("No document changes");
  await applyFeedback("/notes/a.md", [id]);
  expect(useFeedbackStore.getState().error).toBeNull();
  await useClaudeStore.getState().stop();
  expect(feedbackItems()[0]!.status).toBe("pending");
  await applyFeedback("/notes/a.md", [id]);
  disk.set("/notes/a.md", "Revised");
  emit({ type: "result", is_error: false });
  await tick();
  expect(feedbackItems()).toEqual([]);
  expect(useFeedbackStore.getState().error).toBeNull();
});

test("cancelled shutdown retains a real completion and permits retry without workspace reload", async () => {
  disk.set("/notes/a.md", "Original\n\nSecond");
  useEditorStore.getState().reloadFromDisk("/notes/a.md", disk.get("/notes/a.md")!);
  const first = createFeedback("Original\n\nSecond");
  const second = createFeedback("Original\n\nSecond", 1);
  await applyFeedback("/notes/a.md", [first]);
  const save = deferred<void>();
  vi.mocked(writePreferenceStrict).mockImplementation(() => save.promise);
  useFeedbackStore.getState().takeBack("/notes/a.md", second);
  useFeedbackStore.getState().saveNotes("/notes/a.md", "Retained comment");
  const closing = flushAllFeedbackPersistence();
  const rejected = expect(closing).rejects.toThrow("Disk full");
  await tick();
  expect(() => beginPathMutation()).toThrow("before closing");
  disk.set("/notes/a.md", "Revised\n\nSecond");
  emit({ type: "result", is_error: false });
  await tick();
  expect(feedbackItems().map((x) => x.id)).toEqual([second]);
  save.reject(new Error("Disk full"));
  await rejected;
  resumeFeedbackPersistence();
  expect(useClaudeStore.getState().status).toBe("idle");
  expect(feedbackItems().map((x) => x.id)).toEqual([second]);
  vi.mocked(writePreferenceStrict).mockResolvedValue(undefined);
  await useFeedbackStore.getState().retryPersistence();
  await applyFeedback("/notes/a.md", [second]);
  expect(feedbackItems()[0]!.status).toBe("running");
  await useClaudeStore.getState().stop();
});
