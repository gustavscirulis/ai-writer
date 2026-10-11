import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import {
  beginFeedbackClose,
  flushAllFeedbackPersistence,
  resumeFeedbackPersistence,
} from "@/stores/feedback-store";
import { useClaudeStore } from "@/stores/claude-store";

/** Window-scoped save participant; round IDs reject canceled/stale acknowledgments. */
export function useFeedbackPersistence() {
  useEffect(() => {
    let disposed = false;
    let requestId: number | null = null;
    let queue = Promise.resolve();
    const windowHandle = getCurrentWebviewWindow();
    const resumed = windowHandle.listen<number>("feedback:resume-after-close", (event) => {
      resumeFeedbackPersistence(`window:${event.payload}`);
      if (requestId === event.payload) requestId = null;
    });
    const registration = windowHandle.listen<number>("feedback:flush-before-close", (event) => {
      const id = event.payload;
      requestId = id;
      beginFeedbackClose(`window:${id}`);
      queue = queue
        .catch(() => {})
        .then(async () => {
          if (disposed || requestId !== id) return;
          beginFeedbackClose(`window:${id}`);
          try {
            // Stop owns reconciliation; no lifecycle edits can arrive after our ACK.
            await useClaudeStore.getState().stopAll();
            if (requestId !== id) return;
            await flushAllFeedbackPersistence(`window:${id}`);
            if (requestId === id)
              await invoke("feedback_persistence_ack", { requestId: id, success: true });
          } catch (error) {
            if (requestId !== id) return;
            resumeFeedbackPersistence(`window:${id}`);
            window.alert(
              `Could not save feedback: ${error instanceof Error ? error.message : String(error)}. Writer has stayed open.`,
            );
            await invoke("feedback_persistence_ack", { requestId: id, success: false });
          }
        });
    });
    void Promise.all([registration, resumed])
      .then(async ([unlisten]) => {
        if (disposed) unlisten();
        else await invoke("feedback_persistence_ready");
      })
      .catch((error: unknown) => {
        window.alert(
          `Could not register feedback saving on close: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return () => {
      disposed = true;
      if (requestId !== null) resumeFeedbackPersistence(`window:${requestId}`);
      requestId = null;
      void registration.then((unlisten) => unlisten());
      void resumed.then((unlisten) => unlisten());
    };
  }, []);
}
