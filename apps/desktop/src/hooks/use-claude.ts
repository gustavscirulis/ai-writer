import { useSyncExternalStore } from "react";
import { useClaudeStore } from "@/stores/claude-store";
import { useSettingsStore } from "@/stores/settings-store";
import { isAgentEditing, subscribeAgentEditing } from "@/lib/agent-turn";
import { SETTINGS_SCHEMA } from "@/lib/settings-schema";
export function useHasChatMessages() {
  return useClaudeStore((s) => s.messages.length > 0);
}
export function useChatActivity() {
  return useClaudeStore((s) => s.activity);
}
export function useChatMessages() {
  return useClaudeStore((s) => s.messages);
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
export function setChatPanelWidth(width: number) {
  return useSettingsStore.getState().setSetting("appearance.agent-panel-width", width);
}
export const sendChat = (text: string) => useClaudeStore.getState().send(text);
export const stopChat = () => useClaudeStore.getState().stop();
export const newChat = () => useClaudeStore.getState().newChat();

export function useChatDraft() {
  return useClaudeStore((s) => s.draft);
}
export function setChatDraft(draft: string) {
  useClaudeStore.getState().setDraft(draft);
}
export function clearChatDraftIfUnchanged(draft: string) {
  if (useClaudeStore.getState().draft === draft) setChatDraft("");
}
const subscribeWidth = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};
export function useViewportWidth() {
  return useSyncExternalStore(subscribeWidth, () => window.innerWidth);
}
