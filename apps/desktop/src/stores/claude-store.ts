import { create } from "zustand";
import { Channel } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useEditorStore } from "@/stores/editor-store";
import * as tauri from "@/lib/tauri";
import { flushSave } from "@/lib/save";
import { getPreference, setPreference } from "@/lib/preferences";
import { getEditorView, synchronizeEditorView } from "@/lib/editor-views";
import {
  markAgentReload,
  consumeAgentReload,
  setAgentEditing,
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
  type ClaudeActivity,
  type ChatMessage,
  type ToolPermission,
} from "@/lib/claude-stream";

export interface Chat {
  messages: ChatMessage[];
  draft: string;
}
export const EMPTY_CHAT: Chat = { messages: [], draft: "" };

interface ClaudeState {
  /** One conversation per note, keyed by its path. */
  chats: Record<string, Chat>;
  /** The note whose chat the current or most recent turn belongs to. */
  chatPath: string | null;
  setDraft: (path: string, draft: string) => void;
  activity: ClaudeActivity;
  status: "idle" | "running" | "stopping" | "error";
  error: string | null;
  notices: string[];
  permissions: ToolPermission[];
  decidePermission: (id: string, allow: boolean) => Promise<void>;
  send: (text: string, options?: SendOptions) => Promise<boolean>;
  stop: () => Promise<void>;
  newChat: (path: string) => Promise<void>;
  rewriteChatPaths: (root: string, from: string, to: string, isDir: boolean) => Promise<void>;
}
let pendingSend: Promise<boolean> | null = null;
let generation = 0;
let channelGeneration = 0;
let processId: string | null = null;
let processPath: string | null = null;
let streamingId: string | null = null;
let streamingBlockIndex = 0;
const permissionRequestIds = new Set<string>();
let activeRequest: {
  options: AgentTurnOptions;
  before: string | null;
  cancelled: boolean;
  error: string | null;
} | null = null;
let finishing = false;
let handedOff = false;
let paths: string[] = [];
let turnWorkspaceGeneration = 0;
const sessionsKey = (root: string) => `workspace:${root}:agent:claude-sessions`;

type Sessions = Record<string, string>;
const loadedSessions = new Map<string, Promise<Sessions>>();
function loadSessions(root: string) {
  let sessions = loadedSessions.get(root);
  if (!sessions) {
    sessions = getPreference<Sessions | null>(sessionsKey(root), null).then((stored) => ({
      ...stored,
    }));
    loadedSessions.set(root, sessions);
  }
  return sessions;
}

const sessionWrites = new Map<string, Promise<void>>();
function updateSessions(root: string, update: (sessions: Sessions) => Sessions) {
  const key = sessionsKey(root);
  const task = (sessionWrites.get(key) ?? Promise.resolve()).then(async () => {
    const sessions = update(await loadSessions(root));
    loadedSessions.set(root, Promise.resolve(sessions));
    await setPreference(key, sessions);
  });
  sessionWrites.set(key, task);
  void task.finally(() => {
    if (sessionWrites.get(key) === task) sessionWrites.delete(key);
  });
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
  return { ...chats, [path]: update(chats[path] ?? EMPTY_CHAT) };
}

