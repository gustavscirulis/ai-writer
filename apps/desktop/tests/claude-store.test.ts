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
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), applyCssVarBindings: vi.fn() }));
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async () => null),
  setPreference: vi.fn(async () => {}),
  readPreferenceStrict: vi.fn(async () => undefined),
  writePreferenceStrict: vi.fn(async () => {}),
  readStoreEntriesStrict: vi.fn(async () => []),
  writeStoreEntriesStrict: vi.fn(async () => {}),
}));
import { invoke } from "@tauri-apps/api/core";
import { useClaudeStore, chatForPath } from "../src/stores/claude-store";
import { useEditorStore } from "../src/stores/editor-store";
import { useWorkspaceStore } from "../src/stores/workspace-store";
import {
  useFeedbackStore,
  beginFeedbackClose,
  flushAllFeedbackPersistence,
  resumeFeedbackPersistence,
} from "../src/stores/feedback-store";
import { feedbackTargets } from "../src/lib/feedback-anchors";
import {
  readStoreEntriesStrict,
  writePreferenceStrict,
  writeStoreEntriesStrict,
} from "../src/lib/preferences";
import { applyFeedback } from "../src/hooks/use-feedback";
import { useSettingsStore } from "../src/stores/settings-store";
import {
  agentIORevision,
  isAgentEditing,
  isAgentTurnActive,
  beginPathMutation,
  registerPendingEditorFlush,
  setAppClosing,
  WORKSPACE_CHAT,
} from "../src/lib/agent-turn";
import { registerEditorView } from "../src/lib/editor-views";
import { newChat, registerChatComposer } from "../src/hooks/use-claude";
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
  channel.onmessage({ type: "line", line: JSON.stringify(data) });
let edits = 0;
/** Opens Writer's native edit gate as Claude Code does before applying Edit/Write. */
async function startEdit(channel = channels[channels.length - 1], path = "/notes/a.md") {
  const id = `edit-${++edits}`;
  channel.onmessage({ type: "edit_start", requestId: id, toolUseId: id, path });
  await tick();
  return id;
}
async function claudeEdits(
  write: () => void,
  channel = channels[channels.length - 1],
  path = "/notes/a.md",
) {
  const id = await startEdit(channel, path);
  write();
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } }, channel);
  await tick();
}
const chatState = (path = "/notes/a.md") => chatForPath(useClaudeStore.getState().chats, path);
const send = (
  text: string,
  options?: Parameters<ReturnType<typeof useClaudeStore.getState>["send"]>[2],
) =>
  useClaudeStore
    .getState()
    .send(options?.turn?.path ?? useEditorStore.getState().activeFilePath ?? "", text, options);
const chatMessages = (path: string) => useClaudeStore.getState().chats[path]?.messages ?? [];
const tick = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
async function reopenWithSavedChat(
  record: { messages: unknown[]; [field: string]: unknown },
  path = "/notes/a.md",
) {
  vi.mocked(readStoreEntriesStrict).mockResolvedValue([
    [`/notes\0${path}`, { version: 1, ...record }],
  ]);
  useWorkspaceStore.setState((s) => ({ workspaceGeneration: s.workspaceGeneration + 1 }));
  await tick();
  await useFeedbackStore
    .getState()
    .load("/notes", useWorkspaceStore.getState().workspaceGeneration);
}
const savedChats = () =>
  vi
    .mocked(writeStoreEntriesStrict)
    .mock.calls.flatMap(([, changes]) => changes as [string, unknown][]);
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
  if (command === "claude_start" || command === "codex_start")
    return Promise.resolve(`process-${channels.length}`);
  return Promise.resolve(null);
}
beforeEach(async () => {
  resumeFeedbackPersistence();
  vi.mocked(writePreferenceStrict).mockReset().mockResolvedValue(undefined);
  vi.mocked(writeStoreEntriesStrict).mockReset().mockResolvedValue(undefined);
  vi.mocked(readStoreEntriesStrict).mockReset().mockResolvedValue([]);
  vi.clearAllMocks();
  vi.mocked(writePreferenceStrict).mockResolvedValue(undefined);
  channels.length = 0;
  edits = 0;
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
      : command === "agent_send"
        ? delivery.promise
        : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "  Edit this\n");
  const sending = send("  Edit this\n");
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("");
  expect(chatMessages("/notes/a.md")).toHaveLength(1);
  expect(chatMessages("/notes/a.md")[0]).toMatchObject({ role: "user", text: "Edit this" });
  const messageId = chatMessages("/notes/a.md")[0].id;
  await tick();
  start.resolve("process");
  await tick();
  expect(chatMessages("/notes/a.md").at(-1)?.text).toBe("Edit this");
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("");
  useClaudeStore.getState().setDraft("/notes/a.md", "Next message");
  delivery.resolve(null);
  expect(await sending).toBe(true);
  expect(chatMessages("/notes/a.md")).toHaveLength(1);
  expect(chatMessages("/notes/a.md")[0].id).toBe(messageId);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Next message");
});

test.each(["write_file", "claude_start", "agent_send"])(
  "%s failure restores the original composer draft",
  async (failedCommand) => {
    mockedInvoke.mockImplementation((command, args) =>
      command === failedCommand
        ? Promise.reject(new Error("Unavailable"))
        : defaultInvoke(command, args),
    );
    useEditorStore.getState().updateContent("/notes/a.md", "Dirty buffer");
    useClaudeStore.getState().setDraft("/notes/a.md", "  Retry this\n");
    expect(await send("  Retry this\n")).toBe(false);
    expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("  Retry this\n");
    expect(chatMessages("/notes/a.md")).toHaveLength(1);
    expect(chatMessages("/notes/a.md")[0].text).toBe("Retry this");
    expect(chatState().error).toContain("Unavailable");
  },
);

test.each(["write_file", "read_file", "claude_start"])(
  "the submitted message is visible while %s is pending",
  async (pendingCommand) => {
    const pending = deferred<unknown>();
    let pendingArgs: unknown;
    mockedInvoke.mockImplementation((command, args) => {
      if (command === pendingCommand) {
        pendingArgs = args;
        return pending.promise;
      }
      return defaultInvoke(command, args);
    });
    useEditorStore.getState().updateContent("/notes/a.md", "Dirty buffer");
    const sending = send("Immediate message");
    const message = chatMessages("/notes/a.md")[0];
    expect(message).toMatchObject({ role: "user", text: "Immediate message" });
    expect(chatState()).toMatchObject({ status: "running", activity: "thinking" });
    await tick();
    expect(pendingArgs).toBeDefined();
    expect(chatMessages("/notes/a.md")).toEqual([message]);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "agent_send")).toBe(false);
    pending.resolve(await defaultInvoke(pendingCommand, pendingArgs));
    expect(await sending).toBe(true);
    expect(chatMessages("/notes/a.md")).toEqual([message]);
  },
);

test("retrying a failed startup adds one new submitted message", async () => {
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start"
      ? Promise.reject(new Error("Startup failed"))
      : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "Retry this");
  expect(await send("Retry this")).toBe(false);
  await tick();
  const first = chatMessages("/notes/a.md")[0];
  mockedInvoke.mockImplementation(defaultInvoke);
  const retry = send("Retry this");
  expect(chatMessages("/notes/a.md")).toHaveLength(2);
  expect(chatMessages("/notes/a.md")[0]).toBe(first);
  expect(chatMessages("/notes/a.md")[1].id).not.toBe(first.id);
  expect(await retry).toBe(true);
  expect(chatMessages("/notes/a.md")).toHaveLength(2);
});

test("a failed send keeps a newer draft", async () => {
  const start = deferred<string>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start" ? start.promise : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "First");
  const sending = send("First");
  await tick();
  useClaudeStore.getState().setDraft("/notes/a.md", "New draft");
  start.reject(new Error("Startup failed"));
  expect(await sending).toBe(false);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("New draft");
});

test("a result retains ownership until its delivery acknowledgement settles", async () => {
  const delivery = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_send" ? delivery.promise : defaultInvoke(command, args),
  );
  const first = send("First");
  await tick();
  emit({ type: "result", is_error: false });
  useClaudeStore.getState().setDraft("/notes/a.md", "Second");
  expect(await send("Second")).toBe(false);
  expect(isAgentTurnActive("/notes/a.md")).toBe(true);
  delivery.reject(new Error("Late failure"));
  expect(await first).toBe(false);
  await tick();
  expect(chatState().draft).toBe("Second");
  expect(isAgentTurnActive("/notes/a.md")).toBe(false);
  mockedInvoke.mockImplementation(defaultInvoke);
  expect(await send("Second")).toBe(true);
});

test("failed delivery restores only the originating note's draft after tab switching", async () => {
  const delivery = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_send" ? delivery.promise : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "For A");
  const sending = send("For A");
  const message = chatMessages("/notes/a.md")[0];
  expect(message?.text).toBe("For A");
  await tick();
  disk.set("/notes/b.md", "B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  useClaudeStore.getState().setDraft("/notes/b.md", "For B");
  delivery.reject(new Error("Delivery failed"));
  expect(await sending).toBe(false);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("For A");
  expect(useClaudeStore.getState().chats["/notes/b.md"].draft).toBe("For B");
  expect(chatMessages("/notes/a.md")).toEqual([message]);
  expect(chatMessages("/notes/b.md")).toEqual([]);
});

test.each(["New chat", "workspace reset"])(
  "late startup success cannot repopulate messages after %s",
  async (reset) => {
    const start = deferred<string>();
    mockedInvoke.mockImplementation((command, args) =>
      command === "claude_start" ? start.promise : defaultInvoke(command, args),
    );
    const sending = send("Old message");
    expect(chatMessages("/notes/a.md")[0]?.text).toBe("Old message");
    await tick();
    const oldChannel = channels[0];
    let resetting: Promise<void> | undefined;
    if (reset === "New chat") resetting = useClaudeStore.getState().newChat("/notes/a.md");
    else
      useWorkspaceStore.setState((state) => ({
        workspaceGeneration: state.workspaceGeneration + 1,
      }));
    start.resolve("old-process");
    expect(await sending).toBe(false);
    await resetting;
    oldChannel.onmessage({
      type: "line",
      line: JSON.stringify({ type: "result", is_error: false }),
    });
    await tick();
    expect(chatMessages("/notes/a.md")).toEqual([]);
    expect(mockedInvoke.mock.calls.some(([command]) => command === "agent_send")).toBe(false);
  },
);

test("an abandoned workspace send never restores a draft into the new workspace", async () => {
  const start = deferred<string>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start" ? start.promise : defaultInvoke(command, args),
  );
  useClaudeStore.getState().setDraft("/notes/a.md", "Old workspace");
  const sending = send("Old workspace");
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
  const suggestion = send("Suggestion");
  expect(chatMessages("/notes/a.md")[0]?.text).toBe("Suggestion");
  expect(await suggestion).toBe(true);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Unsent draft");
  await useClaudeStore.getState().stop("/notes/a.md");
  const feedback = send("Unsent draft", {
    turn: { path: "/notes/a.md", prepare: () => "Feedback prompt", complete: vi.fn() },
  });
  expect(chatMessages("/notes/a.md").map((message) => message.text)).toEqual([
    "Suggestion",
    "Unsent draft",
  ]);
  expect(await feedback).toBe(true);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Unsent draft");
});

