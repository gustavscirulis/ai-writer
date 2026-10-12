import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useEditorStore } from "@/stores/editor-store";
import * as tauri from "@/lib/tauri";
import { flushSave } from "@/lib/save";
import { readPreferenceStrict, writePreferenceStrict } from "@/lib/preferences";
import { getEditorView, synchronizeEditorView } from "@/lib/editor-views";
import {
  markAgentReload,
  consumeAgentReload,
  acquireAgentEditing,
  clearAgentEditing,
  clearDocumentPaths,
  reserveAgentReset,
  documentPath,
  isPathMutating,
  isAppClosing,
} from "@/lib/agent-turn";
import type { AgentTurnOptions, SendOptions } from "@/lib/agent-request";
import { parseDocument } from "@/lib/frontmatter";
import { attachmentRange } from "@/lib/feedback-anchors";
import { reconcileFeedbackAfterTurn } from "@/stores/feedback-store";
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
  activity: ClaudeActivity;
  status: "idle" | "running" | "stopping" | "error";
  error: string | null;
  notices: ChatNotice[];
  permissions: ToolPermission[];
}
export const EMPTY_CHAT: Chat = {
  messages: [],
  draft: "",
  activity: null,
  status: "idle",
  error: null,
  notices: [],
  permissions: [],
};
interface ClaudeState {
  chats: Record<string, Chat>;
  setDraft: (path: string, draft: string) => void;
  decidePermission: (path: string, id: string, allow: boolean) => Promise<void>;
  send: (path: string, text: string, options?: SendOptions) => Promise<boolean>;
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
  before: string | null;
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
  release: () => void;
}
const runs = new Map<string, Run>();
const resets = new Map<string, Promise<void>>();
let drains = 0;
export function chatForPath(chats: Record<string, Chat>, path: string | null) {
  return path ? (chats[documentPath(path)] ?? EMPTY_CHAT) : EMPTY_CHAT;
}
const sessionsKey = (root: string) => `workspace:${root}:agent:claude-sessions`;

type Sessions = Record<string, string>;
const loadedSessions = new Map<string, Promise<Sessions>>();
function loadSessions(root: string) {
  let sessions = loadedSessions.get(root);
  if (!sessions) {
    sessions = readPreferenceStrict<Sessions>(sessionsKey(root)).then((stored) => ({
      ...stored,
    }));
    loadedSessions.set(root, sessions);
    const pending = sessions;
    void pending.catch(() => {
      if (loadedSessions.get(root) === pending) loadedSessions.delete(root);
    });
  }
  return sessions;
}

