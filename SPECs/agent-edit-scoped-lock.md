# Lock the note only while the AI is editing it

A Chat turn used to make its note read-only from Send until the turn finished, including all the time Claude spent thinking, reading, searching and waiting for approvals. The writer should be able to keep typing during all of that. The note should lock only while Claude is applying an Edit or Write to it, and the editor should show a wait (beach-ball) cursor during that window.

## Behaviour

- Send saves the note so Claude reads the latest text, then leaves it editable. The turn still owns the note for moves/renames (the native edit scope is bound to its canonical path), tab pruning and duplicate sends.
- Claude's Edit/Write calls already pass through Writer's native PreToolUse hook. When that hook allows an edit to the assigned note, or the user approves one to another note ([`chat-edit-other-notes.md`](chat-edit-other-notes.md)), the Rust actor holds the reply and emits `edit_start { requestId, toolUseId, path }` with the canonical target.
- The UI then locks the note (CodeMirror read-only, store writes blocked, frontmatter fieldset disabled), saves every alias, records the saved text and answers `claude_edit_ready(processId, requestId, allow)`. Only then does the CLI run the tool. If the save fails, the edit is denied with a message telling Claude to re-read, and a Chat notice explains why.
- The `tool_result` matching `toolUseId` reloads the note from disk while it is still locked, reconciles feedback anchors, then unlocks. A failed reload keeps the lock; Stop retries it. Stop or exit during an edit reloads and unlocks in the same way.
- A Chat turn reports `changed` if any of its edits changed the note.
- While locked, `.cm-editor[data-agent-editing]` and the disabled frontmatter fieldset use `cursor: wait`.

## Safety

If the writer edits the note after Claude read it, Claude Code's own check rejects a stale Edit/Write ("File content has changed since it was last read"), and Claude re-reads. A probe against Claude Code 2.1.296 confirmed this for a save made inside the hook window. The PreToolUse hook timeout is 60s so a slow save cannot let the tool run without a reply.

## Validation

- Rust: deferred hook replies, allow/deny via `EditReady`, immediate denials for other paths, and an actor test that the CLI receives nothing until the UI is ready.
- Store tests: notes stay editable while thinking; edits save before release; reload and unlock on the matching tool result; Stop mid-edit; save failure denies the edit; moves are still refused mid-turn.
- Editor test: the wait-cursor marker follows the lock.