test("empty and busy sends leave the composer draft intact", async () => {
  useClaudeStore.getState().setDraft("/notes/a.md", "Draft");
  expect(await send(" ")).toBe(false);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Draft");
  expect(chatMessages("/notes/a.md")).toEqual([]);
  expect(await useClaudeStore.getState().send("/notes/missing.md", "Invalid")).toBe(false);
  expect(chatMessages("/notes/missing.md")).toEqual([]);
  await send("First");
  expect(await send("Draft")).toBe(false);
  expect(useClaudeStore.getState().chats["/notes/a.md"].draft).toBe("Draft");
  expect(chatMessages("/notes/a.md").map((message) => message.text)).toEqual(["First"]);
});

test("saves the target before starting and locks it only while an edit is applied", async () => {
  useEditorStore.getState().updateContent("/notes/a.md", "Latest draft");
  const revision = agentIORevision();
  const sending = send("Tighten this");
  expect(isAgentTurnActive("/notes/a.md")).toBe(true);
  expect(isAgentEditing("/notes/a.md")).toBe(false);
  expect(await sending).toBe(true);
  expect(disk.get("/notes/a.md")).toBe("Latest draft");
  useEditorStore.getState().updateContent("/notes/a.md", "Typed while thinking");
  disk.set("/notes/b.md", "Before B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  await claudeEdits(() => {
    expect(isAgentEditing("/notes/a.md")).toBe(true);
    expect(disk.get("/notes/a.md")).toBe("Typed while thinking");
    useEditorStore.getState().updateContent("/notes/a.md", "Forbidden");
    disk.set("/notes/a.md", "Revised A");
    useEditorStore.getState().updateContent("/notes/b.md", "User edit B");
  });
  expect(mockedInvoke.mock.calls.filter(([c]) => c === "agent_edit_ready")).toEqual([
    ["agent_edit_ready", { processId: "process-1", requestId: "edit-1", allow: true }],
  ]);
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Revised A");
  expect(isAgentEditing("/notes/a.md")).toBe(false);
  expect(isAgentTurnActive("/notes/a.md")).toBe(true);
  expect(disk.get("/notes/b.md")).toBe("User edit B");
  emit({ type: "result", is_error: false });
  await tick();
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Revised A");
  expect(useEditorStore.getState().openFiles.get("/notes/b.md")?.content).toBe("User edit B");
  expect(isAgentTurnActive()).toBe(false);
  expect(agentIORevision()).toBeGreaterThan(revision);
});
test("Stop during an edit reloads the note and releases the lock", async () => {
  await send("Edit");
  await startEdit();
  disk.set("/notes/a.md", "Partly revised");
  expect(isAgentEditing("/notes/a.md")).toBe(true);
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(isAgentEditing("/notes/a.md")).toBe(false);
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Partly revised");
});
test("a failed save before an edit denies it and keeps the note editable", async () => {
  await send("Edit");
  mockedInvoke.mockImplementation((command, args) =>
    command === "write_file"
      ? Promise.reject(new Error("Disk full"))
      : defaultInvoke(command, args),
  );
  useEditorStore.getState().updateContent("/notes/a.md", "Unsaved");
  await claudeEdits(() => {});
  expect(mockedInvoke.mock.calls.filter(([c]) => c === "agent_edit_ready").at(-1)?.[1]).toEqual({
    processId: "process-1",
    requestId: "edit-1",
    allow: false,
  });
  expect(chatState().notices.at(-1)?.text).toContain("Disk full");
  expect(isAgentEditing("/notes/a.md")).toBe(false);
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Unsaved");
  mockedInvoke.mockImplementation(defaultInvoke);
  await useClaudeStore.getState().stop("/notes/a.md");
});
test("attachments reach Claude as saved-file lines and stay on the user message", async () => {
  disk.set("/notes/a.md", "---\ntitle: A\n---\nIntro\n\nOne two three");
  useEditorStore.getState().reloadFromDisk("/notes/a.md", disk.get("/notes/a.md")!);
  const body = useEditorStore.getState().openFiles.get("/notes/a.md")!.content;
  const view = { state: EditorState.create({ doc: body }) } as EditorView;
  const unregister = registerEditorView("/notes/a.md", view, () => {});
  const [, paragraph] = feedbackTargets(body);
  const attachments = [{ anchor: paragraph!, quote: "two" }];
  const sending = send("Cut this", { attachments });
  expect(chatMessages("/notes/a.md")[0]).toMatchObject({ text: "Cut this", attachments });
  expect(await sending).toBe(true);
  expect(chatMessages("/notes/a.md")).toHaveLength(1);
  unregister();
  const payload = mockedInvoke.mock.calls.filter(([c]) => c === "agent_send").at(-1)![1] as {
    content: string;
  };
  const content = payload.content;
  const context = JSON.parse(content.match(/<writer_context>(.*)<\/writer_context>/)![1]!);
  expect(context.attachments).toEqual([{ fromLine: 6, toLine: 6, text: "two" }]);
  expect(chatMessages("/notes/a.md").at(-1)).toMatchObject({ text: "Cut this", attachments });
});
test("attached files reach Claude by path, stay on the saved message and leave the composer", async () => {
  const files = ["/Users/me/Downloads/diagram.png", "/notes/b.md"];
  useClaudeStore.getState().addFiles("/notes/a.md", [...files, files[0]!]);
  expect(chatState().files).toEqual(files);
  const sending = send("What changed?", { files });
  expect(chatState().files).toEqual([]);
  expect(chatMessages("/notes/a.md")[0]).toMatchObject({ text: "What changed?", files });
  expect(await sending).toBe(true);
  const payload = mockedInvoke.mock.calls.filter(([c]) => c === "agent_send").at(-1)![1] as {
    content: string;
    files: string[];
  };
  expect(payload.files).toEqual(files);
  const content = payload.content;
  const context = JSON.parse(content.match(/<writer_context>(.*)<\/writer_context>/)![1]!);
  expect(context.files).toEqual(files);
  const saved = savedChats().filter(([key]) => key.endsWith("/notes/a.md"));
  expect(saved.at(-1)![1]).toMatchObject({ messages: [{ text: "What changed?", files }] });
});
test("a failed send puts its attached files back in the composer", async () => {
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_send"
      ? Promise.reject(new Error("Couldn't find diagram.png."))
      : defaultInvoke(command, args),
  );
  useClaudeStore.getState().addFiles("/notes/a.md", ["/tmp/diagram.png"]);
  const sending = send("Describe it", { files: ["/tmp/diagram.png"] });
  useClaudeStore.getState().addFiles("/notes/a.md", ["/tmp/later.pdf"]);
  expect(await sending).toBe(false);
  expect(chatState().files).toEqual(["/tmp/diagram.png", "/tmp/later.pdf"]);
  expect(chatState().error).toContain("Couldn't find diagram.png.");
});
test("a mentioned note stays attached only while its pill is in the draft", () => {
  const store = useClaudeStore.getState();
  const mention = { path: "/notes/style.md", label: "Style guide" };
  store.addMention("/notes/a.md", mention);
  expect(chatState().files).toEqual([]);
  store.addFiles("/notes/a.md", ["/tmp/diagram.png"]);
  store.setDraft("/notes/a.md", "match @Style guide ");
  store.addMention("/notes/a.md", mention);
  expect(chatState()).toMatchObject({
    files: ["/tmp/diagram.png", "/notes/style.md"],
    mentions: [mention],
  });
  store.setDraft("/notes/a.md", "match @Style guide, please");
  expect(chatState().mentions).toEqual([mention]);
  store.setDraft("/notes/a.md", "match @Style gui, please");
  expect(chatState()).toMatchObject({ files: ["/tmp/diagram.png"], mentions: [] });
});
test("a sent message keeps its mentions, and a failed send puts them back in the draft", async () => {
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_send"
      ? Promise.reject(new Error("Couldn't start."))
      : defaultInvoke(command, args),
  );
  const store = useClaudeStore.getState();
  const mention = { path: "/notes/style.md", label: "Style" };
  store.setDraft("/notes/a.md", "match @Style");
  store.addMention("/notes/a.md", mention);
  const sending = send("match @Style", { files: ["/notes/style.md"] });
  expect(chatState()).toMatchObject({ draft: "", files: [], mentions: [] });
  expect(chatMessages("/notes/a.md")[0]).toMatchObject({ mentions: [mention] });
  expect(await sending).toBe(false);
  expect(chatState()).toMatchObject({
    draft: "match @Style",
    files: ["/notes/style.md"],
    mentions: [mention],
  });
});
test("attached feedback leaves the composer on send and returns only if delivery fails", async () => {
  const start = deferred<string>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start" ? start.promise : defaultInvoke(command, args),
  );
  const feedback = useFeedbackStore.getState();
  const attached = () => useFeedbackStore.getState().byPath["/notes/a.md"] ?? [];
  const [target] = feedbackTargets("Original");
  feedback.attach("/notes/a.md", target!);
  const ids = attached().map((item) => item.id);
  const sending = send("Cut this", {
    attachments: [{ anchor: target!, quote: null }],
    feedbackIds: ids,
  });
  expect(attached()).toEqual([]);
  expect(chatMessages("/notes/a.md")[0]).toMatchObject({ text: "Cut this" });
  start.reject(new Error("Startup failed"));
  expect(await sending).toBe(false);
  expect(attached().map((item) => [item.id, item.status])).toEqual([[ids[0], "attached"]]);

  mockedInvoke.mockImplementation(defaultInvoke);
  expect(await send("Again", { feedbackIds: ids })).toBe(true);
  expect(attached()).toEqual([]);
});
test("save failure does not start Claude or discard the dirty buffer", async () => {
  mockedInvoke.mockImplementation((command, args) =>
    command === "write_file"
      ? Promise.reject(new Error("Disk full"))
      : defaultInvoke(command, args),
  );
  useEditorStore.getState().updateContent("/notes/a.md", "Unsaved");
  expect(await send("Edit")).toBe(false);
  expect(mockedInvoke.mock.calls.some(([command]) => command === "claude_start")).toBe(false);
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Unsaved");
  expect(isAgentTurnActive()).toBe(false);
});
test("failed Stop keeps process ownership and lock until termination retry succeeds", async () => {
  await send("Edit");
  let failures = 1;
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_stop" && failures-- > 0
      ? Promise.reject(new Error("IPC failure"))
      : defaultInvoke(command, args),
  );
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(isAgentTurnActive()).toBe(true);
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(isAgentTurnActive()).toBe(false);
  const stops = mockedInvoke.mock.calls.filter(([c]) => c === "agent_stop");
  expect(stops).toHaveLength(2);
  expect(stops[0][1]).toEqual(stops[1][1]);
});
test("Stop waits for deferred startup despite a duplicate Send and retries failed teardown", async () => {
  const start = deferred<string>();
  let failures = 1;
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start"
      ? start.promise
      : command === "agent_stop" && failures-- > 0
        ? Promise.reject(new Error("IPC failure"))
        : defaultInvoke(command, args),
  );
  const sending = send("Edit");
  await tick();
  expect(await send("Duplicate")).toBe(false);
  const stop = useClaudeStore.getState().stop("/notes/a.md");
  expect(isAgentTurnActive()).toBe(true);
  start.resolve("late-process");
  await sending;
  await stop;
  expect(isAgentTurnActive()).toBe(true);
  expect(mockedInvoke.mock.calls.some(([c]) => c === "agent_send")).toBe(false);
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(isAgentTurnActive()).toBe(false);
});
test("old process callbacks cannot finish a newer turn", async () => {
  await send("First");
  const old = channels[0];
  await useClaudeStore.getState().stop("/notes/a.md");
  await send("Second");
  old.onmessage({ type: "started", processId: "obsolete-process" });
  old.onmessage({ type: "exit", code: 0 });
  emit({ type: "result", is_error: false }, old);
  await tick();
  expect(chatState().status).toBe("running");
  expect(isAgentTurnActive()).toBe(true);
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(mockedInvoke.mock.calls.filter(([c]) => c === "agent_stop").at(-1)?.[1]).toEqual({
    processId: "process-2",
  });
});
test.each(["before Stop", "after Stop"])(
  "Stop cancels MCP initialization when ownership arrives %s",
  async (timing) => {
    const start = deferred<string>();
    mockedInvoke.mockImplementation((command, args) => {
      if (command === "claude_start") return start.promise;
      if (command === "agent_stop") start.reject(new Error("Startup canceled"));
      return defaultInvoke(command, args);
    });
    const sending = send("Edit");
    await tick();
    const started = () => channels[0].onmessage({ type: "started", processId: "starting-process" });
    const message = chatMessages("/notes/a.md")[0];
    if (timing === "before Stop") started();
    const stopping = useClaudeStore.getState().stop("/notes/a.md");
    if (timing === "after Stop") started();
    await stopping;
    expect(await sending).toBe(false);
    expect(isAgentTurnActive()).toBe(false);
    expect(chatState().error).toBeNull();
    expect(chatMessages("/notes/a.md")).toEqual([message]);
    expect(mockedInvoke.mock.calls.filter(([c]) => c === "agent_stop")).toEqual([
      ["agent_stop", { processId: "starting-process" }],
    ]);
    expect(mockedInvoke.mock.calls.some(([c]) => c === "agent_send")).toBe(false);
  },
);
test("failed startup cancellation retains ownership for an immediate Stop retry", async () => {
  const start = deferred<string>();
  let failures = 1;
  mockedInvoke.mockImplementation((command, args) => {
    if (command === "claude_start") return start.promise;
    if (command === "agent_stop") {
      if (failures-- > 0) return Promise.reject(new Error("IPC failure"));
      start.reject(new Error("Startup canceled"));
    }
    return defaultInvoke(command, args);
  });
  const sending = send("Edit");
  await tick();
  const stopping = useClaudeStore.getState().stop("/notes/a.md");
  channels[0].onmessage({ type: "started", processId: "starting-process" });
  await stopping;
  expect(isAgentTurnActive()).toBe(true);
  expect(chatState().error).toContain("Could not stop");
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(await sending).toBe(false);
  expect(isAgentTurnActive()).toBe(false);
  const stops = mockedInvoke.mock.calls.filter(([c]) => c === "agent_stop");
  expect(stops).toHaveLength(2);
  expect(stops[0][1]).toEqual(stops[1][1]);
});
test("deleting an open file reports deletion without leaving all notes locked", async () => {
  await send("Delete this note");
  await claudeEdits(() => disk.delete("/notes/a.md"));
  emit({ type: "result", is_error: false });
  await tick();
  expect(isAgentTurnActive()).toBe(false);
  expect(chatState().error).toContain("deleted on disk");
  expect(useEditorStore.getState().openFiles.has("/notes/a.md")).toBe(false);
});
test("a delayed navigation read for another note is independent of the target reload", async () => {
  await send("Edit A");
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
  expect(useEditorStore.getState().openFiles.get("/notes/b.md")?.content).toBe("Old B");
  expect(isAgentTurnActive()).toBe(false);
});

