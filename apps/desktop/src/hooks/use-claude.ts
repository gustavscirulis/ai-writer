import { getActiveFilePath } from "@/hooks/editor-api";
import { useSyncExternalStore } from "react";
import { useClaudeStore, chatForPath } from "@/stores/claude-store";
import { useSettingsStore } from "@/stores/settings-store";
import { isAgentEditing, subscribeAgentEditing, documentPath } from "@/lib/agent-turn";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import type { SendOptions } from "@/lib/agent-request";
import { readPastedImage } from "@/lib/pasted-image";
import * as tauri from "@/lib/tauri";
export function useHasChatMessages(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).messages.length > 0);
}
export function useChatActivity(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).activity);
}
export function useChatMessages(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).messages);
}
export function useChatStatus(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).status);
}
export function useToolPermissions(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).permissions);
}
export const decideToolPermission = (path: string, id: string, allow: boolean, always = false) =>
  useClaudeStore.getState().decidePermission(path, id, allow, always);
export const answerRequest = (path: string, id: string, answer: tauri.HostAnswer) =>
  useClaudeStore.getState().answer(path, id, answer);
export function useChatNotices(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).notices);
}
export function useChatError(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).error);
}
export function useAgentEditing(path: string) {
  return useSyncExternalStore(subscribeAgentEditing, () => isAgentEditing(path));
}
const defaultVisible = SETTINGS_SCHEMA.find((def) => def.key === "appearance.agent-panel-visible")!
  .default as boolean;
const defaultWidth = SETTINGS_SCHEMA.find((def) => def.key === "appearance.agent-panel-width")!
  .default as number;
export function useChatPanelVisible() {
  return useSettingsStore((s) => {
    const value = s.settings["appearance.agent-panel-visible"];
    return typeof value === "boolean" ? value : defaultVisible;
  });
}
export function useChatPanelWidth() {
  return useSettingsStore((s) => {
    const value = s.settings["appearance.agent-panel-width"];
    return typeof value === "number" && Number.isFinite(value) ? value : defaultWidth;
  });
}
export function toggleChatPanel() {
  const store = useSettingsStore.getState();
  void store.setSetting(
    "appearance.agent-panel-visible",
    !(store.settings["appearance.agent-panel-visible"] ?? defaultVisible),
  );
}
export function showChatPanel() {
  const store = useSettingsStore.getState();
  if ((store.settings["appearance.agent-panel-visible"] ?? defaultVisible) !== true)
    void store
      .setSetting("appearance.agent-panel-visible", true)
      .catch((error) => console.error("[chat] Could not open chat panel", error));
}

let composer: { path: string; input: HTMLTextAreaElement } | null = null;
let focusRequested: string | null = null;
export function registerChatComposer(path: string | null, input: HTMLTextAreaElement | null) {
  composer = input && path ? { path: documentPath(path), input } : null;
  if (composer && focusRequested === composer.path) {
    focusRequested = null;
    composer.input.focus({ preventScroll: true });
  }
}
export function focusChatComposer(path = getActiveFilePath()) {
  if (!path) return;
  const key = documentPath(path);
  if (composer?.path === key && composer.input.isConnected)
    composer.input.focus({ preventScroll: true });
  else focusRequested = key;
}
export function setChatPanelWidth(width: number) {
  return useSettingsStore.getState().setSetting("appearance.agent-panel-width", width);
}
export const sendChat = (
  path: string,
  text: string,
  options?: Pick<SendOptions, "attachments" | "feedbackIds" | "files">,
) => useClaudeStore.getState().send(path, text, options);
export const stopChat = (path: string) => useClaudeStore.getState().stop(path);
export const newChat = (path: string) => useClaudeStore.getState().newChat(path);
export const rewriteChatPaths = (root: string, from: string, to: string, isDir: boolean) =>
  useClaudeStore.getState().rewriteChatPaths(root, from, to, isDir);

export function useChatFiles(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).files);
}
export function useChatFileError(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).fileError);
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Resolves picked, pasted or dropped paths; a failure is shown above the composer. */
export async function attachChatFiles(path: string, paths: string[]) {
  if (!paths.length) return;
  const store = useClaudeStore.getState();
  try {
    store.addFiles(path, await tauri.resolveChatFiles(paths));
  } catch (error) {
    store.setFileError(path, errorText(error));
  }
  focusChatComposer(path);
}
export async function pickChatFiles(path: string) {
  try {
    await attachChatFiles(path, await tauri.pickChatFiles());
  } catch (error) {
    useClaudeStore
      .getState()
      .setFileError(path, `Could not open the file picker: ${errorText(error)}`);
  }
}
export async function pasteChatImage(path: string, file: File) {
  const store = useClaudeStore.getState();
  try {
    const image = await readPastedImage(file);
    if (!image.ok) return store.setFileError(path, image.error);
    store.addFiles(path, [await tauri.saveChatImage(image.imageData, image.format)]);
  } catch (error) {
    store.setFileError(path, `Could not paste the image: ${errorText(error)}`);
  }
}
export const removeChatFile = (path: string, file: string) =>
  useClaudeStore.getState().removeFile(path, file);
export const dismissChatFileError = (path: string) =>
  useClaudeStore.getState().setFileError(path, null);

export function useChatDraft(path: string | null) {
  return useClaudeStore((s) => chatForPath(s.chats, path).draft);
}
export function setChatDraft(path: string, draft: string) {
  useClaudeStore.getState().setDraft(path, draft);
}
const subscribeWidth = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};
export function useViewportWidth() {
  return useSyncExternalStore(subscribeWidth, () => window.innerWidth);
}

export function useChatIndicator(path: string | null) {
  return useClaudeStore((state) => {
    const chat = chatForPath(state.chats, path);
    return chat.error
      ? "error"
      : chat.permissions.length
        ? "approval"
        : chat.status === "running" || chat.status === "stopping"
          ? "running"
          : null;
  });
}
