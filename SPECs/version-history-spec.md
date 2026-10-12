# Version History Spec

## Summary

Every workspace note gets durable version history, in the style of Google Docs. A clock button at the top right, which moves into the Co-writer header while Co-writer is open (or ⌘⇧H, or "Show Version History" in the command palette) opens a list of versions on the right. Selecting a version shows a read-only preview of the note at that point, with what that version changed highlighted inline. ↑/↓ flips between versions, Esc closes, and "Restore this version" brings an earlier version back as a new "Restored" version.

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
- Agent writes from the same Claude turn coalesce into one version, keyed by turn id (`WorkspaceState.history_groups`).
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

Every change emits `history:changed { path }`, and the open panel refreshes.

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

- **Panel** (`components/version-history/history-panel.tsx`):
  - Takes Co-writer's slot and width while open; Co-writer comes back on close.
  - Versions are grouped under day headings. The first row is "Current version", and rows are tagged "Claude" or "Restored".
  - The panel closes when the active tab shows another note.
- **Preview** (`history-preview.tsx`):
  - An overlay over the editor pane. The live editor stays mounted underneath but is made invisible, because the window background is translucent.
  - It uses its own read-only `EditorView` with a reduced extension set (see [docs/editor.md](../docs/editor.md)) and `@codemirror/merge`'s `unifiedMergeView`.
  - The selected version is diffed against the version before it, and the preview scrolls to the first change.
- **Restore:** taken under the agent-editing lock after saving, and applied to every open alias as one undoable step through the agent reload path. Restore is blocked while a Claude turn is active on the note.

## Known limits

- Only the body is diffed; frontmatter changes don't show in the preview.
- Deleted chunks render as raw markdown.
- Notes moved or renamed outside Writer lose their history link.
- In git-tracked vaults, `.writer/history` shows up as untracked unless ignored.
