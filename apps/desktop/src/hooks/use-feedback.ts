import { useFeedbackStore, EMPTY_FEEDBACK_ITEMS, type FeedbackItem } from "@/stores/feedback-store";
import { useClaudeStore } from "@/stores/claude-store";

export type { FeedbackItem };
export const useFeedbackLoaded = () => useFeedbackStore((state) => state.loaded);
export const useFeedbackError = () => useFeedbackStore((state) => state.error);
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
export const dismissFeedbackError = () => store().dismissError();

export const canApplyFeedback = (item: FeedbackItem) =>
  item.status === "pending" && item.anchor.attached && !item.reviewRequired;

export async function applyFeedback(path: string, ids: string[]) {
  const claude = useClaudeStore.getState();
  if (claude.status === "running" || claude.status === "stopping") return;
  try {
    const batch = store().begin(path, ids);
    let settled = false;
    const complete = (outcome: Parameters<ReturnType<typeof store>["complete"]>[1]) => {
      if (settled) return;
      settled = true;
      store().complete(batch, outcome);
    };
    const sent = await claude.send(
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
    if (!sent && !settled && useClaudeStore.getState().status !== "stopping")
      complete({
        status: "failed",
        changed: false,
        error: useClaudeStore.getState().error ?? "Could not send your notes.",
      });
  } catch (error) {
    useFeedbackStore.setState({ error: error instanceof Error ? error.message : String(error) });
  }
}
