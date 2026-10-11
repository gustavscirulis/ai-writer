# Add selected text to Chat

Selected text must offer the same note workflow as the paragraph's Add to chat button. Reuse the existing attachment and composer path from [Stream feedback](stream-feedback-chat.md).

- Name the selection pill “Add to chat”, matching the paragraph action, and retain its ⌘L shortcut hint.
- Offer “Add to chat” in the editor's native context menu when text is selected. Call `attachFromEditor` with the current view, including after the native menu has blurred it; guard against disposed views.
- Preserve the selected quote for a selection within a block, and the existing per-block attachment behavior for selections spanning blocks.
- Open Chat and focus its composer. ⌘Enter saves the written note without sending a Claude request. Preserve existing selection collapse and attachment deduplication.
- No separate note editor or persistence path.

Validate context-menu availability/callback behavior and selection-to-attachment behavior with existing test infrastructure. Check the rendered selection action in the full playground when browser permission allows.