test("New chat stop failure rejects sends until termination is confirmed", async () => {
  await send("First");
  let failures = 1;
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_stop" && failures-- > 0
      ? Promise.reject(new Error("IPC failure"))
      : defaultInvoke(command, args),
  );
  await useClaudeStore.getState().newChat("/notes/a.md");
  expect(chatState().status).toBe("stopping");
  expect(await send("Unsafe reuse")).toBe(false);
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(chatState().status).toBe("idle");
  await send("Fresh");
  expect(channels).toHaveLength(2);
  await useClaudeStore.getState().stop("/notes/a.md");
});
test("a rejected navigation read for another note cannot affect the running note", async () => {
  await send("Edit A");
  mockedInvoke.mockImplementation((command, args) =>
    command === "read_file" && (args as { path: string }).path === "/notes/b.md"
      ? Promise.reject(new Error("Cannot read B"))
      : defaultInvoke(command, args),
  );
  await expect(useEditorStore.getState().openFileInNewTab("/notes/b.md")).rejects.toThrow(
    "Failed to open",
  );
  expect(isAgentTurnActive("/notes/a.md")).toBe(true);
  expect(chatState().status).toBe("running");
  await claudeEdits(() => disk.set("/notes/a.md", "Revised A"));
  emit({ type: "result", is_error: false });
  await tick();
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Revised A");
});

test("malformed protocol data stops the process and preserves the visible error", async () => {
  await send("Edit");
  channels[channels.length - 1].onmessage({ type: "line", line: "invalid JSON" });
  await tick();
  expect(isAgentTurnActive()).toBe(false);
  expect(chatState().error).toContain("Invalid Claude Code stream:");
  expect(mockedInvoke.mock.calls.some(([command]) => command === "agent_stop")).toBe(true);
});

test("CLI warnings remain inspectable after success without becoming turn errors", async () => {
  await send("Hello");
  const channel = channels[channels.length - 1];
  const warning = "Warning: claude.ai MCP servers blocked by enterprise policy: example";
  channel.onmessage({ type: "stderr", message: warning });
  channel.onmessage({ type: "stderr", message: warning });
  expect(chatState().error).toBeNull();
  expect(chatState().status).toBe("running");
  emit({ type: "result", is_error: false });
  await tick();
  const firstTurn = chatState().messages[0].id;
  expect(chatState().notices).toEqual([{ afterId: firstTurn, text: warning }]);
  expect(chatState().error).toBeNull();
  expect(isAgentTurnActive()).toBe(false);
  await send("Second");
  channels[channels.length - 1].onmessage({ type: "stderr", message: warning });
  expect(chatState().notices).toEqual([{ afterId: firstTurn, text: warning }]);
  emit({ type: "result", is_error: true, errors: ["Actual turn failure"] });
  await tick();
  expect(chatState().error).toBe("Actual turn failure");
  expect(chatState().notices).toHaveLength(1);
  await useClaudeStore.getState().newChat("/notes/a.md");
  expect(chatState().notices).toEqual([]);
  channel.onmessage({ type: "stderr", message: "Stale notice" });
  expect(chatState().notices).toEqual([]);
});
test("CLI notices are bounded, anchored where they arrive, and cleared on workspace change", async () => {
  await send("First");
  const channel = channels[channels.length - 1];
  for (let i = 0; i < 60; i++) channel.onmessage({ type: "stderr", message: `Notice ${i}` });
  expect(chatState().notices).toHaveLength(50);
  expect(chatState().notices[0].text).toBe("Notice 10");
  await useClaudeStore.getState().stop("/notes/a.md");
  await send("Restart");
  const restart = channels[channels.length - 1];
  const restartTurn = chatState().messages.at(-1)!.id;
  restart.onmessage({ type: "stderr", message: "Before reply" });
  emit({ type: "assistant", message: { id: "reply", content: [{ type: "text", text: "Hi" }] } });
  restart.onmessage({ type: "stderr", message: "After reply" });
  expect(chatState().notices.slice(-2)).toEqual([
    { afterId: restartTurn, text: "Before reply" },
    { afterId: "reply", text: "After reply" },
  ]);
  useWorkspaceStore.setState((s) => ({ workspaceGeneration: s.workspaceGeneration + 1 }));
  expect(chatState().notices).toEqual([]);
});