const sessionWrites = new Map<string, Promise<void>>();
function updateSessions(root: string, update: (sessions: Sessions) => Sessions) {
  const key = sessionsKey(root);
  const task = (sessionWrites.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const sessions = update(await loadSessions(root));
      await writePreferenceStrict(key, sessions);
      loadedSessions.set(root, Promise.resolve(sessions));
    });
  sessionWrites.set(key, task);
  const clear = () => {
    if (sessionWrites.get(key) === task) sessionWrites.delete(key);
  };
  void task.then(clear, clear);
  return task;
}
function persistSession(root: string, path: string, session: string | null) {
  return updateSessions(root, (sessions) => {
    const next = { ...sessions };
    if (session) next[path] = session;
    else delete next[path];
    return next;
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
      let changed = false;
      let deleted = false;
      if (run.handedOff) {
        let content: tauriReadResult | null = null;
        try {
          content = await tauri.readFile(run.key);
        } catch (error) {
          if (await tauri.fileExists(run.key)) throw error;
          deleted = true;
          changed = true;
          run.error = `The file was deleted on disk: ${run.path}`;
        }
        if (!current(run)) return;
        changed ||= content !== null && run.before !== null && content.content !== run.before;
        // Reconcile every display alias of this document, never another note.
        for (const [path, file] of useEditorStore.getState().openFiles) {
          if (documentPath(path) !== run.key) continue;
          if (deleted) {
            useEditorStore.getState().removePathReferences(path);
            continue;
          }
          if (content && file.diskContent !== content.content) {
            markAgentReload(path, file.reloadVersion + 1, file.frontmatter);
            useEditorStore.getState().reloadFromDisk(path, content.content);
            synchronizeEditorView(path);
            consumeAgentReload(path, file.reloadVersion + 1);
          }
        }
        if (!deleted) {
          const failures = await reconcileFeedbackAfterTurn(run.path);
          if (failures.size) throw failures.values().next().value;
        }
      }
      if (run.sessionWrite) {
        await run.sessionWrite.catch(() => persistSession(run.root, run.key, run.sessionId));
      }
      if (!current(run)) return;
      const options = run.options;
      run.options = null;
      run.release();
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
        changed,
        error: run.error,
      });
      useEditorStore.getState().pruneUnreferencedFiles();
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
type tauriReadResult = Awaited<ReturnType<typeof tauri.readFile>>;
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
      if (text)
        updateChat(run.key, (chat) => {
          // Every turn starts a new CLI process that repeats its startup warnings.
          if (chat.notices.some((notice) => notice.text === text)) return chat;
          const visible = chat.messages.filter(isVisibleMessage);
          const afterId = visible[visible.length - 1]?.id ?? run.turnId;
          return { ...chat, notices: [...chat.notices, { afterId, text }].slice(-50) };
        });
      return;
    }
    const parsed = parseClaudeLine(event.line);
    if (!parsed) return;
    if (parsed.type === "init") {
      run.sessionId = parsed.sessionId;
      run.sessionWrite = persistSession(run.root, run.key, parsed.sessionId);
      void run.sessionWrite.catch((error) => {
        end(run, `Could not save chat session: ${errorText(error)}`);
      });
    } else if (parsed.type === "result") end(run, parsed.error);
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
  decidePermission: async (path, id, allow) => {
    const key = documentPath(path);
    const run = runs.get(key);
    const request = get().chats[key]?.permissions.find((entry) => entry.id === id);
    if (!run?.processId || run.ended || run.cancelled || !request || request.pending) return;
    const pending = { ...request, pending: true, error: undefined };
    updateChat(key, (chat) => ({
      ...chat,
      permissions: chat.permissions.map((entry) => (entry === request ? pending : entry)),
    }));
    try {
      await tauri.claudeDecidePermission(run.processId, id, allow);
      if (current(run))
        updateChat(key, (chat) => ({
          ...chat,
          permissions: chat.permissions.filter((entry) => entry !== pending),
        }));
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
  send: (path, text, { turn: options, attachments } = {}) => {
    const key = documentPath(path);
    const workspace = useWorkspaceStore.getState();
    if (!text.trim() || runs.has(key) || resets.has(key) || drains > 0 || isAppClosing())
      return Promise.resolve(false);
    if (!path || !workspace.root || workspace.workspaceEpoch === null)
      return Promise.resolve(false);
    if (isPathMutating()) {
      updateChat(key, (chat) => ({
        ...chat,
        error: "Wait for the file move to finish before sending.",
      }));
      return Promise.resolve(false);
    }
    const file = useEditorStore.getState().openFiles.get(path);
    if ((!file && !options) || file?.isLoading) return Promise.resolve(false);
    const release = acquireAgentEditing(path);
    // Embedded flushers may have dirtied another display alias synchronously.
    const aliases = [...useEditorStore.getState().openFiles.values()].filter(
      (entry) => documentPath(entry.path) === key,
    );
    if (aliases.filter((entry) => entry.isDirty).length > 1) {
      release();
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
      before: null,
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
      release,
    };
    runs.set(key, run);
    const draft = get().chats[key]?.draft;
    const restore = !options && draft === text ? draft : null;
    const message: ChatMessage = {
      id: turnId,
      role: "user",
      text: text.trim(),
      tools: [],
      ...(attachments?.length ? { attachments } : {}),
    };
    updateChat(key, (chat) => ({
      ...chat,
      messages: [...chat.messages, message],
      status: "running",
      activity: "thinking",
      error: null,
      permissions: [],
      ...(restore !== null ? { draft: "" } : {}),
    }));
    const task = (async () => {
      try {
        for (const alias of aliases) await flushSave(alias.path);
        if (!current(run) || run.cancelled || run.ended) return false;
        const saved = await tauri.readFile(key);
        if (!current(run) || run.cancelled || run.ended) return false;
        run.before = saved.content;
        const prepared = options ? await options.prepare(saved.content) : text.trim();
        if (!current(run) || run.cancelled || run.ended) return false;
        const sessions = await loadSessions(run.root);
        if (!current(run) || run.cancelled || run.ended) return false;
        const channel = new Channel<tauri.AgentEvent>();
        channel.onmessage = (event) => receive(run, event);
        const id = await tauri.claudeStart(
          run.root,
          workspace.workspaceEpoch!,
          sessions[key] ?? sessions[path] ?? null,
          path,
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
        };
        const content = `<writer_context>${JSON.stringify(context)}</writer_context>\n\n${prepared}`;
        await tauri.claudeSend(
          id,
          JSON.stringify({ type: "user", message: { role: "user", content } }),
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
        return ok;
      })
      .finally(() => {
        run.pendingSend = null;
        if (current(run) && run.ended && !run.cancelled) void finish(run);
      });
    run.pendingSend = settled;
    return settled;
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
          await updateSessions(workspace.root, (sessions) => {
            const next = { ...sessions };
            delete next[key];
            delete next[path];
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
    await updateSessions(root, (sessions) => rekey(sessions, from, to, isDir));
  },
}));
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspaceGeneration === previous.workspaceGeneration) return;
  const abandoned = [...runs.values()];
  runs.clear();
  resets.clear();
  loadedSessions.clear();
  clearAgentEditing();
  clearDocumentPaths();
  useClaudeStore.setState({ chats: {} });
  for (const run of abandoned) {
    run.cancelled = true;
    const options = run.options;
    run.options = null;
    options?.complete({ status: "cancelled", changed: false, error: "Workspace changed." });
    void terminate(run).catch((error) => console.error("[chat] Workspace stop failed", error));
  }
});
