# Persist Chat across restarts

## Problem

Chat messages lived only in memory, so quitting Writer emptied every note's thread. The saved Claude Code session IDs didn't survive either: `Settings::new` ran a legacy theme migration on every window start that deleted `preferences.json`. That is the plugin-store file holding session IDs, feedback notes and pinned files.

## Behaviour

- Reopening a workspace shows each note's previous Chat thread. Sending continues the same Claude Code session (`--resume`).
- New chat clears the saved thread. Moving or renaming a note moves its thread.
- The thread is saved when you send (so a crash keeps your message) and when the turn ends (completed, failed or stopped). Quitting already stops running turns through `stopAll`, which saves them.
- A tool that never finished is shown as failed after a restart instead of running forever.
- If Claude Code no longer has the session (its transcripts expire, `cleanupPeriodDays`), the CLI returns `No conversation found with session ID` before `init`. Chat keeps the thread and shows: "This conversation can't be continued in Claude Code any more. Start a new chat to keep going."
- Drafts, notices, approvals, activity and errors stay in memory only.

## Storage

- `chats.json` in the app data dir, a dedicated plugin-store file, so transcripts don't get rewritten with every preference and don't live in the vault.
- One key per note: `${root}\0${canonicalNotePath}`. The root is part of the key because Claude Code sessions belong to the directory they ran in, so a nested workspace must not reuse them.
- Value: `{ version: 1, sessionId, messages }`. The session ID and the visible thread form one record, so they can't drift apart. Records with an unknown version are ignored and logged.
- All writes go through the serialized `updateChats` queue. Only changed keys are written, followed by one save.
- A failed session-ID write keeps the note locked for recovery, as before. A failed transcript write at turn end is reported in Chat without locking the note.
- The legacy `workspace:${root}:agent:claude-sessions` preference is no longer read. Because of the deletion bug it was already empty after every restart.

## Validation

`tests/claude-store.test.ts` covers:

- restoring and resuming a session
- marking interrupted tools
- saving on send and at turn end
- rekeying on move and deleting on New chat
- the expired-session message