function requestPermission(
  id: string,
  tool = "Read",
  input = { query: "A writer's notes", limit: 3 } as Record<string, unknown>,
) {
  emit({
    type: "control_request",
    request_id: id,
    request: {
      subtype: "can_use_tool",
      tool_name: tool,
      input,
    },
  });
}
function sentDecisions() {
  return mockedInvoke.mock.calls
    .filter(([command]) => command === "agent_decide_permission")
    .map(([, payload]) => payload);
}
test.each([
  { tool: "Read", input: { file_path: "/notes/context.md" } },
  { tool: "mcp__notes__search", input: { query: "A writer's notes", limit: 3 } },
  { tool: "WebSearch", input: { query: "IANA example domains", allowed_domains: ["iana.org"] } },
  { tool: "WebFetch", input: { url: "https://example.com", prompt: "Summarize the page." } },
])(
  "queues %s approvals and sends allow/deny once without persisting rules",
  async ({ tool, input }) => {
    await send("Search");
    requestPermission("first", tool, input);
    requestPermission("second", tool, input);
    requestPermission("first", tool, input);
    expect(chatState().permissions.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(chatState().permissions[0]).toMatchObject({
      tool,
      input,
    });
    expect(useSettingsStore.getState().settings["appearance.agent-panel-visible"]).toBe(true);
    expect(isAgentTurnActive()).toBe(true);
    const approving = useClaudeStore.getState().decidePermission("/notes/a.md", "first", true);
    await useClaudeStore.getState().decidePermission("/notes/a.md", "first", false);
    await approving;
    await useClaudeStore.getState().decidePermission("/notes/a.md", "second", false);
    expect(sentDecisions()).toEqual([
      { processId: "process-1", requestId: "first", allow: true, always: false },
      { processId: "process-1", requestId: "second", allow: false, always: false },
    ]);
    expect(chatState().permissions).toEqual([]);
    expect(chatState().status).toBe("running");
    emit({ type: "result", is_error: false });
    await tick();
  },
);
test("reports the window's pending approval count for the Dock badge only when it changes", async () => {
  const reported = () =>
    mockedInvoke.mock.calls
      .filter(([command]) => command === "set_pending_approvals")
      .map(([, payload]) => (payload as { count: number }).count);
  await send("Search");
  requestPermission("first");
  requestPermission("second");
  emit({ type: "assistant", message: { id: "reply", content: [{ type: "text", text: "Hi" }] } });
  expect(reported()).toEqual([1, 2]);
  await useClaudeStore.getState().decidePermission("/notes/a.md", "first", true);
  emit({ type: "control_cancel_request", request_id: "second" });
  expect(reported()).toEqual([1, 2, 1, 0]);
});
test("Claude's questions wait for answers, keep a failed reply for retry and show the answers in the thread", async () => {
  const answers = () =>
    mockedInvoke.mock.calls
      .filter(([command]) => command === "agent_answer")
      .map(([, payload]) => payload);
  const questions = [
    { question: "Which tone?", header: "Tone", multiSelect: false, options: [] },
    { question: "Which length?", header: "Length", multiSelect: false, options: [] },
  ];
  await send("Rewrite it");
  emit({
    type: "assistant",
    message: {
      id: "ask",
      content: [
        { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: { questions } },
      ],
    },
  });
  requestPermission("ask", "AskUserQuestion", { questions });
  expect(chatState().permissions.map((entry) => entry.tool)).toEqual(["AskUserQuestion"]);
  const reply = { "Which tone?": "Warm", "Which length?": "Short" };
  mockedInvoke.mockImplementationOnce(async () => {
    throw new Error("Claude Code exited");
  });
  await useClaudeStore
    .getState()
    .answer("/notes/a.md", "ask", { kind: "questions", answers: reply });
  expect(chatState().permissions[0]).toMatchObject({
    pending: false,
    error: "Could not send your reply: Claude Code exited",
  });
  await useClaudeStore
    .getState()
    .answer("/notes/a.md", "ask", { kind: "questions", answers: reply });
  expect(answers().at(-1)).toEqual({
    processId: "process-1",
    requestId: "ask",
    answer: { kind: "questions", answers: reply },
  });
  expect(sentDecisions()).toEqual([]);
  expect(chatState().permissions).toEqual([]);
  emit({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_ask" }] },
    tool_use_result: { questions, answers: reply },
  });
  expect(chatState().messages.at(-1)!.tools[0]).toMatchObject({
    done: true,
    questions: [
      { question: "Which tone?", answer: "Warm" },
      { question: "Which length?", answer: "Short" },
    ],
  });
  emit({ type: "result", is_error: false });
  await tick();
});
test("plan mode starts the turn in plan mode, and approving the plan turns it off", async () => {
  const starts = () =>
    mockedInvoke.mock.calls
      .filter(([command]) => command === "claude_start")
      .map(([, payload]) => (payload as { plan: boolean }).plan);
  useClaudeStore.getState().setPlanMode("/notes/a.md", true);
  await send("Restructure it");
  expect(starts()).toEqual([true]);
  const input = { plan: "1. Merge the intro", planFilePath: "/home/.claude/plans/a.md" };
  emit({
    type: "assistant",
    message: {
      id: "plan",
      content: [{ type: "tool_use", id: "toolu_plan", name: "ExitPlanMode", input }],
    },
  });
  expect(chatState().messages.at(-1)!.tools[0]).toMatchObject({ plan: "1. Merge the intro" });
  requestPermission("plan", "ExitPlanMode", input);
  await useClaudeStore
    .getState()
    .answer("/notes/a.md", "plan", { kind: "plan", approve: false, feedback: "Keep the intro" });
  expect(chatState().planMode).toBe(true);
  requestPermission("plan-2", "ExitPlanMode", input);
  await useClaudeStore
    .getState()
    .answer("/notes/a.md", "plan-2", { kind: "plan", approve: true, feedback: null });
  expect(
    mockedInvoke.mock.calls
      .filter(([command]) => command === "agent_answer")
      .map(([, payload]) => (payload as { answer: unknown }).answer),
  ).toEqual([
    { kind: "plan", approve: false, feedback: "Keep the intro" },
    { kind: "plan", approve: true, feedback: null },
  ]);
  expect(chatState().planMode).toBe(false);
  expect(chatState().permissions).toEqual([]);
  emit({ type: "result", is_error: false });
  await tick();
  await send("Now tighten it");
  expect(starts()).toEqual([true, false]);
  emit({ type: "result", is_error: false });
  await tick();
});
test("canceling an approval invalidates its in-flight completion without losing another request", async () => {
  await send("Search");
  requestPermission("first");
  requestPermission("second");
  const delivery = deferred<null>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_decide_permission" ? delivery.promise : defaultInvoke(command, args),
  );
  const approving = useClaudeStore.getState().decidePermission("/notes/a.md", "first", true);
  emit({ type: "control_cancel_request", request_id: "first" });
  expect(chatState().permissions.map((entry) => entry.id)).toEqual(["second"]);
  delivery.reject(new Error("Canceled write"));
  await approving;
  expect(chatState().permissions[0].error).toBeUndefined();
  await useClaudeStore.getState().decidePermission("/notes/a.md", "first", true);
  expect(sentDecisions()).toHaveLength(1);
  emit({ type: "result", is_error: false });
  await tick();
});
test("always allowing a tool approves its queued requests in every chat", async () => {
  await send("Search");
  const [a] = channels;
  disk.set("/notes/b.md", "B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  await send("Search B");
  const b = channels[channels.length - 1];
  const ask = (id: string, channel: typeof a, tool = "Read") =>
    emit(
      {
        type: "control_request",
        request_id: id,
        request: { subtype: "can_use_tool", tool_name: tool, input: { file_path: "/x.md" } },
      },
      channel,
    );
  ask("first", a);
  ask("second", a, "Grep");
  ask("third", a);
  ask("other", b);
  await useClaudeStore.getState().decidePermission("/notes/a.md", "first", true, true);
  expect(sentDecisions()).toEqual([
    { processId: "process-1", requestId: "first", allow: true, always: true },
    { processId: "process-1", requestId: "third", allow: true, always: false },
    { processId: "process-2", requestId: "other", allow: true, always: false },
  ]);
  expect(chatState().permissions.map((entry) => entry.id)).toEqual(["second"]);
  expect(chatState("/notes/b.md").permissions).toEqual([]);
  const startPayload = mockedInvoke.mock.calls.find(([command]) => command === "claude_start")![1];
  expect(startPayload).not.toHaveProperty("alwaysAllow");
});
test("decision transport errors retain a retryable request and the editor lock", async () => {
  await send("Search");
  requestPermission("request");
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_decide_permission"
      ? Promise.reject(new Error("Pipe unavailable"))
      : defaultInvoke(command, args),
  );
  await useClaudeStore.getState().decidePermission("/notes/a.md", "request", true);
  expect(chatState().permissions[0]).toMatchObject({
    pending: false,
    error: expect.stringContaining("Pipe unavailable"),
  });
  expect(isAgentTurnActive()).toBe(true);
  mockedInvoke.mockImplementation(defaultInvoke);
  await useClaudeStore.getState().decidePermission("/notes/a.md", "request", false);
  expect(chatState().permissions).toEqual([]);
  emit({ type: "result", is_error: false });
  await tick();
});
test("Stop removes approvals immediately and ignores late decisions and old requests", async () => {
  await send("Search");
  requestPermission("request");
  const delivery = deferred<null>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_decide_permission" ? delivery.promise : defaultInvoke(command, args),
  );
  const approving = useClaudeStore.getState().decidePermission("/notes/a.md", "request", true);
  const oldChannel = channels.at(-1)!;
  const stopping = useClaudeStore.getState().stop("/notes/a.md");
  expect(chatState().permissions).toEqual([]);
  delivery.reject(new Error("Stopped"));
  await approving;
  await stopping;
  expect(chatState().error).toBeNull();
  mockedInvoke.mockImplementation(defaultInvoke);
  await send("New turn");
  emit(
    {
      type: "control_request",
      request_id: "old",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "old" } },
    },
    oldChannel,
  );
  expect(chatState().permissions).toEqual([]);
  emit({ type: "result", is_error: false });
  await tick();
});
test.each(["result", "exit", "workspace"])("%s clears pending approvals", async (boundary) => {
  await send("Search");
  requestPermission("request");
  if (boundary === "result") emit({ type: "result", is_error: false });
  else if (boundary === "exit") channels.at(-1)!.onmessage({ type: "exit", code: 0 });
  else
    useWorkspaceStore.setState((state) => ({ workspaceGeneration: state.workspaceGeneration + 1 }));
  await tick();
  expect(chatState().permissions).toEqual([]);
  await useClaudeStore.getState().decidePermission("/notes/a.md", "request", true);
  expect(sentDecisions()).toEqual([]);
});
test("unexpected interactive requests terminate with a visible protocol error", async () => {
  await send("Search");
  emit({ type: "control_request", request_id: "unsupported", request: { subtype: "elicitation" } });
  await tick();
  expect(chatState().error).toContain("Unsupported interactive request");
  expect(isAgentTurnActive()).toBe(false);
  expect(sentDecisions()).toEqual([]);
});

