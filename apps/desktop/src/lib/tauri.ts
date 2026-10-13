import {
  documentPath,
  documentIdentityGeneration,
  registerDocumentPath,
  rewriteDocumentPaths,
} from "@/lib/agent-turn";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import sidebarEntryKinds from "@shared/sidebar-entry-kinds.json";
import type {
  DirEntry,
  FileContent,
  IndexStats,
  SearchResult,
  WriteResult,
  WorkspaceInfo,
} from "@/types/fs";
import type { Capabilities } from "@/lib/co-writer-skills";

const identityReads = new Map<string, symbol>();

// Filesystem commands
export function readDirectory(path: string): Promise<DirEntry[]> {
  return invoke("read_directory", { path });
}

export function readRecentFiles(limit: number, offset: number): Promise<DirEntry[]> {
  return invoke("read_recent_files", { limit, offset });
}

export function readFileEntries(paths: string[]): Promise<DirEntry[]> {
  return invoke("read_file_entries", { paths });
}

export function readFile(path: string): Promise<FileContent> {
  const generation = documentIdentityGeneration();
  const request = Symbol(path);
  identityReads.set(path, request);
  return invoke<FileContent>("read_file", { path })
    .then((file) => {
      if (generation === documentIdentityGeneration() && identityReads.get(path) === request)
        registerDocumentPath(path, file.canonical_path ?? path);
      return { ...file, path };
    })
    .finally(() => {
      if (identityReads.get(path) === request) identityReads.delete(path);
    });
}

export function writeFile(path: string, content: string): Promise<WriteResult> {
  return invoke<WriteResult>("write_file", { path: documentPath(path), content }).then(
    (result) => ({ ...result, path }),
  );
}

export function createFile(path: string): Promise<FileContent> {
  return invoke<FileContent>("create_file", { path }).then((file) => {
    if (file.canonical_path) registerDocumentPath(path, file.canonical_path);
    return file;
  });
}

export function createDirectory(path: string): Promise<DirEntry> {
  return invoke("create_directory", { path });
}

export type SidebarEntryKind = keyof typeof sidebarEntryKinds;

export function createSidebarEntry(parentPath: string, kind: SidebarEntryKind): Promise<DirEntry> {
  return invoke("create_sidebar_entry", { parentPath, kind });
}

export interface DocumentMove {
  from: string;
  to: string;
}
export async function renameEntry(oldPath: string, newPath: string): Promise<DocumentMove> {
  const identity = await invoke<DocumentMove>("rename_entry", { oldPath, newPath });
  rewriteDocumentPaths(oldPath, newPath, true, identity.from, identity.to);
  return identity;
}

export type VersionSource = "user" | "agent" | "restore" | "external";
export interface NoteVersion {
  id: string;
  createdAt: number;
  updatedAt: number;
  source: VersionSource;
}

/** Versions of a note, newest first. */
export function listVersions(path: string): Promise<NoteVersion[]> {
  return invoke("history_list", { path: documentPath(path) });
}

export function readVersion(path: string, id: string): Promise<string> {
  return invoke("history_read", { path: documentPath(path), id });
}

/** Record the note's disk content as a version; a no-op for non-notes or unchanged content. */
export function captureVersion(
  path: string,
  source: "agent" | "external",
  group?: string,
): Promise<void> {
  return invoke("history_capture", { path: documentPath(path), source, group: group ?? null });
}

/** Write a version back to the note on disk and return its content. */
export function restoreVersion(path: string, id: string): Promise<string> {
  return invoke("history_restore", { path: documentPath(path), id });
}

export function deleteEntry(path: string): Promise<void> {
  return invoke("delete_entry", { path });
}

export function fileExists(path: string): Promise<boolean> {
  return invoke("file_exists", { path });
}

/** Case-insensitive basename lookup across the workspace (gitignore-aware
 *  walk; shortest path wins on duplicates). Used by wiki image embeds. */
export function findFileByName(root: string, fileName: string): Promise<string | null> {
  return invoke("find_file_by_name", { root, fileName });
}

export function revealInFileManager(path: string): Promise<void> {
  return invoke("reveal_in_file_manager", { path });
}

// Workspace commands
export function openWorkspace(path: string): Promise<WorkspaceInfo> {
  return invoke("open_workspace", { path });
}

export function closeWorkspace(root: string): Promise<void> {
  return invoke("close_workspace", { root });
}

export function openWorkspaceInFileManager(): Promise<void> {
  return invoke("open_workspace_in_file_manager");
}

export function openDirectoryInTerminal(path: string | null): Promise<void> {
  return invoke("open_workspace_in_terminal", { path });
}

/** Open a new in-process window for the given workspace. Each window owns
 *  its own per-window `WorkspaceState` on the Rust side (watcher, file
 *  index, settings layer) so two windows hosting different workspaces don't
 *  share file events or search results. Pass `file` to have the new window
 *  focus a specific markdown file inside the workspace. If another window
 *  already hosts `path`, that window is focused instead. */
