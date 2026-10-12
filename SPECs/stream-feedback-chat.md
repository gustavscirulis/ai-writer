# Stream: feedback and chat in one column

Chosen from the browser prototype in [`unified-feedback-chat-prototype.md`](unified-feedback-chat-prototype.md) ("Stream", with the paragraph button on the right). It replaces the separate Feedback column of [`paragraph-feedback.md`](paragraph-feedback.md).

## Contract

There is no feedback mode. Writing and pointing at text happen in the same editor, and Chat is the only side panel.

Pointing at text:

- Selecting text inside one block shows an "Add to chat ⌘L" pill above it. The pill, the selection's right-click "Add to chat" action, or ⌘L adds the selection to the composer as a quote chip. A selection across blocks adds each block it touches. With only a caret, ⌘L adds the block at the caret.
- Hovering a block shows a comment button to the right of the text column, level with the block's first line. Clicking it, or ⌥-clicking the block, adds the whole block.
- Adding a chip opens Chat, focuses the composer and collapses the selection. The same chip is never added twice.
- The command palette has "Add Selection to Chat", which does the same as ⌘L.

The composer:

- Enter sends the message with its chips. Claude makes the change now, and the user message shows the attachments. While Claude is replying, Enter queues instead; see [Chat queue](chat-queue.md).
- The message draft clears immediately when the send is accepted. Failed delivery restores it only if the same attempt still owns an empty draft; see [composer send lifecycle](chat-composer-send.md).
- ⌘Enter queues the draft as one note per chip, or as one plain message without chips, without calling Claude.
- Backspace on an empty draft removes the last chip, and Esc clears all chips.
- Hovering a chip, a saved note or a message attachment highlights its text in the editor.

Saved notes (the queue, see [Chat queue](chat-queue.md)):

- Saved notes show as a dotted underline on their text, with a count dot right of the block. The dot swaps for the comment button while the block is hovered.
- A tray above the composer reads "N queued", with Send or Send all. Queued items also send by themselves after every clean turn.
- Clicking a note moves it back into the composer as a chip plus its text, for editing. × removes it.
- Sending the queue sends every ready item as one message. A clean finish removes them, even if the note didn't change. Stop and failure keep them and pause the queue. If a turn changed the note but failed, its notes need a "Keep" before they can be sent again.

Anchors:

- Chips and notes map through edits and are recovered on reload, as before.
- Notes whose text can't be found show "Text changed · click to re-point". Taking such a note back lets the user point at new text.
- Notes persist per workspace, version 2. Chips do not persist.
- Attachment line numbers sent to Claude refer to the saved file, including frontmatter.

## Implementation

- The feedback store (`stores/feedback-store.ts`) owns every chip and note. Its statuses are `attached`, `pending` and `running`.
- `hooks/feedback-api.ts` is the imperative entry point used by the editor, the palette and the composer.
- `components/editor-area/feedback-extension.ts` holds:
  - the selection pill, a tooltip StateField;
  - the gutter overlay and marks, a ViewPlugin appended to `view.dom`, because the scroller clips at the text column;
  - the ⌘L keymap.
- `claude-store.send(path, text, { turn, attachments })` turns attachments into `{fromLine, toLine, text}` context and keeps them on the user message. `applyFeedback` uses the same path, with a turn that prepares and completes the batch.
- Batches and outcome errors belong to their canonical note. Applying A does not block B; a no-op/failure on A cannot clear B's notes or errors. Reconciliation reads only the turn's target. Persistence errors remain workspace-wide.
- `components/claude-panel/notes-tray.tsx` and `composer.tsx` are the UI. The Feedback panel, its button and its layout rules are removed.

## QA

- Playground (`?full`):
  - hover button position and click;
  - ⌥-click;
  - pill and ⌘L quote chip;
  - note underline and count dot.
- Chat panel rendered against seeded stores on the desktop dev server:
  - chips;
  - tray, collapsed and open;
  - message quote and note attachments.
- Native Tauri QA is still pending: a real Claude turn applying notes, and reload recovery.