test("terminal reconciliation rejects late approvals and completed IDs cannot be answered twice", async () => {
  await send("Search");
  requestPermission("done");
  await useClaudeStore.getState().decidePermission("/notes/a.md", "done", true);
  requestPermission("done");
  expect(chatState().permissions).toEqual([]);
  const reload = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "read_file" ? reload.promise : defaultInvoke(command, args),
  );
  emit({ type: "result", is_error: false });
  requestPermission("late");
  expect(chatState().status).toBe("stopping");
  expect(chatState().permissions).toEqual([]);
  await tick();
  expect(sentDecisions()).toHaveLength(1);
  reload.resolve({ path: "/notes/a.md", content: "Original", modified_at: 1 });
  await tick();
});
test("protocol failures keep recovery locked when native Stop fails", async () => {
  await send("Search");
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_stop"
      ? Promise.reject(new Error("IPC unavailable"))
      : defaultInvoke(command, args),
  );
  emit({ type: "control_request", request_id: "bad", request: { subtype: "elicitation" } });
  await tick();
  expect(isAgentTurnActive()).toBe(true);
  expect(chatState().error).toContain("IPC unavailable");
  mockedInvoke.mockImplementation(defaultInvoke);
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(isAgentTurnActive()).toBe(false);
  expect(chatState().error).toContain("Unsupported interactive request");
});

test("exposes thinking immediately, streams answers before result and preserves multiple text blocks", async () => {
  const sending = send("Explain");
  expect(chatState().activity).toBe("thinking");
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
  expect(chatState().activity).toBe("thinking");
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
  expect(chatState().activity).toBe("responding");
  expect(chatMessages("/notes/a.md").at(-1)?.text).toBe("First answer.");
  expect(chatState().status).toBe("running");
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
  expect(chatState().activity).toBeNull();
});

test("tool progress returns to thinking and approval does not erase activity", async () => {
  await send("Read");
  emit({ type: "stream_event", event: { type: "message_start", message: { id: "tool" } } });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "read", name: "Read" },
    },
  });
  expect(chatState().activity).toBe("working");
  requestPermission("read");
  expect(chatState().permissions).toHaveLength(1);
  await useClaudeStore.getState().decidePermission("/notes/a.md", "read", true);
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read" }] } });
  expect(chatState().activity).toBe("thinking");
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(chatState().activity).toBeNull();
});

test.each(["stop", "error", "workspace"])(
  "%s ends thinking while preserving partial answers where applicable",
  async (boundary) => {
    await send("Explain");
    emit({ type: "stream_event", event: { type: "message_start", message: { id: "reply" } } });
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "A partial answer" },
      },
    });
    if (boundary === "stop") await useClaudeStore.getState().stop("/notes/a.md");
    else if (boundary === "error")
      emit({ type: "result", is_error: true, errors: ["Disconnected"] });
    else
      useWorkspaceStore.setState((state) => ({
        workspaceGeneration: state.workspaceGeneration + 1,
      }));
    await tick();
    expect(chatState().activity).toBeNull();
    if (boundary !== "workspace")
      expect(chatMessages("/notes/a.md").at(-1)?.text).toBe("A partial answer");
  },
);

test("abandoned tools from a stopped turn do not suppress thinking after later tools finish", async () => {
  await send("First");
  emit({ type: "stream_event", event: { type: "message_start", message: { id: "old" } } });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "old-tool", name: "Read" },
    },
  });
  await useClaudeStore.getState().stop("/notes/a.md");
  await send("Second");
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
  expect(chatState().activity).toBe("thinking");
  emit({ type: "result", is_error: false });
  await tick();
});

test.each(["new-chat", "exit", "malformed", "send-failure"])(
  "%s clears activity",
  async (boundary) => {
    if (boundary === "send-failure")
      mockedInvoke.mockImplementation((command, args) =>
        command === "agent_send"
          ? Promise.reject(new Error("Delivery failed"))
          : defaultInvoke(command, args),
      );
    await send("Explain");
    if (boundary === "new-chat") await useClaudeStore.getState().newChat("/notes/a.md");
    else if (boundary === "exit") channels.at(-1)!.onmessage({ type: "exit", code: 1 });
    else if (boundary === "malformed")
      channels.at(-1)!.onmessage({ type: "line", line: "not JSON" });
    await tick();
    expect(chatState().activity).toBeNull();
    expect(chatState().status).not.toBe("running");
  },
);

