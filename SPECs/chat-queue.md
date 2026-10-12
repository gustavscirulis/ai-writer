# Chat queue

Saved notes and queued messages are one system: the feedback store's `pending` items. Enter sends now; ⌘Enter queues, whether or not Claude is running. Enter while the note's turn is running also queues.

## Contract

- **Queueing**
  - ⌘Enter with chips queues one note per chip, as before.
  - ⌘Enter without chips queues one plain message, an item with `anchor: null`.
  - Enter while Claude is replying does the same as ⌘Enter.
  - The Queue button appears whenever the draft has text.
- **Sending**
  - Every clean turn ends by sending the ready queue as one turn. A clean turn is a completed turn with no error and no Stop, whether it was a plain turn or a queue turn.
  - Ready means `pending`, not needing "Keep", and not detached ("Text changed · click to re-point"). Items that aren't ready stay in the tray.
  - The tray's Send / Send all, or ⌘Enter on an empty composer (no text, no chips), sends the queue by hand. It is disabled while a turn is running.
  - The bubble shows the plain messages, joined by blank lines, as its text, and the anchored notes as note attachments. A queue of only anchored notes keeps the "Apply this note" / "Apply my N notes" label.
  - The drain doesn't need the note's tab to be open.
- **Outcomes**
  - A clean finish removes the items it sent, even if the note didn't change. The sent bubble keeps their text.
  - Stop, failure or a rejected send returns them to `pending` and pauses the queue with a turn error ("Stopped. Your queue is paused."). Nothing auto-sends until the next clean turn or Send all.
  - A failed or stopped turn that changed the note still marks its items "Keep" (`reviewRequired`).
- **Editing**
  - Clicking an anchored note moves it back into the composer as a chip plus its text.
  - Clicking a plain message removes it and appends its text to the draft.
  - × removes either kind.
- **Persistence**
  - The queue persists per workspace (feedback data version 2, which now also accepts `null` anchors).

## Implementation

- `stores/feedback-store.ts` owns the items:
  - `saveNotes` queues plain messages.
  - `isQueueReady` decides what can be sent.
  - `prepare` builds the queue prompt. Anchored items keep their location fields; plain ones become `{id, message}`.
  - `complete` removes the items on any completed, error-free outcome.
- `stores/claude-store.ts` `sendQueue(path, ids?)` owns sending: it calls `begin` and sends a turn whose `prepare` and `complete` call back into the feedback store. `finish()` calls it after a turn that wasn't cancelled and had no error. `hooks/use-feedback.ts` `applyFeedback` forwards to it.
- UI: `components/claude-panel/composer.tsx` and `notes-tray.tsx`.

## Validation

- Feedback store suite: plain messages queue, persist, take back and prepare. A completed no-op clears its items.
- Chat store suite:
  - A clean turn drains everything queued during it as one merged turn, and nothing more.
  - Stop, an error result and an early exit pause the queue.
  - Detached notes are skipped.
  - The drain runs with the tab closed.
