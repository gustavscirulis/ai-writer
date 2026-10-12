import {
  useFeedbackStore,
  EMPTY_FEEDBACK_ITEMS,
  isQueueReady,
  type FeedbackItem,
} from "@/stores/feedback-store";
import { useClaudeStore } from "@/stores/claude-store";

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
export const saveFeedbackNotes = (path: string, text: string) => store().saveNotes(path, text);
export const takeBackFeedback = (path: string, id: string) => store().takeBack(path, id);
export const acknowledgeFeedback = (path: string, id: string) => store().acknowledge(path, id);
export const retryFeedbackPersistence = () => store().retryPersistence();
export const dismissFeedbackError = (path: string) => store().dismissError(path);

export const canApplyFeedback = isQueueReady;
export const applyFeedback = (path: string, ids?: string[]) =>
  useClaudeStore.getState().sendQueue(path, ids);
