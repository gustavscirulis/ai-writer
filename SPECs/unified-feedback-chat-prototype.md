# Unified feedback and chat exploration

Decision: Stream, with the paragraph button right of the text. Promoted in [`stream-feedback-chat.md`](stream-feedback-chat.md); the prototype was removed.

Explore one shared writing-assistant surface, with text-selection and whole-paragraph feedback. This is an isolated, interactive browser prototype; do not change the existing desktop implementation until the user picks a direction.

Three directions:

- Thread: anchored feedback and conversation share one chronological thread and composer.
- Desk: feedback is a pinned revision tray above a conversation, with one composer.
- Margin: contextual feedback is composed beside the passage and collected in the shared conversation.

All directions support native drag selection, paragraph targeting in Feedback mode, keyboard targeting, clearing the target, saving/editing/removing feedback, applying one/all, undo, and general chat. Application and replies use local sample data, never invoke Claude or write a note. Shared sample content and state keep comparisons fair. A fixed prototype picker supports number/arrow keys, replay, and URL selection.

Acceptance: inspect all variants in the browser, exercise selections and paragraph clicks, verify saved feedback and apply/undo, check narrow windows and reduced motion, capture screenshots. Promotion remains a separate step after the user's choice.