export function openWorkspaceInNewWindow(path: string, file?: string | null): Promise<void> {
  return invoke("open_workspace_in_new_window", { path, file: file ?? null });
}

/** Bundled startup-restore IPC. Returns workspace info, root directory
 *  entries, the recents list, the persisted session, and (when available)
 *  the active tab's file content in a single round trip. */
export interface RestoreWorkspaceResponse {
  workspace: WorkspaceInfo;
  entries: DirEntry[];
  recent_workspaces: string[];
  session: SessionData | null;
  active_file: FileContent | null;
  open_file: string | null;
}

export function restoreWorkspace(path: string): Promise<RestoreWorkspaceResponse> {
  return invoke("restore_workspace", { path });
}

export async function pickWorkspace(): Promise<string | null> {
  const selected = await openDialog({
    directory: true,
    multiple: false,
    title: "Open Folder",
  });
  return selected;
}

export async function pickFile(): Promise<string | null> {
  const selected = await openDialog({
    directory: false,
    multiple: false,
    title: "Open File",
    filters: [{ name: "Markdown", extensions: ["md", "mdx", "markdown", "txt"] }],
  });
  return selected;
}

export async function pickChatFiles(): Promise<string[]> {
  return (await openDialog({ directory: false, multiple: true, title: "Attach Files" })) ?? [];
}

/** Canonical regular files; rejects folders and missing paths with a message naming them. */
export function resolveChatFiles(paths: string[]): Promise<string[]> {
  return invoke("resolve_chat_files", { paths });
}

/** Saves a pasted image to the app cache and returns its canonical path. */
export function saveChatImage(imageData: number[], format: string): Promise<string> {
  return invoke("save_chat_image", { imageData, format });
}

/** Opens a drop that didn't land on Chat, as a window drop always used to. */
export function openDroppedPaths(paths: string[]): Promise<void> {
  return invoke("open_dropped_paths", { paths });
}

export function getRecentWorkspaces(): Promise<string[]> {
  return invoke("get_recent_workspaces");
}

export function removeRecentWorkspace(path: string): Promise<void> {
  return invoke("remove_recent_workspace", { path });
}

/** Open a markdown file in a standalone compact window (no workspace). If a
 *  standalone window already hosts the file, it is focused instead. */
export function openFileInStandaloneWindow(path: string): Promise<void> {
  return invoke("open_file_in_standalone_window", { path });
}

/** Point this window's watcher at a single standalone file (parent-dir,
 *  non-recursive). Call whenever the standalone compact window switches
 *  files. */
export function watchStandaloneFile(path: string): Promise<void> {
  return invoke("watch_standalone_file", { path });
}

// Global recents (persisted across workspaces in the app data dir)
/** A recently-opened file with its last-opened time. `opened_at` is unix
 *  seconds; `0` marks a legacy entry whose open time is unknown. */
export interface RecentFile {
  path: string;
  name: string;
  title: string | null;
  opened_at: number;
}

export function recordRecentFile(path: string): Promise<void> {
  return invoke("record_recent_file", { path });
}

export function removeRecentFile(path: string): Promise<void> {
  return invoke("remove_recent_file", { path });
}

export function getRecentFilesGlobal(limit?: number): Promise<RecentFile[]> {
  return invoke("get_recent_files_global", { limit: limit ?? null });
}

// Session commands
export interface SessionData {
  tabs?: SessionTabData[];
  active_index?: number | null;
}

export interface SerializedLocationData {
  kind: string;
  [key: string]: unknown;
}

export interface SessionTabData {
  location: SerializedLocationData;
  back: SerializedLocationData[];
  forward: SerializedLocationData[];
}

export function saveSession(
  workspaceRoot: string,
  tabs: SessionTabData[],
  activeIndex: number | null,
): Promise<void> {
  return invoke("save_session", { workspaceRoot, tabs, activeIndex });
}

export function loadSession(workspaceRoot: string): Promise<SessionData | null> {
  return invoke("load_session", { workspaceRoot });
}

// Search commands
export function indexWorkspace(): Promise<IndexStats> {
  return invoke("index_workspace");
}

export function fuzzySearch(query: string, limit?: number): Promise<SearchResult[]> {
  return invoke("fuzzy_search", { query, limit });
}

// Font commands
export function listSystemFonts(): Promise<string[]> {
  return invoke("list_system_fonts");
}

// Settings commands
export function getSettings(): Promise<Record<string, unknown>> {
  return invoke("get_settings");
}

export function getSetting(key: string): Promise<unknown> {
  return invoke("get_setting", { key });
}

export function setSetting(
  key: string,
  value: unknown,
  scope: "global" | "workspace" = "global",
): Promise<unknown> {
  return invoke("set_setting", { key, value, scope });
}

