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
      if (requestId !== event.payload) return;
      requestId = null;
      resumeFeedbackPersistence();
    });
    const registration = windowHandle.listen<number>("feedback:flush-before-close", (event) => {
      const id = event.payload;
      requestId = id;
      beginFeedbackClose();
      queue = queue
        .catch(() => {})
        .then(async () => {
          if (disposed || requestId !== id) return;
          beginFeedbackClose();
          try {
            // Stop owns reconciliation; no lifecycle edits can arrive after our ACK.
            await useClaudeStore.getState().stop();
            if (requestId !== id) return;
            if (useClaudeStore.getState().status === "stopping")
              throw new Error(
                useClaudeStore.getState().error ?? "Could not finish AI reconciliation.",
              );
            await flushAllFeedbackPersistence();
            if (requestId === id)
              await invoke("feedback_persistence_ack", { requestId: id, success: true });
          } catch (error) {
            if (requestId !== id) return;
            resumeFeedbackPersistence();
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
      requestId = null;
      void registration.then((unlisten) => unlisten());
      void resumed.then((unlisten) => unlisten());
    };
  }, []);
}
