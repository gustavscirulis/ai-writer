# @ mentions in Co-writer

Typing `@` in the Co-writer composer lists notes in the workspace. Picking one writes `@Name` into the message and attaches the note, so Claude reads it before answering. It's a faster way to do what the paperclip does, without leaving the sentence.

## Menu

The menu opens while the caret sits right after `@` and a word with no spaces, where the `@` starts the draft or follows whitespace. It works anywhere in the message, so `email@example.com` doesn't open it but `match @sty` does.

- `@` on its own lists recent notes, leaving out the note the chat belongs to.
- `@word` lists notes from the workspace index, the same search ⌘P uses. Hyphens match spaces, so `@style-gu` finds "Style guide".
- Each row shows the note's name and, muted, its folder.
- ↑/↓ move, Enter or Tab pick, and Escape closes the menu until the draft or the caret moves. Clicking a row also picks it. The textarea keeps focus and drives the list through `aria-activedescendant`.
- Only Markdown notes are listed, because only they are indexed. Other files still go through the paperclip, paste or drop.

The `/` skills menu takes precedence when both could open, which only happens for a draft like `/@x`.

## Picking

Picking replaces `@word` with `@Name ` and puts the caret after it. The name is the note's file name without `.md`, or its path in the workspace when two notes share a name, as with `[[` links. The note is added to the composer's files through `attachChatFiles`, so it gets a chip, de-duplication and the file error line like any other [attached file](chat-file-attachments.md).

The chip decides what Claude reads. Removing it leaves the `@Name` text, and deleting the text leaves the chip.

## Sending

Nothing changes on send: the files go out in `writer_context.files` and Claude may Read them without a prompt that turn. The system prompt tells Claude that `@Name` in the message refers to the attached file with that name.

## Limits

- Queued messages carry no files (see [the queue](chat-queue.md)), so a mention typed into a queued message leaves its note in the composer, and the queued text keeps only `@Name`.
- The sent message shows `@Name` as typed, with the file chips under it as usual.
- No workspace, no menu.

## Validation

Helper tests cover when the query opens and where the mention goes. A render test covers the menu markup. `e2e/specs/co-writer-mentions.spec.js` picks a seeded note in the built app and checks the text and the chip.
