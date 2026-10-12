import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useEditorStore } from "@/stores/editor-store";
import * as tauri from "@/lib/tauri";
import { flushSave } from "@/lib/save";
import { readStoreEntriesStrict, writeStoreEntriesStrict } from "@/lib/preferences";
import { getEditorView, synchronizeEditorView } from "@/lib/editor-views";
import {
  markAgentReload,
  consumeAgentReload,
  acquireAgentEditing,
  acquireAgentTurn,
  clearAgentEditing,
  isAgentEditing,
  isAgentTurnActive,
  flushPendingEditors,
  clearDocumentPaths,
  reserveAgentReset,
  documentPath,
  isPathMutating,
  isAppClosing,
} from "@/lib/agent-turn";
import type { AgentTurnOptions, SendOptions } from "@/lib/agent-request";
import { parseDocument } from "@/lib/frontmatter";
import { getFileName } from "@/lib/paths";
import { attachmentRange } from "@/lib/feedback-anchors";
import {
  isQueueReady,
  reconcileFeedbackAfterTurn,
  useFeedbackStore,
  type FeedbackBatch,
} from "@/stores/feedback-store";
import {
  parseClaudeLine,
  reduceClaudeMessages,
  getClaudeActivity,
  isVisibleMessage,
  type ClaudeActivity,
  type ChatMessage,
  type ToolPermission,
} from "@/lib/claude-stream";

export interface ChatNotice {
  afterId: string;
  text: string;
}
export interface Chat {
  messages: ChatMessage[];
  draft: string;
  /** Files attached to the draft, as canonical paths. */
  files: string[];
  /** Why the last attempt to attach files failed; cleared by the next attach. */
  fileError: string | null;
  activity: ClaudeActivity;
  status: "idle" | "running" | "stopping" | "error";
  error: string | null;
  notices: ChatNotice[];
  permissions: ToolPermission[];
  /** Tools the user always allows in this chat. Kept in memory until the app quits. */
  allowedTools: string[];
}
export const EMPTY_CHAT: Chat = {
  messages: [],
  draft: "",
  files: [],
  fileError: null,
  activity: null,
  status: "idle",
  error: null,
  notices: [],
  permissions: [],
  allowedTools: [],
};
interface ClaudeState {
  chats: Record<string, Chat>;
  setDraft: (path: string, draft: string) => void;
  addFiles: (path: string, files: string[]) => void;
  removeFile: (path: string, file: string) => void;
  setFileError: (path: string, error: string | null) => void;
  decidePermission: (path: string, id: string, allow: boolean, always?: boolean) => Promise<void>;
  send: (path: string, text: string, options?: SendOptions) => Promise<boolean>;
  /** Sends the queued items (all ready ones by default) together as one turn. */
  sendQueue: (path: string, ids?: string[]) => Promise<void>;
  stop: (path: string) => Promise<void>;
  stopAll: () => Promise<void>;
  newChat: (path: string) => Promise<void>;
  rewriteChatPaths: (root: string, from: string, to: string, isDir: boolean) => Promise<void>;
}
interface Run {
  key: string;
  path: string;
  turnId: string;
  root: string;
  workspaceGeneration: number;
  options: AgentTurnOptions | null;
  edit: Edit | null;
  changed: boolean;
  cancelled: boolean;
  handedOff: boolean;
  ended: boolean;
  exited: boolean;
  error: string | null;
  processId: string | null;
  processStarted: Promise<void>;
  resolveProcessStarted: () => void;
  pendingSend: Promise<boolean> | null;
  finishing: Promise<void> | null;
  stopping: Promise<void> | null;
  sessionWrite: Promise<void> | null;
  sessionId: string | null;
  streamingId: string | null;
  streamingBlockIndex: number;
  permissionIds: Set<string>;
  releaseTurn: () => void;
}
interface Edit {
  /** Canonical note being edited: the chat's own note or another approved one. */
  key: string;
  toolUseId: string | null;
  before: string | null;
  release: () => void;
  ending: Promise<void> | null;
}
const runs = new Map<string, Run>();
const resets = new Map<string, Promise<void>>();
let drains = 0;
export function chatForPath(chats: Record<string, Chat>, path: string | null) {
  return path ? (chats[documentPath(path)] ?? EMPTY_CHAT) : EMPTY_CHAT;
}
const EXPIRED_SESSION =
  "This conversation can't be continued in Claude Code any more. Start a new chat to keep going.";