test("each note keeps its own conversation and resumes its own session", async () => {
  const starts = () =>
    mockedInvoke.mock.calls
      .filter(([command]) => command === "claude_start")
      .map(([, payload]) => (payload as { resumeSessionId: string | null }).resumeSessionId);
  await send("About A");
  emit({ type: "system", subtype: "init", session_id: "session-a" });
  emit({ type: "result", is_error: false });
  await tick();
  disk.set("/notes/b.md", "Before B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  await send("About B");
  emit({ type: "system", subtype: "init", session_id: "session-b" });
  emit({ type: "result", is_error: false });
  await tick();
  expect(chatMessages("/notes/a.md").map((message) => message.text)).toEqual(["About A"]);
  expect(chatMessages("/notes/b.md").map((message) => message.text)).toEqual(["About B"]);
  useEditorStore.getState().setActiveFile("/notes/a.md");
  await send("Back to A");
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

function requestNoteWrite(id: string, path: string, exists: boolean, channel = channels.at(-1)) {
  emit(
    {
      type: "control_request",
      request_id: id,
      request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: path } },
      writer_target: { path, exists },
    },
    channel,
  );
}
const editReplies = () =>
  mockedInvoke.mock.calls.filter(([command]) => command === "agent_edit_ready").map(([, p]) => p);
test("an edit to another note saves and locks it only while applied, then reloads it", async () => {
  disk.set("/notes/b.md", "Before B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  useEditorStore.getState().updateContent("/notes/b.md", "Unsaved B");
  useEditorStore.getState().setActiveFile("/notes/a.md");
  await send("Update B");
  requestNoteWrite("b", "/notes/b.md", true);
  expect(chatState().permissions[0].target).toEqual({ path: "/notes/b.md", exists: true });
  await useClaudeStore.getState().decidePermission("/notes/a.md", "b", true);
  expect(isAgentEditing("/notes/b.md")).toBe(false);
  const meanwhile: Promise<boolean>[] = [];
  await claudeEdits(
    () => {
      expect(isAgentEditing("/notes/b.md")).toBe(true);
      expect(isAgentEditing("/notes/a.md")).toBe(false);
      expect(disk.get("/notes/b.md")).toBe("Unsaved B");
      meanwhile.push(useClaudeStore.getState().send("/notes/b.md", "Meanwhile"));
      disk.set("/notes/b.md", "Revised B");
    },
    channels.at(-1),
    "/notes/b.md",
  );
  expect(await Promise.all(meanwhile)).toEqual([false]);
  expect(chatState("/notes/b.md").error).toBe("Another chat is editing this note.");
  expect(editReplies()).toEqual([{ processId: "process-1", requestId: "edit-1", allow: true }]);
  expect(useEditorStore.getState().openFiles.get("/notes/b.md")?.content).toBe("Revised B");
  expect(isAgentEditing()).toBe(false);
  emit({ type: "result", is_error: false });
  await tick();
  expect(chatState()).toMatchObject({ status: "idle", error: null });
  expect(disk.get("/notes/a.md")).toBe("Original");
});
test("an approved new note that was never written finishes cleanly", async () => {
  await send("Create notes");
  await claudeEdits(
    () => expect(isAgentEditing("/notes/new.md")).toBe(true),
    channels.at(-1),
    "/notes/new.md",
  );
  expect(isAgentEditing()).toBe(false);
  emit({ type: "result", is_error: false });
  await tick();
  expect(chatState()).toMatchObject({ status: "idle", error: null });
});
test("the workspace chat starts without a note", async () => {
  useEditorStore.getState().openNewTab();
  mockedInvoke.mockClear();
  expect(await useClaudeStore.getState().send(WORKSPACE_CHAT, "Draft a note")).toBe(true);
  const start = mockedInvoke.mock.calls.find(([c]) => c === "claude_start")![1] as {
    notePath: string | null;
  };
  expect(start.notePath).toBeNull();
  const payload = mockedInvoke.mock.calls.find(([c]) => c === "agent_send")![1] as {
    content: string;
  };
  expect(payload.content).not.toContain("openFile");
  expect(mockedInvoke.mock.calls.some(([c]) => c === "read_file")).toBe(false);
});
test("a note the workspace chat creates takes over the conversation and the launcher", async () => {
  useEditorStore.getState().openNewTab();
  const launcher = useEditorStore.getState().activeTabId;
  await useClaudeStore.getState().send(WORKSPACE_CHAT, "Draft a note");
  emit({ type: "system", subtype: "init", session_id: "session-w" });
  await claudeEdits(() => disk.set("/notes/new.md", "Draft"), channels.at(-1), "/notes/new.md");
  emit({ type: "result", is_error: false });
  await tick();
  expect(useClaudeStore.getState().chats[WORKSPACE_CHAT]).toBeUndefined();
  expect(chatMessages("/notes/new.md")[0]).toMatchObject({ role: "user", text: "Draft a note" });
  const tab = useEditorStore.getState().tabs.find((entry) => entry.id === launcher);
  expect(tab?.location).toMatchObject({ kind: "file", path: "/notes/new.md" });
  expect(useEditorStore.getState().activeFilePath).toBe("/notes/new.md");
  const saved = new Map(savedChats());
  expect(saved.get(`/notes\0${WORKSPACE_CHAT}`)).toBeUndefined();
  expect(saved.get("/notes\0/notes/new.md")).toMatchObject({
    session: { id: "session-w", agent: "claude-code" },
  });
});
test("the workspace chat stays put after editing an existing note", async () => {
  useEditorStore.getState().openNewTab();
  await useClaudeStore.getState().send(WORKSPACE_CHAT, "Tidy A");
  await claudeEdits(() => disk.set("/notes/a.md", "Tidied"));
  emit({ type: "result", is_error: false });
  await tick();
  expect(chatMessages(WORKSPACE_CHAT)).toHaveLength(1);
  expect(useEditorStore.getState().activeFilePath).toBeNull();
});
test("a created note doesn't take the tab when the writer has moved to another note", async () => {
  useEditorStore.getState().openNewTab();
  await useClaudeStore.getState().send(WORKSPACE_CHAT, "Draft a note");
  useEditorStore.getState().setActiveFile("/notes/a.md");
  await claudeEdits(() => disk.set("/notes/new.md", "Draft"), channels.at(-1), "/notes/new.md");
  emit({ type: "result", is_error: false });
  await tick();
  expect(chatMessages("/notes/new.md")).toHaveLength(1);
  expect(useEditorStore.getState().activeFilePath).toBe("/notes/a.md");
  expect(useEditorStore.getState().openFiles.has("/notes/new.md")).toBe(false);
});
test("a note another chat is working on can't be edited", async () => {
  disk.set("/notes/b.md", "Before B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  await send("About B");
  useEditorStore.getState().setActiveFile("/notes/a.md");
  await send("Update B");
  await startEdit(channels[1], "/notes/b.md");
  expect(editReplies()).toEqual([{ processId: "process-2", requestId: "edit-1", allow: false }]);
  expect(chatState().notices.at(-1)?.text).toContain("Another chat is editing b.md.");
  expect(isAgentEditing()).toBe(false);
});

test("captured feedback path is independent of the active tab and survives tab closure", async () => {
  disk.set("/notes/b.md", "Before B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  const complete = vi.fn();
  const prepare = vi.fn((content: string) => `Feedback for A: ${content}`);
  expect(
    await useClaudeStore
      .getState()
      .send("/notes/a.md", "Feedback", { turn: { path: "/notes/a.md", prepare, complete } }),
  ).toBe(true);
  const payload = mockedInvoke.mock.calls.filter(([c]) => c === "agent_send").at(-1)![1] as {
    content: string;
  };
  expect(payload.content).toContain('openFile":"/notes/a.md');
  expect(payload.content).toContain("Feedback for A:");
  useEditorStore.getState().closeFile("/notes/a.md");
  await claudeEdits(() => disk.set("/notes/a.md", "Revised A"));
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

test("successive feedback turns settle their own request; unrelated changes are no-op", async () => {
  const first = vi.fn(),
    second = vi.fn();
  await useClaudeStore.getState().send("/notes/a.md", "First", {
    turn: { path: "/notes/a.md", prepare: () => "First", complete: first },
  });
  emit({ type: "result", is_error: false });
  await tick();
  expect(first).toHaveBeenCalledExactlyOnceWith({
    status: "completed",
    changed: false,
    error: null,
  });
  await useClaudeStore.getState().send("/notes/a.md", "Second", {
    turn: { path: "/notes/a.md", prepare: () => "Second", complete: second },
  });
  await claudeEdits(() => disk.set("/notes/a.md", "Revised"));
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
  const send = useClaudeStore.getState().send("/notes/a.md", "Feedback", {
    turn: { path: "/notes/a.md", prepare: () => prepare.promise, complete },
  });
  expect(chatMessages("/notes/a.md")[0]?.text).toBe("Feedback");
  await tick();
  const stop = useClaudeStore.getState().stop("/notes/a.md");
  prepare.resolve("Prepared");
  await Promise.all([send, stop]);
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    status: "cancelled",
    changed: false,
    error: null,
  });
  expect(mockedInvoke.mock.calls.some(([command]) => command === "agent_send")).toBe(false);
});

test("partial changes survive failed Stop and require cancelled completion after termination retry", async () => {
  const complete = vi.fn();
  await useClaudeStore.getState().send("/notes/a.md", "Feedback", {
    turn: { path: "/notes/a.md", prepare: () => "Prepared", complete },
  });
  await startEdit();
  disk.set("/notes/a.md", "Partly revised");
  let failures = 1;
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_stop" && failures-- > 0
      ? Promise.reject(new Error("IPC failure"))
      : defaultInvoke(command, args),
  );
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(complete).not.toHaveBeenCalled();
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    status: "cancelled",
    changed: true,
    error: null,
  });
});

test("reconciliation failure cannot resolve feedback; retry settles only after reload", async () => {
  const complete = vi.fn();
  await useClaudeStore.getState().send("/notes/a.md", "Feedback", {
    turn: { path: "/notes/a.md", prepare: () => "Prepared", complete },
  });
  await startEdit();
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
  expect(isAgentTurnActive()).toBe(true);
  await useClaudeStore.getState().stop("/notes/a.md");
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
      .send("/notes/a.md", "Feedback", { turn: { path: "/notes/a.md", prepare, complete } }),
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
    expect(await send("Feedback")).toBe(false);
  } finally {
    release();
  }
  await send("Feedback");
  expect(() => beginPathMutation()).toThrow("AI to finish");
  await useClaudeStore.getState().stop("/notes/a.md");
});

test("deleted captured feedback file is a terminal failure and releases its note lock", async () => {
  const complete = vi.fn();
  await useClaudeStore.getState().send("/notes/a.md", "Feedback", {
    turn: { path: "/notes/a.md", prepare: () => "Prepared", complete },
  });
  await claudeEdits(() => disk.delete("/notes/a.md"));
  emit({ type: "result", is_error: false });
  await tick();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]![0]).toMatchObject({ status: "failed", changed: true });
  expect(isAgentTurnActive()).toBe(false);
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

test("applying one note resolves only that note after closed-file reconciliation, then sends the rest", async () => {
  disk.set("/notes/a.md", "Original\n\nSecond");
  useEditorStore.getState().reloadFromDisk("/notes/a.md", disk.get("/notes/a.md")!);
  const first = createFeedback("Original\n\nSecond");
  createFeedback("Original\n\nSecond", 1);
  disk.set("/notes/b.md", "Other");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  await applyFeedback("/notes/a.md", [first]);
  expect(feedbackItems().map((x) => x.status)).toEqual(["running", "pending"]);
  useEditorStore.getState().closeFile("/notes/a.md");
  await claudeEdits(() => disk.set("/notes/a.md", "Revised\n\nSecond"));
  emit({ type: "result", is_error: false });
  await tick();
  expect(feedbackItems().map((x) => x.status)).toEqual(["running"]);
  expect(feedbackItems()[0]!.anchor?.attached).toBe(true);
  expect(channels).toHaveLength(2);
});

test("real batch does not resolve when the feedback reconciliation read fails", async () => {
  const id = createFeedback("Original");
  await applyFeedback("/notes/a.md", [id]);
  await startEdit();
  disk.set("/notes/a.md", "Revised");
  let reads = 0;
  mockedInvoke.mockImplementation((command, args) =>
    command === "read_file" && ++reads === 2
      ? Promise.reject(new Error("Feedback reconciliation failed"))
      : defaultInvoke(command, args),
  );
  emit({ type: "result", is_error: false });
  await tick();
  expect(reads).toBe(2);
  expect(feedbackItems()[0]!.status).toBe("running");
  expect(isAgentTurnActive()).toBe(true);
  expect(chatState().error).toContain("Feedback reconciliation failed");
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(feedbackItems()[0]).toMatchObject({ status: "pending", reviewRequired: true });
  expect(isAgentTurnActive()).toBe(false);
});

test("a clean finish clears the queue even without changes; Stop pauses it", async () => {
  const noop = createFeedback("Original");
  await applyFeedback("/notes/a.md", [noop]);
  emit({ type: "result", is_error: false });
  await tick();
  expect(feedbackItems()).toEqual([]);
  expect(useFeedbackStore.getState().turnErrors["/notes/a.md"] ?? null).toBeNull();
  const id = createFeedback("Original");
  await applyFeedback("/notes/a.md", [id]);
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(feedbackItems()[0]!.status).toBe("pending");
  expect(useFeedbackStore.getState().turnErrors["/notes/a.md"]).toContain("paused");
  await applyFeedback("/notes/a.md", [id]);
  expect(useFeedbackStore.getState().turnErrors["/notes/a.md"] ?? null).toBeNull();
  await claudeEdits(() => disk.set("/notes/a.md", "Revised"));
  emit({ type: "result", is_error: false });
  await tick();
  expect(feedbackItems()).toEqual([]);
  expect(useFeedbackStore.getState().turnErrors["/notes/a.md"] ?? null).toBeNull();
});

