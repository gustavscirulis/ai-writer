import { useSyncExternalStore } from "react";
import { useClaudeStore, EMPTY_CHAT, type Chat } from "@/stores/claude-store";
import { useSettingsStore } from "@/stores/settings-store";
import { isAgentEditing, subscribeAgentEditing } from "@/lib/agent-turn";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
import type { ChatAttachment } from "@/lib/claude-stream";
const chatFor = (chats: Record<string, Chat>, path: string | null) =>
  (path && chats[path]) || EMPTY_CHAT;
export function useHasChatMessages(path: string | null) {
  return useClaudeStore((s) => chatFor(s.chats, path).messages.length > 0);
}
export function useChatActivity() {
  return useClaudeStore((s) => s.activity);
}
export function useChatMessages(path: string | null) {
  return useClaudeStore((s) => chatFor(s.chats, path).messages);
}
/** Whether the current or most recent turn, with its errors and notices, belongs to this note. */
export function useOwnsChatTurn(path: string | null) {
  return useClaudeStore((s) => s.chatPath === path);
}
export function useChatStatus() {
  return useClaudeStore((s) => s.status);
}
export function useToolPermissions() {
  return useClaudeStore((s) => s.permissions);
}
export const decideToolPermission = (id: string, allow: boolean) =>
  useClaudeStore.getState().decidePermission(id, allow);
export function useChatNotices() {
  return useClaudeStore((s) => s.notices);
}
export function useChatError() {
  return useClaudeStore((s) => s.error);
}
export function useAgentEditing() {
  return useSyncExternalStore(subscribeAgentEditing, isAgentEditing);
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

let composerInput: HTMLTextAreaElement | null = null;
let focusRequested = false;
/** Callback ref for the composer field; honours a focus request made before the panel mounted. */
export function registerChatComposer(input: HTMLTextAreaElement | null) {
  composerInput = input;
  if (input && focusRequested) {
    focusRequested = false;
    input.focus({ preventScroll: true });
  }
}
export function focusChatComposer() {
  if (composerInput?.isConnected) composerInput.focus({ preventScroll: true });
  else focusRequested = true;
}
export function setChatPanelWidth(width: number) {
  return useSettingsStore.getState().setSetting("appearance.agent-panel-width", width);
}
export const sendChat = (text: string, attachments?: ChatAttachment[]) =>
  useClaudeStore.getState().send(text, { attachments });
export const stopChat = () => useClaudeStore.getState().stop();
export const newChat = (path: string) => useClaudeStore.getState().newChat(path);
export const rewriteChatPaths = (root: string, from: string, to: string, isDir: boolean) =>
  useClaudeStore.getState().rewriteChatPaths(root, from, to, isDir);

export function useChatDraft(path: string | null) {
  return useClaudeStore((s) => chatFor(s.chats, path).draft);
}
export function setChatDraft(path: string, draft: string) {
  useClaudeStore.getState().setDraft(path, draft);
}
export function clearChatDraftIfUnchanged(path: string, draft: string) {
  if (chatFor(useClaudeStore.getState().chats, path).draft === draft) setChatDraft(path, "");
}
const subscribeWidth = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};
export function useViewportWidth() {
  return useSyncExternalStore(subscribeWidth, () => window.innerWidth);
}