export function resetSetting(key: string, scope: "global" | "workspace" = "global"): Promise<void> {
  return invoke("reset_setting", { key, scope });
}

// Telemetry consent. Enabling/disabling and the email itself go through the
// normal `setSetting` path above — these two only cover the one-time prompt.
export function telemetryShouldPrompt(): Promise<boolean> {
  return invoke("telemetry_should_prompt");
}

export function telemetryMarkPrompted(): Promise<void> {
  return invoke("telemetry_mark_prompted");
}

/** Report a declined prompt. Disclosed in the dialog and in `docs/telemetry.md`
 *  — the one thing sent on behalf of someone who said no. */
export function telemetryReportDeclined(): Promise<void> {
  return invoke("telemetry_report_declined");
}

// Pending open queue (drag-drop / CLI arg / dock open). A folder open
// carries `workspace`; a markdown-file open carries only `file` and opens
// standalone (compact window, no workspace).
export interface PendingOpenPayload {
  workspace: string | null;
  file: string | null;
}

export function takePendingOpen(): Promise<PendingOpenPayload | null> {
  return invoke("take_pending_open");
}

// Startup state (single IPC call for all initialization data). The settings
// schema is NOT included — it's a build-time constant that the frontend
// imports statically from `@/lib/settings-schema` rather than fetching over
// IPC. Rust still uses the JSON internally (config.rs::settings_schema) for
// defaults; the IPC just doesn't expose it to TS.
export interface StartupState {
  settings: Record<string, unknown>;
  recent_workspaces: string[];
  restore_bundle: RestoreWorkspaceResponse | null;
  /** Standalone compact-mode open (CLI arg / drag-drop of a markdown file).
   *  Mutually exclusive with `restore_bundle`; the single-file watcher is
   *  already running by the time this returns. */
  standalone_file: FileContent | null;
}

export function getStartupState(): Promise<StartupState> {
  return invoke("get_startup_state");
}

// Window commands
export function showMainWindow(): Promise<void> {
  return getCurrentWindow().show();
}

/** Request a close of this window. Goes through the close-requested event,
 *  so the main window is hidden rather than destroyed (`lib.rs`). */
export function closeWindow(): Promise<void> {
  return getCurrentWindow().close();
}

// Image commands
export function saveClipboardImage(
  markdownFilePath: string,
  imageData: number[],
  format: string,
): Promise<{ relative_path: string; absolute_path: string }> {
  return invoke("save_clipboard_image", { markdownFilePath, imageData, format });
}

export type AgentEvent =
  | { type: "started"; processId: string }
  | { type: "claude"; line: string }
  | { type: "stderr"; message: string }
  | { type: "edit_start"; requestId: string; toolUseId: string | null; path: string }
  | { type: "exit"; code: number | null };

export function claudeStart(
  root: string,
  epoch: number,
  resumeSessionId: string | null,
  notePath: string,
  plan: boolean,
  onEvent: import("@tauri-apps/api/core").Channel<AgentEvent>,
): Promise<string> {
  return invoke("claude_start", {
    root,
    epoch,
    resumeSessionId,
    notePath: documentPath(notePath),
    plan,
    onEvent,
  });
}
export function claudeSend(processId: string, line: string, files: string[]): Promise<void> {
  return invoke("claude_send", { processId, line, files });
}
export function claudeStop(processId: string): Promise<void> {
  return invoke("claude_stop", { processId });
}

export function claudeCapabilities(root: string): Promise<Capabilities> {
  return invoke("claude_capabilities", { root });
}

export function claudeDecidePermission(
  processId: string,
  requestId: string,
  allow: boolean,
  always: boolean,
): Promise<void> {
  return invoke("claude_decide_permission", { processId, requestId, allow, always });
}
/** The user's reply to a question (`answers` keyed by question text, `null` declines) or a plan. */
export type HostAnswer =
  | { kind: "questions"; answers: Record<string, string> | null }
  | { kind: "plan"; approve: boolean; feedback: string | null };
export function claudeAnswer(
  processId: string,
  requestId: string,
  answer: HostAnswer,
): Promise<void> {
  return invoke("claude_answer", { processId, requestId, answer });
}
/** Tools saved with "don't ask again", in every workspace. */
export function coWriterAllowedTools(): Promise<string[]> {
  return invoke("co_writer_allowed_tools");
}
/** Returns the tools still allowed. */
export function revokeCoWriterTool(tool: string): Promise<string[]> {
  return invoke("co_writer_revoke_tool", { tool });
}
export function setPendingApprovals(count: number): Promise<void> {
  return invoke("set_pending_approvals", { count });
}
export function claudeEditReady(
  processId: string,
  requestId: string,
  allow: boolean,
): Promise<void> {
  return invoke("claude_edit_ready", { processId, requestId, allow });
}
