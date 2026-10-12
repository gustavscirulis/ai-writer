import { useEffect, useSyncExternalStore } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getActiveFilePath } from "@/hooks/editor-api";
import { attachChatFiles } from "@/hooks/use-claude";
import { detectPlatform } from "@/lib/platform";
import * as tauri from "@/lib/tauri";

let dropActive = false;
const listeners = new Set<() => void>();
function setDropActive(value: boolean) {
  if (dropActive === value) return;
  dropActive = value;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
/** True while files are dragged over the Chat composer. */
export function useChatDropActive() {
  return useSyncExternalStore(subscribe, () => dropActive);
}

// Tauri types this as physical, but only WebView2 reports physical pixels; WKWebView/WebKitGTK report CSS points.
const scale = detectPlatform() === "windows" ? () => window.devicePixelRatio : () => 1;

function overChat(position: PhysicalPosition) {
  const { x, y } = position.toLogical(scale());
  return !!getActiveFilePath() && !!document.elementFromPoint(x, y)?.closest("[data-chat-drop]");
}

/** Routes every file drop in this window: onto Chat attaches, anywhere else opens. */
export function useFileDrop() {
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") {
        setDropActive(overChat(payload.position));
        return;
      }
      setDropActive(false);
      if (payload.type !== "drop" || !payload.paths.length) return;
      const path = overChat(payload.position) ? getActiveFilePath() : null;
      const task = path
        ? attachChatFiles(path, payload.paths)
        : tauri.openDroppedPaths(payload.paths);
      void task.catch((error) => console.error("[drop] Could not handle dropped files", error));
    });
    return () => {
      setDropActive(false);
      void unlisten.then((fn) => fn());
    };
  }, []);
}