/** One record per canonical note path, so the visible thread and its session can't drift. */
interface ChatRecord {
  version: 1;
  sessionId: string | null;
  messages: ChatMessage[];
}
type ChatRecords = Record<string, ChatRecord>;
const CHATS_FILE = "chats.json";
// Claude Code sessions belong to the root they ran in, so a nested workspace must not share them.
const recordPrefix = (root: string) => `${root}\0`;

/** A tool that never finished was cut off by a quit or crash, not still running. */
function restoreMessages(messages: ChatMessage[]) {
  return messages.map((message) =>
    message.tools.some((tool) => !tool.done && !tool.error)
      ? {
          ...message,
          tools: message.tools.map((tool) =>
            tool.done || tool.error ? tool : { ...tool, done: true, error: true },
          ),
        }
      : message,
  );
}

function hydrate(root: string, generation: number, records: ChatRecords) {
  const workspace = useWorkspaceStore.getState();
  if (workspace.root !== root || workspace.workspaceGeneration !== generation) return;
  useClaudeStore.setState((state) => {
    let chats = state.chats;
    for (const [key, record] of Object.entries(records)) {
      const stored = restoreMessages(record.messages);
      const ids = new Set(stored.map((message) => message.id));
      chats = withChat(chats, key, (chat) => ({
        ...chat,
        messages: [...stored, ...chat.messages.filter((message) => !ids.has(message.id))],
      }));
    }
    return { chats };
  });
}

const loadedChats = new Map<string, Promise<ChatRecords>>();
function loadChats(root: string) {
  let loaded = loadedChats.get(root);
  if (!loaded) {
    const generation = useWorkspaceStore.getState().workspaceGeneration;
    const prefix = recordPrefix(root);
    loaded = readStoreEntriesStrict<ChatRecord>(CHATS_FILE).then((entries) => {
      const records: ChatRecords = {};
      for (const [entry, record] of entries) {
        if (!entry.startsWith(prefix)) continue;
        const key = entry.slice(prefix.length);
        if (record?.version === 1 && Array.isArray(record.messages)) records[key] = record;
        else console.error("[chat] Ignoring unreadable saved chat", key);
      }
      hydrate(root, generation, records);
      return records;
    });
    loadedChats.set(root, loaded);
    const pending = loaded;
    void pending.catch(() => {
      if (loadedChats.get(root) === pending) loadedChats.delete(root);
    });
  }
  return loaded;
}

const chatWrites = new Map<string, Promise<void>>();
function updateChats(root: string, update: (records: ChatRecords) => ChatRecords) {
  const task = (chatWrites.get(root) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const before = await loadChats(root);
      const records = update(before);
      const keys = new Set([...Object.keys(before), ...Object.keys(records)]);
      const changes = [...keys]
        .filter((key) => before[key] !== records[key])
        .map((key): [string, ChatRecord | undefined] => [recordPrefix(root) + key, records[key]]);
      if (changes.length) await writeStoreEntriesStrict(CHATS_FILE, changes);
      loadedChats.set(root, Promise.resolve(records));
    });
  chatWrites.set(root, task);
  const clear = () => {
    if (chatWrites.get(root) === task) chatWrites.delete(root);
  };
  void task.then(clear, clear);
  return task;
}
/** Snapshots the note's live messages at write time; a stale workspace keeps the stored ones. */
function persistChat(root: string, key: string, generation: number, sessionId?: string) {
  return updateChats(root, (records) => {
    const workspace = useWorkspaceStore.getState();
    const live = workspace.root === root && workspace.workspaceGeneration === generation;
    const stored = records[key];
    const messages = live
      ? (useClaudeStore.getState().chats[key]?.messages ?? [])
      : (stored?.messages ?? []);
    const record: ChatRecord = {
      version: 1,
      sessionId: sessionId ?? stored?.sessionId ?? null,
      messages: messages.filter(isVisibleMessage),
    };
    return { ...records, [key]: record };
  });
}