function current(token: number) {
  return (
    generation === token &&
    useWorkspaceStore.getState().workspaceGeneration === turnWorkspaceGeneration
  );
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

async function finish(token: number, error: string | null = null) {
  if (!current(token) || finishing) return;
  finishing = true;
  useClaudeStore.setState({ permissions: [], activity: null, status: "stopping" });
  let reloadFailed = false;
  const request = activeRequest;
  if (request && error) request.error = error;
  let changed = false;
  let capturedDeleted = false;
  try {
    if (request?.before !== null && request) {
      try {
        const captured = await tauri.readFile(request.options.path);
        if (!current(token)) return;
        changed = captured.content !== request.before;
      } catch (readError) {
        if (await tauri.fileExists(request.options.path)) throw readError;
        if (!current(token)) return;
        changed = true;
        capturedDeleted = true;
        error = `The file was deleted on disk: ${request.options.path}`;
        request.error = error;
        useEditorStore.getState().removePathReferences(request.options.path);
      }
    }
    // The watcher is suppressed during the handoff. Exactly one owned reload
    // per open file preserves a single undo step across all Claude Edit calls.
    const reconciled = new Set<string>();
    while (handedOff) {
      const path = [...useEditorStore.getState().openFiles.keys()].find(
        (entry) => !reconciled.has(entry),
      );
      if (!path) break;
      reconciled.add(path);
      if (!useEditorStore.getState().openFiles.has(path)) continue;
      let content;
      try {
        content = await tauri.readFile(path);
      } catch (readError) {
        if (!useEditorStore.getState().openFiles.has(path)) continue;
        if (!(await tauri.fileExists(path))) {
          if (!current(token)) return;
          useEditorStore.getState().removePathReferences(path);
          error = `The file was deleted on disk: ${path}`;
          continue;
        }
        throw readError;
      }
      if (!current(token)) return;
      const file = useEditorStore.getState().openFiles.get(path);
      if (file && file.diskContent !== content.content) {
        markAgentReload(path, file.reloadVersion + 1, file.frontmatter);
        useEditorStore.getState().reloadFromDisk(path, content.content);
        synchronizeEditorView(path);
        consumeAgentReload(path, file.reloadVersion + 1);
      }
    }
    if (handedOff) {
      const failures = await reconcileFeedbackAfterTurn();
      if (request && !capturedDeleted && failures.has(request.options.path))
        throw failures.get(request.options.path);
    }
    if (!current(token)) return;
  } catch (err) {
    reloadFailed = true;
    error = `Could not reload your notes: ${errorText(err)}. Retry reload before editing.`;
  } finally {
    if (current(token)) {
      if (!reloadFailed) setAgentEditing(false);
      if (!reloadFailed && request && activeRequest === request) {
        activeRequest = null;
        request.options.complete({
          status: request.cancelled ? "cancelled" : error || request.error ? "failed" : "completed",
          changed,
          error: error ?? request.error,
        });
      }
      finishing = false;
      useClaudeStore.setState({
        status: reloadFailed ? "stopping" : error ? "error" : "idle",
        error,
      });
    }
  }
}

export const useClaudeStore = create<ClaudeState>((set, get) => ({
  chats: {},
  chatPath: null,
  setDraft: (path, draft) =>
    set((state) => ({ chats: withChat(state.chats, path, (chat) => ({ ...chat, draft })) })),
  activity: null,
  status: "idle",
  error: null,
  notices: [],
  permissions: [],
  decidePermission: async (id, allow) => {
    const permission = get().permissions.find((request) => request.id === id);
    const process = processId;
    if (!permission || permission.pending || !process || get().status !== "running") return;
    const token = generation;
    const pending = { ...permission, pending: true, error: undefined };
    set((state) => ({
      permissions: state.permissions.map((entry) => (entry === permission ? pending : entry)),
    }));
    try {
      await tauri.claudeSend(
        process,
        JSON.stringify({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: id,
            response: allow
              ? { behavior: "allow", updatedInput: permission.input }
              : { behavior: "deny", message: "Denied by the user in Writer." },
          },
        }),
      );
      if (current(token))
        set((state) => ({ permissions: state.permissions.filter((entry) => entry !== pending) }));
    } catch (error) {
      if (current(token))
        set((state) => ({
          permissions: state.permissions.map((entry) =>
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
  send: (text, { turn: options, attachments } = {}) => {
    if (!text.trim() || get().status === "running" || get().status === "stopping")
      return Promise.resolve(false);
    let draftToRestore: { path: string; draft: string; token: number } | null = null;
    const task = (async () => {
      if (!text.trim() || get().status === "running" || get().status === "stopping") return false;
      const workspace = useWorkspaceStore.getState();
      const activePath = options?.path ?? useEditorStore.getState().activeFilePath;
      if (isAppClosing()) return false;
      if (isPathMutating()) {
        set({ chatPath: activePath, error: "Wait for the file move to finish before sending." });
        return false;
      }
      if (!workspace.root || workspace.workspaceEpoch === null || !activePath) {
        set({
          chatPath: activePath,
          status: "error",
          error: "Open a Markdown file in a workspace first.",
        });
        return false;
      }
      const token = generation;
      turnWorkspaceGeneration = workspace.workspaceGeneration;
      const root = workspace.root;
      activeRequest = options ? { options, before: null, cancelled: false, error: null } : null;
      handedOff = false;
      paths = [...useEditorStore.getState().openFiles.keys()];
      // Lock synchronously, including explicit widget/store mutations, before
      // awaiting a save or starting a process.
      setAgentEditing(true);
      streamingId = null;
      streamingBlockIndex = 0;
      const draft = get().chats[activePath]?.draft;
      if (!options && draft === text) draftToRestore = { path: activePath, draft, token };
      set((state) => ({
        chatPath: activePath,
        status: "running",
        activity: "thinking",
        error: null,
        ...(draftToRestore
          ? { chats: withChat(state.chats, activePath, (chat) => ({ ...chat, draft: "" })) }
          : {}),
      }));
      try {
        for (const path of paths) {
          await flushSave(path);
          if (!current(token)) return false;
        }
        let prepared = text.trim();
        if (options) {
          const saved = await tauri.readFile(activePath);
          if (!current(token)) return false;
          if (activeRequest) activeRequest.before = saved.content;
          prepared = await options.prepare(saved.content);
          if (!current(token)) return false;
        }
        handedOff = true;
        // A process resumes exactly one note's session.
        if (processId && processPath !== activePath) {
          const previous = processId;
          await tauri.claudeStop(previous);
          if (processId === previous) processId = null;
          if (!current(token)) return false;
        }
        if (!processId) {
          const session = (await loadSessions(root))[activePath] ?? null;
          if (!current(token)) return false;
          set({ notices: [] });
          const channelToken = ++channelGeneration;
          permissionRequestIds.clear();
          let exited = false;
          const channel = new Channel<tauri.AgentEvent>();
          channel.onmessage = (event) => {
            if (!current(token) || channelToken !== channelGeneration) return;
            try {
              if (event.type === "exit") {
                exited = true;
                processId = null;
                if (get().status === "running")
                  void finish(
                    token,
                    `Claude Code exited${event.code === null ? "" : ` (${event.code})`}. Send again to resume.`,
                  );
                return;
              }
              if (event.type === "stderr") {
                const notice = event.message.trim();
                if (notice)
                  set((state) =>
                    state.notices.includes(notice)
                      ? state
                      : { notices: [...state.notices, notice].slice(-50) },
                  );
                return;
              }
              const parsed = parseClaudeLine(event.line);
              if (!parsed) return;
              if (parsed.type === "permission") {
                if (permissionRequestIds.has(parsed.permission.id)) return;
                permissionRequestIds.add(parsed.permission.id);
                if (get().status !== "running") {
                  const id = processId;
                  if (id)
                    void tauri
                      .claudeSend(
                        id,
                        JSON.stringify({
                          type: "control_response",
                          response: {
                            subtype: "success",
                            request_id: parsed.permission.id,
                            response: { behavior: "deny", message: "No active Writer turn." },
                          },
                        }),
                      )
                      .catch((error) =>
                        console.error("[chat] Could not deny inactive request", error),
                      );
                  return;
                }
                set((state) => ({ permissions: [...state.permissions, parsed.permission] }));
                void useSettingsStore
                  .getState()
                  .setSetting("appearance.agent-panel-visible", true)
                  .catch((error) => console.error("[chat] Could not open approval panel", error));
              } else if (parsed.type === "permission_cancel") {
                permissionRequestIds.add(parsed.id);
                set((state) => ({
                  permissions: state.permissions.filter((entry) => entry.id !== parsed.id),
                }));
              } else if (parsed.type === "unsupported_control") {
                const id = processId;
                if (!id) throw new Error("Control request received before process startup");
                const message = `Writer does not support this interactive request: ${parsed.subtype || "unknown"}`;
                set((state) => ({ notices: [...state.notices, message].slice(-50) }));
                void tauri
                  .claudeSend(
                    id,
                    JSON.stringify({
                      type: "control_response",
                      response: {
                        subtype: "error",
                        request_id: parsed.id,
                        error: message,
                      },
                    }),
                  )
                  .catch((error) => {
                    if (!current(token) || channelToken !== channelGeneration) return;
                    set({ error: `Could not answer Claude Code: ${errorText(error)}` });
                    void get().stop();
                  });
              } else if (parsed.type === "init") {
                const path = get().chatPath;
                if (path) void persistSession(root, path, parsed.sessionId);
              } else if (parsed.type === "result") {
                void finish(token, parsed.error);
              } else {
                if (get().status !== "running") return;
                if (parsed.type === "start") {
                  streamingId = parsed.id;
                  streamingBlockIndex = 0;
                }
                if (parsed.type === "block_start") streamingBlockIndex = parsed.index;
                set((state) => {
                  const path = state.chatPath;
                  if (!path) return state;
                  const chat = state.chats[path] ?? EMPTY_CHAT;
                  const messages = reduceClaudeMessages(
                    chat.messages,
                    parsed,
                    streamingId,
                    streamingBlockIndex,
                  );
                  const activity = getClaudeActivity(parsed, messages, state.activity);
                  return messages === chat.messages && activity === state.activity
                    ? state
                    : {
                        chats: { ...state.chats, [path]: { ...chat, messages } },
                        activity,
                      };
                });
                if (parsed.type === "message_stop") streamingId = null;
              }
            } catch (err) {
              set({ error: `Invalid Claude stream: ${errorText(err)}` });
              void get().stop();
            }
          };
          const id = await tauri.claudeStart(root, workspace.workspaceEpoch, session, channel);
          if (!current(token) || exited) {
            try {
              await tauri.claudeStop(id);
            } catch (stopError) {
              if (
                useWorkspaceStore.getState().workspaceGeneration ===
                  workspace.workspaceGeneration &&
                get().status === "stopping"
              ) {
                processId = id;
                processPath = activePath;
                set({ error: `Could not stop Claude Code: ${errorText(stopError)}` });
              } else console.error("[chat] Stale startup termination failed", stopError);
            }
            return false;
          }
          processId = id;
          processPath = activePath;
        }
        const context = {
          openFile: activePath,
          attachments: options ? [] : attachmentContext(activePath, attachments),
        };
        const content = `<writer_context>${JSON.stringify(context)}</writer_context>\n\n${prepared}`;
        set((state) => ({
          chats: withChat(state.chats, activePath, (chat) => ({
            ...chat,
            messages: [
              ...chat.messages,
              {
                id: crypto.randomUUID(),
                role: "user",
                text: text.trim(),
                tools: [],
                ...(attachments?.length ? { attachments } : {}),
              },
            ],
          })),
        }));
        await tauri.claudeSend(
          processId,
          JSON.stringify({ type: "user", message: { role: "user", content } }),
        );
        return true;
      } catch (err) {
        if (current(token)) {
          const id = processId;
          if (id) {
            try {
              await tauri.claudeStop(id);
              processId = null;
            } catch (stopError) {
              set({
                status: "stopping",
                error: `Could not stop Claude Code: ${errorText(stopError)}`,
              });
              return false;
            }
          }
          await finish(token, errorText(err));
        }
        return false;
      }
    })();
    pendingSend = task;
    return task
      .then((ok) => {
        const restore = draftToRestore;
        if (!ok && restore && pendingSend === task && current(restore.token)) {
          set((state) =>
            state.chats[restore.path]?.draft === ""
              ? {
                  chats: withChat(state.chats, restore.path, (chat) => ({
                    ...chat,
                    draft: restore.draft,
                  })),
                }
              : state,
          );
        }
        return ok;
      })
      .finally(() => {
        if (pendingSend === task) pendingSend = null;
      });
  },
  stop: async () => {
    if (get().status !== "running" && get().status !== "stopping") return;
    const token = ++generation;
    if (activeRequest) activeRequest.cancelled = true;
    const terminalError =
      get().status === "running" ||
      get().error?.startsWith("Invalid Claude stream:") ||
      get().error?.startsWith("Could not answer Claude Code:")
        ? get().error
        : null;
    set({ status: "stopping", permissions: [], activity: null });
    const id = processId;
    try {
      if (id) {
        await tauri.claudeStop(id);
        if (processId === id) processId = null;
      }
      if (pendingSend) await pendingSend;
      if (!current(token)) return;
      if (processId) {
        const started = processId;
        await tauri.claudeStop(started);
        if (processId === started) processId = null;
      }
      if (current(token)) {
        finishing = false;
        await finish(token, terminalError);
      }
    } catch (err) {
      // Keep buffers locked when backend termination could not be confirmed.
      if (current(token)) set({ error: `Could not stop Claude Code: ${errorText(err)}` });
    }
  },
  newChat: async (path) => {
    const workspace = useWorkspaceStore.getState();
    if (get().chatPath === path) await get().stop();
    if (useWorkspaceStore.getState().workspaceGeneration !== workspace.workspaceGeneration) return;
    if (get().status === "stopping") return;
    const owned = processPath === path ? processId : null;
    const token = owned ? ++generation : generation;
    if (owned) {
      streamingId = null;
      set({ status: "stopping", permissions: [], activity: null });
    }
    try {
      if (owned) {
        await tauri.claudeStop(owned);
        if (processId === owned) processId = null;
      }
      if (workspace.root) await persistSession(workspace.root, path, null);
      if (
        (owned && generation !== token) ||
        useWorkspaceStore.getState().workspaceGeneration !== workspace.workspaceGeneration
      )
        return;
      set((state) => {
        const chats = { ...state.chats };
        delete chats[path];
        const reset = owned !== null || state.chatPath === path;
        return {
          chats,
          ...(owned ? { notices: [] } : {}),
          ...(reset ? { status: "idle", error: null, chatPath: null } : {}),
        };
      });
    } catch (error) {
      if (owned && generation === token)
        set({
          status: "stopping",
          chatPath: path,
          error: `Could not stop Claude Code: ${errorText(error)}`,
        });
    }
  },
  rewriteChatPaths: async (root, from, to, isDir) => {
    const move = (path: string) => movedPath(path, from, to, isDir) ?? path;
    if (useWorkspaceStore.getState().root === root) {
      if (processPath) processPath = move(processPath);
      set((state) => ({
        chats: rekey(state.chats, from, to, isDir),
        chatPath: state.chatPath && move(state.chatPath),
      }));
    }
    await updateSessions(root, (sessions) => rekey(sessions, from, to, isDir));
  },
}));

// Workspace lifecycle is an external boundary, not a React state watcher.
useWorkspaceStore.subscribe((state, previous) => {
  if (state.workspaceGeneration === previous.workspaceGeneration) return;
  generation++;
  const abandoned = activeRequest;
  activeRequest = null;
  abandoned?.options.complete({ status: "cancelled", changed: false, error: "Workspace changed." });
  const id = processId;
  processId = null;
  streamingId = null;
  permissionRequestIds.clear();
  loadedSessions.clear();
  finishing = false;
  paths = [];
  setAgentEditing(false);
  useClaudeStore.setState({
    chats: {},
    chatPath: null,
    activity: null,
    notices: [],
    permissions: [],
    status: "idle",
    error: null,
  });
  if (id)
    void tauri
      .claudeStop(id)
      .catch((error) => console.error("[chat] Workspace stop failed", error));
});
