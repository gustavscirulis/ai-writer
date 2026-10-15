# @ mentions in Co-writer

Typing `@` in the Co-writer composer lists notes in the workspace. Picking one writes `@Name` into the message as a pill and attaches the note, so Claude reads it before answering. It's a faster way to do what the paperclip does, without leaving the sentence.

## Menu

The menu opens while the caret sits right after `@` and a word with no spaces, where the `@` starts the draft or follows whitespace. It works anywhere in the message, so `email@example.com` doesn't open it but `match @sty` does.

- `@` on its own lists recent notes, leaving out the note the chat belongs to.
- `@word` lists notes from the workspace index, the same search ⌘P uses. Hyphens match spaces, so `@style-gu` finds "Style guide".
- Each row shows the note's name and, muted, its folder.
- ↑/↓ move, Enter or Tab pick, and Escape closes the menu until the draft or the caret moves. Clicking a row also picks it. The textarea keeps focus and drives the list through `aria-activedescendant`.
- Only Markdown notes are listed, because only they are indexed. Other files still go through the paperclip, paste or drop.

The `/` skills menu takes precedence when both could open, which only happens for a draft like `/@x`.

## Picking

Picking replaces `@word` with `@Name ` and puts the caret after it. The name is the note's file name without `.md`, or its path in the workspace when two notes share a name, as with `[[` links. The note is resolved like any other [attached file](chat-file-attachments.md), with the same file error line, then recorded in `Chat.mentions` and added to `Chat.files`.

## Pills

A mentioned note shows as a pill around its `@Name` in the message, not as a chip above it. The textarea stays a textarea: `MentionBackdrop` draws the pills behind its transparent background with the same text metrics and scroll offset.

- Backspace right after a pill, or Delete right before one, removes the whole pill.
- The caret can't stop inside a pill. Arrow keys jump over it, and a click inside moves the caret to the nearer edge.
- The pill decides what Claude reads. `Chat.mentions` keeps a note only while its `@Name` stands in the draft as a whole word, so deleting the pill, or editing its text in any other way, detaches the note too.
- Right after a one-word pill the caret also reads as `@word`; that doesn't open the menu.

## Sending

Nothing changes on send: the files go out in `writer_context.files` and Claude may Read them without a prompt that turn. The system prompt tells Claude that `@Name` in the message refers to the attached file with that name.

## In the thread

Sending records the draft's mentions on the user message (`ChatMessage.mentions`, saved with the chat), so the sent text shows each `@Name` as the same pill. Clicking one opens the note. Mentioned notes don't repeat as chips under the message; other attached files still do. Messages without mentions, including ones sent before this, render as before.

## Limits

- Queued messages carry no files (see [the queue](chat-queue.md)). Queuing a message with mentions turns them into ordinary chips that stay in the composer, and the queued text keeps only `@Name`.
- Replacing the pill programmatically resets the textarea's undo history, so ⌘Z doesn't bring a deleted pill back.
- No workspace, no menu.

## Validation

Helper tests cover when the query opens, where the mention goes, finding pills, deleting them and moving the caret out of them. Store tests cover a note leaving with its pill, a sent message keeping its mentions and a failed send putting them back. Render tests cover the menu markup and pills in a sent message. `e2e/specs/co-writer-mentions.spec.js` picks a seeded note in the built app, checks the pill and that no chip shows, removes the pill with one Backspace, and sends a mention to check the pill in the thread.
