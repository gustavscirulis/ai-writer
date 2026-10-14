# Co-writer without an open note

Co-writer used to need an open note: on a "New tab" the panel showed "Open a note to start" and every control was disabled. Co-writer can create notes, so it now works with no note open too.

## Workspace conversation

- With no note active (a launcher tab), the panel shows one **workspace conversation** per workspace. Its chat key is the sentinel `WORKSPACE_CHAT` (`"writer:workspace"`, `lib/agent-turn.ts`). It isn't an absolute path, so it never matches a note, `documentPath` passes it through and moves never rewrite it.
- `useChatPath()` / `getChatPath()` (`hooks/use-claude.ts`) return the active note, or the sentinel. The panel, composer, message list, approvals, file drop and the panel's forced-open-on-approval check all use it.
- It's persisted like a note chat, as `${root}\0writer:workspace` in `chats.json`, and "New conversation" clears it.
- Launcher tabs show its indicator (spinner, approval, error), the same as note tabs.
- The empty state uses the blank-note copy and starters ("What are we writing?").
- Not available without a note: version history, and the queue (⌘↵, "Queue", Enter while busy). The queue holds note feedback, which is anchored to and reconciled against a note's text.

## Turn

- `send()` skips the open-file check, editor flushes and the `read_file` gate, passes `notePath: null` to `claude_start`, and leaves `openFile` out of `writer_context`. A queued (`options.turn`) send is refused.
- `claude_start` takes `note_path: Option<String>`. Without a note it claims nothing and `Scope.note` is `None`, so every Write/Edit is a "other note" target that needs approval (or skips it when the tool is always allowed). The appended system prompt replaces the "Edit the assigned openFile…" sentence with: no note is open; create a new Markdown note with Write when asked to write; edit existing notes only when asked.

## Carry-over to a created note

- In `beginEdit`, a workspace-chat run checks whether the target exists before the write is released (`Edit.created`). When a created note has been written, `reloadAfterEdit` records it as `run.createdNote` (the first one wins).
- At the end of the turn (`finish`), the chat, including its Claude Code session ID, moves from the sentinel to that note, in memory and in `chats.json`. Any stale record for that path is replaced.
- If the active tab is still a launcher, it's replaced by the note (`replaceTabWithFile`), so the conversation carries on beside its note. If the writer has moved to another note, tabs are left alone; the note is in the sidebar with its conversation.
- The next turn resumes the same session with the note as `openFile`, so it's edited without approval like any note's own chat.
- The move happens after the turn rather than when the note is written: re-keying a live run would touch the run map, native claims and streaming state.

## Validation

Rust: a scope without a note asks before every write, and the no-note prompt. Store: a workspace send starts without a note path, `openFile` or `read_file`; a created note takes over the conversation, session and launcher tab; editing an existing note doesn't move the chat; a created note doesn't take the tab after the writer has moved to another note.