test("a clean turn sends everything queued during it as one merged turn", async () => {
  await send("First");
  useFeedbackStore.getState().saveNotes("/notes/a.md", "Then summarize it");
  useFeedbackStore.getState().saveNotes("/notes/a.md", "And add a title");
  createFeedback("Original");
  emit({ type: "result", is_error: false });
  await tick();
  expect(channels).toHaveLength(2);
  const sent = chatMessages("/notes/a.md").filter((message) => message.role === "user");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({
    text: "Then summarize it\n\nAnd add a title",
    attachments: [expect.objectContaining({ note: "Shorten the opening" })],
  });
  expect(feedbackItems().map((item) => item.status)).toEqual(["running", "running", "running"]);
  emit({ type: "result", is_error: false });
  await tick();
  expect(feedbackItems()).toEqual([]);
  expect(channels).toHaveLength(2);
});

test.each([
  ["Stop", () => useClaudeStore.getState().stop("/notes/a.md")],
  ["an error", () => emit({ type: "result", is_error: true, result: "Boom" })],
  ["an early exit", () => channels[0]!.onmessage({ type: "exit", code: 1 })],
] as const)("%s pauses the queue", async (_, end) => {
  await send("First");
  useFeedbackStore.getState().saveNotes("/notes/a.md", "Queued");
  await end();
  await tick();
  expect(channels).toHaveLength(1);
  expect(feedbackItems()[0]!.status).toBe("pending");
});

test("the drain skips notes that need review or re-pointing, and runs with the tab closed", async () => {
  const detached = createFeedback("Original");
  useFeedbackStore.getState().reconcile("/notes/a.md", null, "Rewritten");
  expect(feedbackItems()[0]!.anchor?.attached).toBe(false);
  await send("First");
  useFeedbackStore.getState().saveNotes("/notes/a.md", "Queued");
  useEditorStore.getState().closeFile("/notes/a.md");
  emit({ type: "result", is_error: false });
  await tick();
  expect(channels).toHaveLength(2);
  expect(feedbackItems().map((item) => [item.id === detached, item.status])).toEqual([
    [true, "pending"],
    [false, "running"],
  ]);
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
  await claudeEdits(() => disk.set("/notes/a.md", "Revised\n\nSecond"));
  emit({ type: "result", is_error: false });
  await tick();
  expect(feedbackItems().map((x) => x.id)).toEqual([second]);
  save.reject(new Error("Disk full"));
  await rejected;
  resumeFeedbackPersistence();
  expect(chatState().status).toBe("idle");
  expect(feedbackItems().map((x) => x.id)).toEqual([second]);
  vi.mocked(writePreferenceStrict).mockResolvedValue(undefined);
  await useFeedbackStore.getState().retryPersistence();
  await applyFeedback("/notes/a.md", [second]);
  expect(feedbackItems()[0]!.status).toBe("running");
  await useClaudeStore.getState().stop("/notes/a.md");
});

test("two notes interleave starts, streams and delivery acknowledgements independently", async () => {
  disk.set("/notes/b.md", "B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  const a = deferred<unknown>(),
    b = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_send"
      ? (args as { processId: string }).processId === "process-1"
        ? a.promise
        : b.promise
      : defaultInvoke(command, args),
  );
  const first = useClaudeStore.getState().send("/notes/a.md", "A prompt");
  await tick();
  const second = useClaudeStore.getState().send("/notes/b.md", "B prompt");
  await tick();
  expect(channels).toHaveLength(2);
  expect(isAgentTurnActive("/notes/a.md")).toBe(true);
  expect(isAgentTurnActive("/notes/b.md")).toBe(true);
  expect(await useClaudeStore.getState().send("/notes/a.md", "duplicate")).toBe(false);
  emit(
    { type: "stream_event", event: { type: "message_start", message: { id: "a" } } },
    channels[0],
  );
  emit(
    { type: "stream_event", event: { type: "message_start", message: { id: "b" } } },
    channels[1],
  );
  for (const [index, text] of [
    [0, "A answer"],
    [1, "B answer"],
  ] as const)
    emit(
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      },
      channels[index],
    );
  expect(chatMessages("/notes/a.md").at(-1)?.text).toBe("A answer");
  expect(chatMessages("/notes/b.md").at(-1)?.text).toBe("B answer");
  await claudeEdits(() => disk.set("/notes/a.md", "Revised A"), channels[0]);
  emit({ type: "result", is_error: false }, channels[0]);
  b.resolve(null);
  expect(await second).toBe(true);
  expect(chatState("/notes/a.md").status).toBe("stopping");
  expect(chatState("/notes/b.md").status).toBe("running");
  a.resolve(null);
  expect(await first).toBe(true);
  await tick();
  expect(isAgentTurnActive("/notes/a.md")).toBe(false);
  expect(isAgentTurnActive("/notes/b.md")).toBe(true);
  useEditorStore.getState().updateContent("/notes/a.md", "A manual edit");
  await tick();
  expect(disk.get("/notes/a.md")).toBe("A manual edit");
  await useClaudeStore.getState().stop("/notes/b.md");
});

test("background approvals do not open the panel or change notes and decisions stay scoped", async () => {
  await send("A");
  const channel = channels[0];
  disk.set("/notes/b.md", "B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  useSettingsStore.setState({ settings: { "appearance.agent-panel-visible": false } });
  emit(
    {
      type: "control_request",
      request_id: "read-a",
      request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: "/notes/b.md" } },
    },
    channel,
  );
  expect(chatState().permissions).toHaveLength(1);
  expect(chatState("/notes/b.md").permissions).toHaveLength(0);
  expect(useEditorStore.getState().activeFilePath).toBe("/notes/b.md");
  expect(useSettingsStore.getState().settings["appearance.agent-panel-visible"]).toBe(false);
  await useClaudeStore.getState().decidePermission("/notes/b.md", "read-a", true);
  expect(sentDecisions()).toHaveLength(0);
  await useClaudeStore.getState().decidePermission("/notes/a.md", "read-a", true);
  expect(sentDecisions()).toEqual([
    { processId: "process-1", requestId: "read-a", allow: true, always: false },
  ]);
  await useClaudeStore.getState().stopAll();
});

test("New chat reserves sends and moves throughout its asynchronous session reset", async () => {
  await reopenWithSavedChat({ sessionId: "session-a", messages: [] });
  const reset = deferred<void>();
  vi.mocked(writeStoreEntriesStrict).mockImplementation(() => reset.promise);
  const resetting = useClaudeStore.getState().newChat("/notes/a.md");
  expect(await send("Race")).toBe(false);
  expect(() => beginPathMutation()).toThrow("AI to finish");
  await tick();
  expect(chatState().status).toBe("stopping");
  reset.resolve();
  await resetting;
  expect(await send("Fresh")).toBe(true);
  await useClaudeStore.getState().stopAll();
});

test("session persistence failure recovers on retry without leaving the note locked forever", async () => {
  await send("A");
  vi.mocked(writeStoreEntriesStrict).mockRejectedValue(new Error("Disk full"));
  emit({ type: "system", subtype: "init", session_id: "session-a" });
  await tick();
  expect(isAgentTurnActive("/notes/a.md")).toBe(true);
  vi.mocked(writeStoreEntriesStrict).mockResolvedValue(undefined);
  await useClaudeStore.getState().stop("/notes/a.md");
  expect(isAgentTurnActive("/notes/a.md")).toBe(false);
  expect(chatState().error).toContain("Could not save chat session");
  expect(await send("Resume")).toBe(true);
  expect(
    mockedInvoke.mock.calls.filter(([command]) => command === "claude_start").at(-1)?.[1],
  ).toMatchObject({ resumeSessionId: "session-a" });
  await useClaudeStore.getState().stopAll();
});

test("stopAll retains only failed-note recovery and blocks new actions while draining", async () => {
  await send("A");
  disk.set("/notes/b.md", "B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  await send("B");
  const stop = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "agent_stop" && (args as { processId: string }).processId === "process-1"
      ? stop.promise
      : defaultInvoke(command, args),
  );
  const draining = useClaudeStore.getState().stopAll();
  const rejected = expect(draining).rejects.toThrow("Stop failed");
  expect(await send("Race")).toBe(false);
  await useClaudeStore.getState().newChat("/notes/b.md");
  stop.reject(new Error("Stop failed"));
  await rejected;
  expect(isAgentTurnActive("/notes/a.md")).toBe(true);
  expect(isAgentTurnActive("/notes/b.md")).toBe(false);
  mockedInvoke.mockImplementation(defaultInvoke);
  await useClaudeStore.getState().stopAll();
  expect(isAgentTurnActive()).toBe(false);
});

test("close admission blocks New chat and Send through persistence", async () => {
  useClaudeStore.getState().setDraft("/notes/a.md", "Keep draft");
  setAppClosing(true);
  try {
    await useClaudeStore.getState().newChat("/notes/a.md");
    expect(chatState().draft).toBe("Keep draft");
    expect(await send("Keep draft")).toBe(false);
    expect(vi.mocked(writePreferenceStrict)).not.toHaveBeenCalled();
  } finally {
    setAppClosing(false);
  }
});

test("closing and reopening during preparation retains the flushed target buffer", async () => {
  const preparation = deferred<string>();
  const complete = vi.fn();
  useEditorStore.getState().updateContent("/notes/a.md", "Latest");
  const sending = send("Feedback", {
    turn: { path: "/notes/a.md", prepare: () => preparation.promise, complete },
  });
  await tick();
  useEditorStore.getState().closeFile("/notes/a.md");
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Latest");
  await useEditorStore.getState().openFile("/notes/a.md");
  preparation.resolve("Prepared");
  expect(await sending).toBe(true);
  expect(await send("Duplicate")).toBe(false);
  await claudeEdits(() => disk.set("/notes/a.md", "Revised"));
  emit({ type: "result", is_error: false });
  await tick();
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Revised");
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    status: "completed",
    changed: true,
    error: null,
  });
});