function movedPath(path: string, from: string, to: string, isDir: boolean) {
  if (path === from) return to;
  return isDir && path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
}
function rekey<T>(record: Record<string, T>, from: string, to: string, isDir: boolean) {
  const next: Record<string, T> = {};
  for (const [path, value] of Object.entries(record))
    next[movedPath(path, from, to, isDir) ?? path] = value;
  return next;
}

function withChat(chats: Record<string, Chat>, path: string, update: (chat: Chat) => Chat) {
  const before = chats[path] ?? EMPTY_CHAT;
  const after = update(before);
  return before === after ? chats : { ...chats, [path]: after };
}

/** Attachment lines refer to the saved file, frontmatter included, as Claude's Read tool shows it. */
function attachmentContext(path: string, attachments: SendOptions["attachments"]) {
  if (!attachments?.length) return [];
  const view = getEditorView(path);
  const file = useEditorStore.getState().openFiles.get(path);
  const body = file ? parseDocument(file.diskContent).body : null;
  const doc = view && body === view.state.doc.toString() ? view.state.doc : null;
  const offset =
    file && body !== null
      ? file.diskContent.slice(0, file.diskContent.length - body.length).split("\n").length - 1
      : 0;
  return attachments.map(({ anchor, quote }) => {
    const text = quote ?? anchor.text;
    const { from, to } = attachmentRange(anchor, quote);
    if (!doc || !anchor.attached || to > doc.length) return { text };
    return {
      fromLine: doc.lineAt(from).number + offset,
      toLine: doc.lineAt(Math.max(from, to - 1)).number + offset,
      text,
    };
  });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function current(run: Run) {
  return (
    runs.get(run.key) === run &&
    useWorkspaceStore.getState().workspaceGeneration === run.workspaceGeneration
  );
}
function updateChat(path: string, update: (chat: Chat) => Chat) {
  useClaudeStore.setState((state) => ({ chats: withChat(state.chats, path, update) }));
}
function patch(run: Run, values: Partial<Chat>) {
  if (current(run)) updateChat(run.key, (chat) => ({ ...chat, ...values }));
}
function end(run: Run, error: string | null) {
  if (!current(run)) return;
  run.ended = true;
  run.error ??= error;
  patch(run, { status: "stopping", activity: null, permissions: [], error: run.error });
  if (!run.pendingSend && !run.cancelled) void finish(run);
}
async function terminate(run: Run) {
  const id = run.processId;
  if (!id) return;
  await tauri.claudeStop(id);
  if (run.processId === id) run.processId = null;
}
function finish(run: Run): Promise<void> {
  if (!current(run)) return Promise.resolve();
  if (run.finishing) return run.finishing;
  const task = (async () => {
    patch(run, { status: "stopping", activity: null, permissions: [] });
    try {
      try {
        await terminate(run);
      } catch (error) {
        patch(run, { error: `Could not stop Claude Code: ${errorText(error)}` });
        return;
      }
      if (!current(run)) return;
      if (run.edit) await endEdit(run);
      if (run.handedOff) {
        // Only a lost session ID keeps the note locked; a lost transcript is reported.
        const sessionSaved = await (run.sessionWrite ?? Promise.resolve()).then(
          () => true,
          () => false,
        );
        try {
          await persistChat(run.root, run.key, run.workspaceGeneration, run.sessionId ?? undefined);
        } catch (error) {
          if (!sessionSaved) throw error;
          run.error ??= `Could not save this chat: ${errorText(error)}`;
        }
      }
      if (!current(run)) return;
      const options = run.options;
      run.options = null;
      run.releaseTurn();
      runs.delete(run.key);
      updateChat(run.key, (chat) => ({
        ...chat,
        status: run.error ? "error" : "idle",
        error: run.error,
        activity: null,
        permissions: [],
      }));
      options?.complete({
        status: run.cancelled ? "cancelled" : run.error ? "failed" : "completed",
        changed: run.changed,
        error: run.error,
      });
      useEditorStore.getState().pruneUnreferencedFiles();
      // Stop and failures pause the queue until the user sends it.
      if (!run.cancelled && !run.error) void useClaudeStore.getState().sendQueue(run.path);
    } catch (error) {
      patch(run, {
        error: `Could not reload your note: ${errorText(error)}. Retry reload before editing.`,
      });
    }
  })();
  run.finishing = task;
  void task.finally(() => {
    if (run.finishing === task) run.finishing = null;
  });
  return task;
}
function notice(run: Run, text: string) {
  updateChat(run.key, (chat) => {
    // Every turn starts a new CLI process that repeats its startup warnings.
    if (chat.notices.some((notice) => notice.text === text)) return chat;
    const visible = chat.messages.filter(isVisibleMessage);
    const afterId = visible[visible.length - 1]?.id ?? run.turnId;
    return { ...chat, notices: [...chat.notices, { afterId, text }].slice(-50) };
  });
}
/** Lock and save the note only while Claude applies an Edit/Write, then release it to the CLI. */
async function beginEdit(run: Run, requestId: string, toolUseId: string | null, key: string) {
  const own = key === run.key;
  let edit = run.edit;
  let ready = false;
  try {
    // Edits apply one at a time, so the previous note's tool result has already arrived.
    if (edit && edit.key !== key) {
      await endEdit(run);
      if (!current(run)) return;
      edit = run.edit;
    }
    if (edit) edit.toolUseId = toolUseId ?? edit.toolUseId;
    else if (!own && isAgentTurnActive(key))
      throw new Error(`Another chat is editing ${getFileName(key)}.`);
    else {
      const release = acquireAgentEditing(own ? run.path : key);
      edit = run.edit = { key, toolUseId, before: null, release, ending: null };
    }
    // Embedded flushers may have dirtied another display alias synchronously.
    const aliases = [...useEditorStore.getState().openFiles.values()].filter(
      (entry) => documentPath(entry.path) === key,
    );
    if (aliases.filter((entry) => entry.isDirty).length > 1)
      throw new Error("Save or close conflicting aliases of this note first.");
    for (const alias of aliases) await flushSave(alias.path);
    if (!current(run) || run.edit !== edit) return;
    if (own) edit.before ??= (await tauri.readFile(key)).content;
    ready = true;
  } catch (error) {
    if (current(run))
      notice(
        run,
        `Could not save ${own ? "your note" : getFileName(key)} before the AI edit: ${errorText(error)}`,
      );
  }
  if (!current(run) || run.edit !== edit || !run.processId) return;
  try {
    await tauri.claudeEditReady(run.processId, requestId, ready);
  } catch (error) {
    console.error("[chat] Could not release the AI edit", error);
  }
}
/** Reload the edited note while it is still locked; a failed reload keeps the lock for retry. */
function endEdit(run: Run): Promise<void> {
  const edit = run.edit;
  if (!edit) return Promise.resolve();
  edit.ending ??= reloadAfterEdit(run, edit).then(
    () => {
      if (run.edit !== edit) return;
      run.edit = null;
      edit.release();
    },
    (error) => {
      edit.ending = null;
      throw error;
    },
  );
  return edit.ending;
}
async function reloadAfterEdit(run: Run, edit: Edit) {
  const own = edit.key === run.key;
  let content: string | null = null;
  try {
    content = (await tauri.readFile(edit.key)).content;
  } catch (error) {
    if (await tauri.fileExists(edit.key)) throw error;
  }
  if (!current(run)) return;
  // A missing other note is an approved new note that was never written.
  if (own && content === null) {
    run.changed = true;
    run.error = `The file was deleted on disk: ${run.path}`;
  } else if (own) run.changed ||= edit.before !== null && content !== edit.before;
  // Reconcile every display alias of the edited document, never another note.
  for (const [path, file] of useEditorStore.getState().openFiles) {
    if (documentPath(path) !== edit.key) continue;
    if (content === null) {
      useEditorStore.getState().removePathReferences(path);
      continue;
    }
    if (file.diskContent !== content) {
      markAgentReload(path, file.reloadVersion + 1, file.frontmatter);
      useEditorStore.getState().reloadFromDisk(path, content);
      synchronizeEditorView(path);
      consumeAgentReload(path, file.reloadVersion + 1);
    }
  }
  if (content !== null) {
    const failures = await reconcileFeedbackAfterTurn(own ? run.path : edit.key);
    if (failures.size) throw failures.values().next().value;
  }
}
function receive(run: Run, event: tauri.AgentEvent) {
  if (!current(run)) return;
  if (event.type === "started") {
    run.processId = event.processId;
    run.resolveProcessStarted();
    return;
  }
  if (run.cancelled) return;
  try {
    if (event.type === "exit") {
      run.exited = true;
      if (!run.ended)
        end(
          run,
          `Claude Code exited${event.code === null ? "" : ` (${event.code})`}. Send again to resume.`,
        );
      return;
    }
    if (event.type === "stderr") {
      const text = event.message.trim();
      if (text) notice(run, text);
      return;
    }
    if (event.type === "edit_start") {
      void beginEdit(run, event.requestId, event.toolUseId, event.path);
      return;
    }
    const parsed = parseClaudeLine(event.line);
    if (!parsed) return;
    if (parsed.type === "init") {
      run.sessionId = parsed.sessionId;
      const write = persistChat(run.root, run.key, run.workspaceGeneration, parsed.sessionId);
      run.sessionWrite = write;
      void write.catch((error) => {
        end(run, `Could not save chat session: ${errorText(error)}`);
      });
    } else if (parsed.type === "result")
      end(
        run,
        run.sessionId === null && parsed.error?.startsWith("No conversation found with session ID")
          ? EXPIRED_SESSION
          : parsed.error,
      );
    else if (parsed.type === "permission") {
      if (run.ended || run.permissionIds.has(parsed.permission.id)) return;
      run.permissionIds.add(parsed.permission.id);
      updateChat(run.key, (chat) => ({
        ...chat,
        permissions: [...chat.permissions, parsed.permission],
      }));
      const active = useEditorStore.getState().activeFilePath;
      if (active && documentPath(active) === run.key)
        void useSettingsStore
          .getState()
          .setSetting("appearance.agent-panel-visible", true)
          .catch((error) => console.error("[chat] Could not open approval panel", error));
    } else if (parsed.type === "permission_cancel") {
      run.permissionIds.add(parsed.id);
      updateChat(run.key, (chat) => ({
        ...chat,
        permissions: chat.permissions.filter((entry) => entry.id !== parsed.id),
      }));
    } else if (parsed.type === "unsupported_control") {
      throw new Error(`Unsupported interactive request: ${parsed.subtype}`);
    } else if (!run.ended) {
      const edit = run.edit;
      if (
        edit &&
        parsed.type === "tool_results" &&
        parsed.results.some((result) => edit.toolUseId === null || result.id === edit.toolUseId)
      )
        void endEdit(run).catch((error) =>
          patch(run, {
            error: `Could not reload your note: ${errorText(error)}. Stop the chat to retry.`,
          }),
        );
      if (parsed.type === "start") {
        run.streamingId = parsed.id;
        run.streamingBlockIndex = 0;
      }
      if (parsed.type === "block_start") run.streamingBlockIndex = parsed.index;
      updateChat(run.key, (chat) => {
        const messages = reduceClaudeMessages(
          chat.messages,
          parsed,
          run.streamingId,
          run.streamingBlockIndex,
        );
        const activity = getClaudeActivity(parsed, messages, chat.activity);
        return messages === chat.messages && activity === chat.activity
          ? chat
          : { ...chat, messages, activity };
      });
      if (parsed.type === "message_stop") run.streamingId = null;
    }
  } catch (error) {
    run.error = `Invalid Claude stream: ${errorText(error)}`;
    void useClaudeStore.getState().stop(run.path);
  }
}
export const useClaudeStore = create<ClaudeState>((set, get) => ({
  chats: {},
  setDraft: (path, draft) => {
    const key = documentPath(path);
    if (chatForPath(get().chats, path).draft === draft) return;
    set((state) => ({ chats: withChat(state.chats, key, (chat) => ({ ...chat, draft })) }));
  },
  addFiles: (path, files) => {
    updateChat(documentPath(path), (chat) => ({
      ...chat,
      files: [...new Set([...chat.files, ...files])],
      fileError: null,
    }));
  },
  removeFile: (path, file) => {
    updateChat(documentPath(path), (chat) =>
      chat.files.includes(file)
        ? { ...chat, files: chat.files.filter((entry) => entry !== file) }
        : chat,
    );
  },
  setFileError: (path, error) => {
    updateChat(documentPath(path), (chat) =>
      chat.fileError === error ? chat : { ...chat, fileError: error },
    );
  },
  decidePermission: async (path, id, allow, always = false) => {
    const key = documentPath(path);
    const run = runs.get(key);
    const request = get().chats[key]?.permissions.find((entry) => entry.id === id);
    if (!run?.processId || run.ended || run.cancelled || !request || request.pending) return;
    const pending = { ...request, pending: true, error: undefined };
    updateChat(key, (chat) => ({
      ...chat,
      permissions: chat.permissions.map((entry) => (entry === request ? pending : entry)),
    }));
    const allowsTool = always && allow;
    try {
      await tauri.claudeDecidePermission(run.processId, id, allow, allowsTool);
      if (!current(run)) return;
      updateChat(key, (chat) => ({
        ...chat,
        permissions: chat.permissions.filter((entry) => entry !== pending),
        allowedTools:
          allowsTool && !chat.allowedTools.includes(request.tool)
            ? [...chat.allowedTools, request.tool]
            : chat.allowedTools,
      }));
      // Requests already queued before the rule existed still wait for a reply.
      if (allowsTool)
        await Promise.all(
          get()
            .chats[key]?.permissions.filter((entry) => entry.tool === request.tool)
            .map((entry) => get().decidePermission(path, entry.id, true)) ?? [],
        );
    } catch (error) {
      if (current(run))
        updateChat(key, (chat) => ({
          ...chat,
          permissions: chat.permissions.map((entry) =>
            entry === pending
              ? {
                  ...entry,
                  pending: false,
                  error: `Could not send your decision: ${errorText(error)}`,
                }
              : entry,
          ),
        }));
    }
  },
  send: (path, text, { turn: options, attachments, files } = {}) => {
    const key = documentPath(path);
    const workspace = useWorkspaceStore.getState();
    if (!text.trim() || runs.has(key) || resets.has(key) || drains > 0 || isAppClosing())
      return Promise.resolve(false);
    if (!path || !workspace.root || workspace.workspaceEpoch === null)
      return Promise.resolve(false);
    if (isAgentEditing(path)) {
      updateChat(key, (chat) => ({ ...chat, error: "Another chat is editing this note." }));
      return Promise.resolve(false);
    }
    if (isPathMutating()) {
      updateChat(key, (chat) => ({
        ...chat,
        error: "Wait for the file move to finish before sending.",
      }));
      return Promise.resolve(false);
    }
    const file = useEditorStore.getState().openFiles.get(path);
    if ((!file && !options) || file?.isLoading) return Promise.resolve(false);
    flushPendingEditors(path);
    // Embedded flushers may have dirtied another display alias synchronously.
    const aliases = [...useEditorStore.getState().openFiles.values()].filter(
      (entry) => documentPath(entry.path) === key,
    );
    if (aliases.filter((entry) => entry.isDirty).length > 1) {
      updateChat(key, (chat) => ({
        ...chat,
        status: "error",
        error: "Save or close conflicting aliases of this note before sending.",
      }));
      return Promise.resolve(false);
    }
    let resolveProcessStarted!: () => void;
    const processStarted = new Promise<void>((resolve) => {
      resolveProcessStarted = resolve;
    });
    const turnId = crypto.randomUUID();
    const run: Run = {
      key,
      path,
      turnId,
      root: workspace.root,
      workspaceGeneration: workspace.workspaceGeneration,
      options: options ?? null,
      edit: null,
      changed: false,
      cancelled: false,
      handedOff: false,
      ended: false,
      exited: false,
      error: null,
      processId: null,
      processStarted,
      resolveProcessStarted,
      pendingSend: null,
      finishing: null,
      stopping: null,
      sessionWrite: null,
      sessionId: null,
      streamingId: null,
      streamingBlockIndex: 0,
      permissionIds: new Set(),
      releaseTurn: acquireAgentTurn(path),
    };
    runs.set(key, run);
    const draft = get().chats[key]?.draft;
    const restore = !options && draft === text ? draft : null;
    const sentFiles = options ? [] : (files ?? []);
    const message: ChatMessage = {
      id: turnId,
      role: "user",
      text: text.trim(),
      tools: [],
      ...(attachments?.length ? { attachments } : {}),
      ...(sentFiles.length ? { files: sentFiles } : {}),
    };
    updateChat(key, (chat) => ({
      ...chat,
      messages: [...chat.messages, message],
      status: "running",
      activity: "thinking",
      error: null,
      permissions: [],
      ...(restore !== null ? { draft: "" } : {}),
      ...(sentFiles.length
        ? { files: chat.files.filter((file) => !sentFiles.includes(file)) }
        : {}),
    }));
    void persistChat(run.root, key, run.workspaceGeneration).catch((error) =>
      console.error("[chat] Could not save the sent message", error),
    );
    const task = (async () => {
      try {
        for (const alias of aliases) await flushSave(alias.path);
        if (!current(run) || run.cancelled || run.ended) return false;
        const saved = await tauri.readFile(key);
        if (!current(run) || run.cancelled || run.ended) return false;
        const prepared = options ? await options.prepare(saved.content) : text.trim();
        if (!current(run) || run.cancelled || run.ended) return false;
        const records = await loadChats(run.root);
        if (!current(run) || run.cancelled || run.ended) return false;
        const channel = new Channel<tauri.AgentEvent>();
        channel.onmessage = (event) => receive(run, event);
        const id = await tauri.claudeStart(
          run.root,
          workspace.workspaceEpoch!,
          records[key]?.sessionId ?? null,
          path,
          chatForPath(get().chats, key).allowedTools,
          channel,
        );
        run.processId = id;
        if (!current(run)) {
          await terminate(run);
          return false;
        }
        if (run.cancelled || run.exited || run.ended) return false;
        run.handedOff = true;
        const context = {
          openFile: key,
          attachments: options ? [] : attachmentContext(path, attachments),
          ...(sentFiles.length ? { files: sentFiles } : {}),
        };
        const content = `<writer_context>${JSON.stringify(context)}</writer_context>\n\n${prepared}`;
        await tauri.claudeSend(
          id,
          JSON.stringify({ type: "user", message: { role: "user", content } }),
          sentFiles,
        );
        return true;
      } catch (error) {
        if (current(run)) {
          if (!run.cancelled) end(run, errorText(error));
        } else console.error("[chat] Abandoned turn failed", error);
        return false;
      }
    })();
    const settled = task
      .then((ok) => {
        if (!ok && !run.cancelled && restore !== null && current(run))
          updateChat(key, (chat) => (chat.draft === "" ? { ...chat, draft: restore } : chat));
        if (!ok && !run.cancelled && sentFiles.length && current(run))
          updateChat(key, (chat) => ({
            ...chat,
            files: [...sentFiles.filter((file) => !chat.files.includes(file)), ...chat.files],
          }));
        return ok;
      })
      .finally(() => {
        run.pendingSend = null;
        if (current(run) && run.ended && !run.cancelled) void finish(run);
      });
    run.pendingSend = settled;
    return settled;
  },
  sendQueue: async (path, ids) => {
    const chat = chatForPath(get().chats, path);
    if (chat.status === "running" || chat.status === "stopping") return;
    const feedback = useFeedbackStore.getState();
    const selected =
      ids ?? (feedback.byPath[path] ?? []).filter(isQueueReady).map((item) => item.id);
    if (!selected.length) return;
    let batch: FeedbackBatch;
    try {
      batch = feedback.begin(path, selected);
    } catch (error) {
      useFeedbackStore.setState((state) => ({
        turnErrors: { ...state.turnErrors, [path]: errorText(error) },
      }));
      return;
    }
    let settled = false;
    const complete: AgentTurnOptions["complete"] = (outcome) => {
      if (settled) return;
      settled = true;
      useFeedbackStore.getState().complete(batch, outcome);
    };
    const messages = batch.items.filter((item) => !item.anchor).map((item) => item.feedback);
    const notes = batch.items.flatMap(({ anchor, quote, feedback: note }) =>
      anchor ? [{ anchor, quote, note }] : [],
    );
    const sent = await get().send(
      path,
      messages.join("\n\n") ||
        (notes.length === 1 ? "Apply this note" : `Apply my ${notes.length} notes`),
      {
        turn: {
          path,
          prepare: (disk) => useFeedbackStore.getState().prepare(batch, disk),
          complete,
        },
        attachments: notes,
      },
    );
    if (!sent && !settled && chatForPath(get().chats, path).status !== "stopping")
      complete({
        status: "failed",
        changed: false,
        error: chatForPath(get().chats, path).error ?? "Could not send your queue.",
      });
  },
  stop: (path) => {
    const run = runs.get(documentPath(path));
    if (!run) return Promise.resolve();
    if (run.stopping) return run.stopping;
    run.cancelled = true;
    run.ended = true;
    patch(run, { status: "stopping", activity: null, permissions: [] });
    const task = (async () => {
      try {
        if (!run.processId && run.pendingSend)
          await Promise.race([run.processStarted, run.pendingSend]);
        await terminate(run);
        if (run.pendingSend) await run.pendingSend;
        if (!current(run)) return;
        if (run.finishing) await run.finishing;
        if (current(run)) await finish(run);
      } catch (error) {
        patch(run, { error: `Could not stop Claude Code: ${errorText(error)}` });
      }
    })();
    run.stopping = task;
    void task.finally(() => {
      if (run.stopping === task) run.stopping = null;
    });
    return task;
  },
  stopAll: async () => {
    drains++;
    try {
      await Promise.all([...runs.values()].map((run) => get().stop(run.path)));
      await Promise.all(resets.values());
      if (runs.size)
        throw new Error(
          [...runs.values()]
            .map(
              (run) =>
                `${run.path}: ${get().chats[run.key]?.error ?? "Could not finish AI reconciliation."}`,
            )
            .join("\n"),
        );
    } finally {
      drains--;
    }
  },
  newChat: (path) => {
    if (drains > 0 || isAppClosing() || isPathMutating()) return Promise.resolve();
    const key = documentPath(path);
    const existing = resets.get(key);
    if (existing) return existing;
    const workspace = useWorkspaceStore.getState();
    const releaseReset = reserveAgentReset();
    const task = Promise.resolve().then(async () => {
      await get().stop(path);
      if (
        runs.has(key) ||
        useWorkspaceStore.getState().workspaceGeneration !== workspace.workspaceGeneration
      )
        return;
      updateChat(key, (chat) => ({ ...chat, status: "stopping" }));
      try {
        if (workspace.root)
          await updateChats(workspace.root, (records) => {
            const next = { ...records };
            delete next[key];
            return next;
          });
        if (useWorkspaceStore.getState().workspaceGeneration !== workspace.workspaceGeneration)
          return;
        set((state) => {
          const chats = { ...state.chats };
          delete chats[key];
          return { chats };
        });
      } catch (error) {
        updateChat(key, (chat) => ({
          ...chat,
          status: "error",
          error: `Could not reset chat: ${errorText(error)}`,
        }));
      }
    });
    resets.set(key, task);
    void task.finally(() => {
      releaseReset();
      if (resets.get(key) === task) resets.delete(key);
    });
    return task;
  },
  rewriteChatPaths: async (root, from, to, isDir) => {
    if (useWorkspaceStore.getState().root === root)
      set((state) => ({ chats: rekey(state.chats, from, to, isDir) }));
    await updateChats(root, (records) => rekey(records, from, to, isDir));
  },
}));
let reportedApprovals = 0;
useClaudeStore.subscribe((state, previous) => {
  if (state.chats === previous.chats) return;
  let total = 0;
  for (const chat of Object.values(state.chats)) total += chat.permissions.length;
  if (total === reportedApprovals) return;
  reportedApprovals = total;
  void tauri
    .setPendingApprovals(total)
    .catch((error) => console.error("[chat] Could not update the Dock badge", error));
});
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspaceGeneration === previous.workspaceGeneration) return;
  const abandoned = [...runs.values()];
  runs.clear();
  resets.clear();
  loadedChats.clear();
  clearAgentEditing();
  clearDocumentPaths();
  useClaudeStore.setState({ chats: {} });
  if (state.root)
    void loadChats(state.root).catch((error) =>
      console.error("[chat] Could not load saved chats", error),
    );
  for (const run of abandoned) {
    run.cancelled = true;
    const options = run.options;
    run.options = null;
    options?.complete({ status: "cancelled", changed: false, error: "Workspace changed." });
    void terminate(run).catch((error) => console.error("[chat] Workspace stop failed", error));
  }
});
