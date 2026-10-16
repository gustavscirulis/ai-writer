import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { createSettingsTab, useEditorStore } from "@/stores/editor-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { getWorkspaceChromeMode } from "@/lib/compact-mode";
import { getEditorView } from "@/lib/editor-views";
import { copySelectionAsRichText } from "@/lib/rich-text-copy";
import { getActiveFilePath } from "@/hooks/editor-api";

// Native menu items that drive in-app navigation emit a Tauri event from the
// Rust menu handler. Add the (event-name → handler) pair here to subscribe;
// the hook below registers each entry once for the window's lifetime.
//
// Handlers must read store state at call time (`useStore.getState()`) rather
// than closing over hook callbacks, so the listener registration can stay
// stable across renders.
export const MENU_EVENT_HANDLERS: Record<string, () => void> = {
  "menu:open-preferences": openPreferences,
  "menu:copy-rich-text": copyRichText,
};

// Native menus blur the editor, so take the view from the registry, not focus.
function copyRichText() {
  const path = getActiveFilePath();
  const view = path ? getEditorView(path) : undefined;
  if (!path || !view) return;
  copySelectionAsRichText(view, path).catch((error: unknown) => {
    console.error("[menu] Copy as Rich Text failed", error);
  });
}

function openPreferences() {
  const { root, chromeMode } = useWorkspaceStore.getState();
  if (getWorkspaceChromeMode(root, chromeMode) === "compact-file") return;

  useEditorStore
    .getState()
    .openOrFocus((tab) => tab.location.kind === "settings", createSettingsTab);
}

export function useMenuEvents() {
  useEffect(() => {
    const unlistens = Object.entries(MENU_EVENT_HANDLERS).map(([event, handler]) =>
      listen(event, handler),
    );
    return () => {
      for (const p of unlistens) {
        void p.then((fn) => fn());
      }
    };
  }, []);
}