test("aliases share ownership and pending widget writes are drained before startup", async () => {
  const alias = "/notes/alias.md";
  mockedInvoke.mockImplementation((command, args) =>
    command === "read_file" && (args as { path: string }).path === alias
      ? Promise.resolve({
          path: alias,
          canonical_path: "/notes/a.md",
          content: disk.get("/notes/a.md"),
          modified_at: 1,
        })
      : defaultInvoke(command, args),
  );
  await useEditorStore.getState().openFileInNewTab(alias);
  const write = deferred<unknown>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "write_file" ? write.promise : defaultInvoke(command, args),
  );
  const unregister = registerPendingEditorFlush(
    () => alias,
    () => useEditorStore.getState().updateContent(alias, "Embedded edit"),
  );
  const sending = useClaudeStore.getState().send("/notes/a.md", "A");
  expect(chatState(alias).messages.map((message) => message.text)).toEqual(["A"]);
  await tick();
  expect(isAgentTurnActive(alias)).toBe(true);
  expect(await useClaudeStore.getState().send(alias, "Duplicate")).toBe(false);
  expect(chatState(alias).messages.map((message) => message.text)).toEqual(["A"]);
  expect(mockedInvoke.mock.calls.some(([command]) => command === "claude_start")).toBe(false);
  disk.set("/notes/a.md", "Embedded edit");
  write.resolve({ path: "/notes/a.md", modified_at: 2 });
  expect(await sending).toBe(true);
  unregister();
  await claudeEdits(() => disk.set("/notes/a.md", "Agent revision"));
  emit({ type: "result", is_error: false });
  await tick();
  expect(useEditorStore.getState().openFiles.get(alias)?.content).toBe("Agent revision");
  expect(useEditorStore.getState().openFiles.get("/notes/a.md")?.content).toBe("Agent revision");
});

test("overlapping lifecycle owners cannot release each other's close admission", async () => {
  const workspaceClose = Symbol("workspace"),
    windowClose = "window:round";
  beginFeedbackClose(workspaceClose);
  beginFeedbackClose(windowClose);
  resumeFeedbackPersistence(workspaceClose);
  expect(await send("Race")).toBe(false);
  await useClaudeStore.getState().newChat("/notes/a.md");
  expect(vi.mocked(writePreferenceStrict)).not.toHaveBeenCalled();
  resumeFeedbackPersistence(windowClose);
  expect(await send("Allowed")).toBe(true);
  await useClaudeStore.getState().stopAll();
});

test("feedback outcomes remain independent across simultaneous notes", async () => {
  const first = createFeedback("Original");
  disk.set("/notes/b.md", "Original B");
  await useEditorStore.getState().openFileInNewTab("/notes/b.md");
  const feedback = useFeedbackStore.getState();
  feedback.reconcile("/notes/b.md", null, "Original B");
  feedback.attach("/notes/b.md", feedbackTargets("Original B")[0]!);
  feedback.saveNotes("/notes/b.md", "Revise B");
  const second = useFeedbackStore.getState().byPath["/notes/b.md"][0]!.id;
  await applyFeedback("/notes/a.md", [first]);
  await applyFeedback("/notes/b.md", [second]);
  expect(channels).toHaveLength(2);
  await claudeEdits(() => disk.set("/notes/b.md", "Revised B"), channels[1], "/notes/b.md");
  emit({ type: "result", is_error: false }, channels[0]);
  emit({ type: "result", is_error: false }, channels[1]);
  await tick();
  expect(feedbackItems()).toEqual([]);
  expect(useFeedbackStore.getState().byPath["/notes/b.md"]).toEqual([]);
  expect(useFeedbackStore.getState().turnErrors["/notes/b.md"]).toBeNull();
  expect(useFeedbackStore.getState().error).toBeNull();
});

test("a reopened workspace restores each note's chat and resumes its session", async () => {
  await reopenWithSavedChat({
    sessionId: "session-a",
    messages: [
      { id: "u1", role: "user", text: "Earlier question", tools: [] },
      {
        id: "a1",
        role: "assistant",
        text: "Earlier answer",
        tools: [
          { id: "t1", name: "Read" },
          { id: "t2", name: "Edit", done: true },
        ],
      },
    ],
  });
  expect(chatMessages("/notes/a.md").map((message) => message.text)).toEqual([
    "Earlier question",
    "Earlier answer",
  ]);
  expect(chatMessages("/notes/a.md")[1]!.tools).toEqual([
    { id: "t1", name: "Read", done: true, error: true },
    { id: "t2", name: "Edit", done: true },
  ]);
  await send("Follow up");
  expect(
    mockedInvoke.mock.calls.filter(([command]) => command === "claude_start").at(-1)?.[1],
  ).toMatchObject({ resumeSessionId: "session-a" });
  emit({ type: "system", subtype: "init", session_id: "session-a" });
  emit({ type: "stream_event", event: { type: "message_start", message: { id: "a2" } } });
  emit({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reply" } },
  });
  emit({ type: "result", is_error: false });
  await tick();
  expect(savedChats().at(-1)).toEqual([
    "/notes\0/notes/a.md",
    {
      version: 2,
      session: { id: "session-a", agent: "claude-code" },
      messages: chatMessages("/notes/a.md"),
    },
  ]);
  expect(chatMessages("/notes/a.md").map((message) => message.text)).toEqual([
    "Earlier question",
    "Earlier answer",
    "Follow up",
    "Reply",
  ]);
});

test("the sent message is saved before Claude starts, and New chat and moves rewrite the record", async () => {
  const start = deferred<string>();
  mockedInvoke.mockImplementation((command, args) =>
    command === "claude_start" ? start.promise : defaultInvoke(command, args),
  );
  const sending = send("Remember me");
  await tick();
  expect(savedChats()).toEqual([
    [
      "/notes\0/notes/a.md",
      { version: 2, session: null, messages: [expect.objectContaining({ text: "Remember me" })] },
    ],
  ]);
  start.resolve("process-1");
  await sending;
  emit({ type: "result", is_error: false });
  await tick();
  await useClaudeStore.getState().rewriteChatPaths("/notes", "/notes/a.md", "/notes/c.md", false);
  expect(savedChats().slice(-2)).toEqual([
    ["/notes\0/notes/a.md", undefined],
    ["/notes\0/notes/c.md", expect.objectContaining({ version: 2 })],
  ]);
  await useClaudeStore.getState().newChat("/notes/c.md");
  expect(savedChats().at(-1)).toEqual(["/notes\0/notes/c.md", undefined]);
});

test("an expired Claude Code session keeps the restored thread and says to start a new conversation", async () => {
  await reopenWithSavedChat({
    sessionId: "gone",
    messages: [{ id: "u1", role: "user", text: "Earlier", tools: [] }],
  });
  await send("Again");
  emit({
    type: "result",
    is_error: true,
    errors: ["No conversation found with session ID: gone"],
  });
  await tick();
  expect(chatState().error).toBe(
    "This conversation can't be continued in Claude Code any more. Start a new conversation to keep going.",
  );
  expect(chatMessages("/notes/a.md").map((message) => message.text)).toEqual(["Earlier", "Again"]);
});

const codexLine = (method: string, params: unknown) =>
  channels.at(-1)!.onmessage({ type: "line", line: JSON.stringify({ method, params }) });
const startArgs = (command: string) =>
  mockedInvoke.mock.calls.filter(([c]) => c === command).at(-1)?.[1];

test("switching to Codex starts a fresh thread and says it lacks the earlier messages", async () => {
  await reopenWithSavedChat({
    sessionId: "session-a",
    messages: [{ id: "u1", role: "user", text: "Earlier", tools: [] }],
  });
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, "co-writer.agent": "codex" },
  }));
  expect(await send("Shorten it")).toBe(true);
  expect(startArgs("claude_start")).toBeUndefined();
  expect(startArgs("codex_start")).toMatchObject({ resumeSessionId: null });
  expect(chatState().notices.map((entry) => entry.text)).toEqual([
    "This chat now runs on Codex, which doesn't have the earlier messages as context.",
  ]);
  codexLine("writer/thread", { threadId: "thread-1" });
  codexLine("turn/started", { turn: { id: "turn-1" } });
  codexLine("item/started", { item: { type: "agentMessage", id: "m1" } });
  codexLine("item/agentMessage/delta", { itemId: "m1", delta: "Done." });
  codexLine("turn/completed", { turn: { status: "completed" } });
  await tick();
  expect(chatState().status).toBe("idle");
  expect(chatMessages("/notes/a.md").map((message) => message.text)).toEqual([
    "Earlier",
    "Shorten it",
    "Done.",
  ]);
  expect(savedChats().at(-1)?.[1]).toMatchObject({
    version: 2,
    session: { id: "thread-1", agent: "codex" },
  });
});

test("a Codex chat resumes its own thread, and a missing one says to start over", async () => {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, "co-writer.agent": "codex" },
  }));
  await reopenWithSavedChat({
    version: 2,
    session: { id: "thread-1", agent: "codex" },
    messages: [{ id: "u1", role: "user", text: "Earlier", tools: [] }],
  });
  await send("Again");
  expect(startArgs("codex_start")).toMatchObject({ resumeSessionId: "thread-1" });
  expect(chatState().notices).toEqual([]);
  codexLine("writer/failed", {
    message: "thread/resume failed: no rollout found for thread id thread-1",
  });
  await tick();
  expect(chatState().error).toBe(
    "This conversation can't be continued in Codex any more. Start a new conversation to keep going.",
  );
});

test("an unknown agent in Settings fails the send without starting anything", async () => {
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, "co-writer.agent": "gemini" },
  }));
  expect(await send("Hello")).toBe(false);
  expect(chatState()).toMatchObject({
    status: "error",
    error: 'Unknown Co-writer agent "gemini". Choose one in Settings → Co-writer.',
  });
  expect(mockedInvoke.mock.calls.some(([c]) => c.endsWith("_start"))).toBe(false);
});

test("New conversation focuses the composer once the old draft is cleared", async () => {
  await send("First");
  useClaudeStore.getState().setDraft("/notes/a.md", "Half-typed");
  const focus = vi.fn(() => expect(chatState().draft).toBe(""));
  registerChatComposer("/notes/a.md", {
    focus,
    isConnected: true,
  } as unknown as HTMLTextAreaElement);

  await newChat("/notes/a.md");

  expect(focus).toHaveBeenCalledOnce();
  registerChatComposer("/notes/a.md", null);
});
