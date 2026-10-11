import { useFeedbackStore, EMPTY_FEEDBACK_ITEMS, type FeedbackItem } from "@/stores/feedback-store";
import { useClaudeStore, chatForPath } from "@/stores/claude-store";

export type { FeedbackItem };
export const useFeedbackLoaded = () => useFeedbackStore((state) => state.loaded);
export const useFeedbackError = (path: string | null) =>
  useFeedbackStore((state) => state.error ?? (path ? (state.turnErrors[path] ?? null) : null));
export const useDocumentFeedback = (path: string | null) =>
  useFeedbackStore((state) =>
    path ? (state.byPath[path] ?? EMPTY_FEEDBACK_ITEMS) : EMPTY_FEEDBACK_ITEMS,
  );
const store = () => useFeedbackStore.getState();
export const removeFeedback = (path: string, id: string) => store().remove(path, id);
export const clearAttachedFeedback = (path: string) => store().clearAttached(path);
export const consumeFeedback = (path: string, ids: string[]) => store().consume(path, ids);
export const saveFeedbackNotes = (path: string, text: string) => store().saveNotes(path, text);
export const takeBackFeedback = (path: string, id: string) => store().takeBack(path, id);
export const acknowledgeFeedback = (path: string, id: string) => store().acknowledge(path, id);
export const retryFeedbackPersistence = () => store().retryPersistence();
export const dismissFeedbackError = (path: string) => store().dismissError(path);

export const canApplyFeedback = (item: FeedbackItem) =>
  item.status === "pending" && item.anchor.attached && !item.reviewRequired;

export async function applyFeedback(path: string, ids: string[]) {
  const claude = useClaudeStore.getState();
  const chat = chatForPath(claude.chats, path);
  if (chat.status === "running" || chat.status === "stopping") return;
  try {
    const batch = store().begin(path, ids);
    let settled = false;
    const complete = (outcome: Parameters<ReturnType<typeof store>["complete"]>[1]) => {
      if (settled) return;
      settled = true;
      store().complete(batch, outcome);
    };
    const sent = await claude.send(
      path,
      batch.items.length === 1 ? "Apply this note" : `Apply my ${batch.items.length} notes`,
      {
        turn: { path, prepare: (disk) => store().prepare(batch, disk), complete },
        attachments: batch.items.map((item) => ({
          anchor: item.anchor,
          quote: item.quote,
          note: item.feedback,
        })),
      },
    );
    if (
      !sent &&
      !settled &&
      chatForPath(useClaudeStore.getState().chats, path).status !== "stopping"
    )
      complete({
        status: "failed",
        changed: false,
        error:
          chatForPath(useClaudeStore.getState().chats, path).error ?? "Could not send your notes.",
      });
  } catch (error) {
    useFeedbackStore.setState((state) => ({
      turnErrors: {
        ...state.turnErrors,
        [path]: error instanceof Error ? error.message : String(error),
      },
    }));
  }
}
