# Version History Spec

## Summary

Every workspace note gets durable version history, in the style of Google Docs. A clock button at the top right, which moves into the Co-writer header while Co-writer is open (or ⌘⇧H, or "Show Version History" in the command palette) opens a timeline dock along the bottom of the note. Selecting a version shows a read-only preview of the note at that point, with what that version changed highlighted inline. ←/→ (or ↓/↑) steps between versions, Esc closes, and "Restore" brings an earlier version back as a new "Restored" version.

## Storage

- Versions live inside the vault, so they travel and sync with it: `{root}/.writer/history/{relative note path}/{created_ms}-{source}.md`.
- Each file is the note's full text, so it can be recovered by hand. Its mtime is the version's "last updated" time.
- `source` is `user | agent | restore | external`. There is no index file, so a sync conflict can only duplicate a version.
- Only `.md` notes under the workspace root, with no hidden path component, have history. Standalone and compact windows without a root have none.
- The watcher ignores `.writer/history/**`. Directory walkers and Claude's scope already skip hidden folders.

## Recording

`history::record` (Rust, `src-tauri/src/history.rs`) is the one write path:

- Content identical to the latest version is never recorded again.
- User saves are coalesced into the latest `user` version while it was updated less than 5 minutes ago and created less than 60 minutes ago.
- Agent writes from the same Claude turn coalesce into one version, keyed by turn id (`WorkspaceState.history_groups`). Only a capture that records something moves the group: a recorded agent write sets it, and any other recorded version clears it. The no-op baseline taken before each Claude edit therefore doesn't split a turn.
- `restore` and `external` versions are always new, and any non-user version ends the current user run.

Capture points:

- `write_file` records every user save.
- The frontend calls `history_capture` (which reads the file from disk itself):
  - after a note loads, as an `external` baseline (a no-op when unchanged);
  - before each Claude edit, after saving, as an `external` baseline;
  - after each Claude edit is reloaded, as `agent`, grouped by turn;
  - after a watcher reload, as `external`.
- `history_restore` writes the old content as a self-write and records it as `restore`.
- `rename_entry` moves a file's or folder's history along with it, merging into any history already at the target.

Every change emits `history:changed { path }`, and the open dock refreshes.

## Retention

Pruning runs on workspace open, after indexing. Per note:

| Age            | Kept                        |
| -------------- | --------------------------- |
| Under 24 hours | Everything                  |
| Under 7 days   | The newest version per hour |
| Under 90 days  | The newest version per day  |
| Older          | The newest version per week |

`agent` and `restore` versions and the newest version are never pruned.

## UI

- **Dock** (`components/version-history/history-dock.tsx`):
  - Sits at the bottom of the editor pane, as wide as the text column and flush with the window edge. Co-writer stays open beside it.
  - The top row names the selected version ("Current version 14:46", or "Yesterday, 12:52"), tagged "Co-writer" or "Restored". "Back to now" and "Restore" appear only on an earlier version.
  - Below it, a tick track runs oldest to newest, with day labels under the first version of each day (`version-timeline.ts`). Co-writer's versions are orange, versions after the selected one fade, and hovering a tick shows its time. Hovering a tick makes it grow and dims the rest. When versions sit closer than 8px apart (`isCrowded`), a fisheye lens also follows the pointer, as in the macOS Dock (`magnify` in `version-timeline.ts`). Ticks near it spread apart so a note with hundreds of versions stays readable; a note with a few versions keeps its ticks still. Keyboard steps don't use the lens.
  - Click or drag on the track to scrub, ←/→ or ↓/↑ to step, Home/End for the oldest and current version, and Esc to close. The track takes focus when the dock opens.
  - The dock closes when the active tab shows another note.
- **Motion** (`version-history.css`): the dock rises in over 280ms, and its row and track follow 60ms and 120ms later, fading up from a 4px blur. Closing is a shorter 150ms drop and fade, so the store keeps the last versions after `close` for the dock to leave with. The pointer lens swells in over 340ms and settles back over 420ms, on a sine ease in `use-lens-strength.ts`. Tick positions are set every frame rather than transitioned, so they never trail the pointer. The playhead and the tooltip glide between ticks, but the playhead rides with its tick while the lens is on. Back to now and Restore cross-fade in place. While you scrub through versions faster than every 300ms, the preview skips the highlight fade and scrolls instantly. Each version's diff highlights fade in, and the preview scrolls to the first change, smoothly after the first version. Reduced motion keeps only the fades.
- **Preview** (`history-preview.tsx`):
  - An overlay over the editor pane. The live editor stays mounted underneath but is made invisible, because the window background is translucent.
  - It uses its own read-only `EditorView` with a reduced extension set (see [docs/editor.md](../docs/editor.md)) and `@codemirror/merge`'s `unifiedMergeView`.
  - The selected version is diffed against the version before it, and the preview scrolls the first change to the top of the clear zone. Extra space at the end lets the last lines scroll clear of the dock.
- **Restore:** taken under the agent-editing lock after saving, and applied to every open alias as one undoable step through the agent reload path. Restore is blocked while a Claude turn is active on the note.

## Known limits

- Only the body is diffed; frontmatter changes don't show in the preview.
- Deleted chunks render as raw markdown.
- Notes moved or renamed outside Writer lose their history link.
- In git-tracked vaults, `.writer/history` shows up as untracked unless ignored.
