# Chat: attach files

Users can attach any file Claude Code can read: images, PDFs, other notes, CSVs, code. Each file is attached to the next message.

## Entry points

- The paperclip button next to Send opens the native file picker. Multiple files can be selected, and there are no type filters.
- ⌘V with an image on the clipboard saves it to `app_cache_dir()/chat-attachments/Pasted image YYYYMMDD-HHMMSS-xxxx.{ext}` and attaches that file. The 5 MB limit is shared with editor image paste (`lib/pasted-image.ts`). Saving prunes pasted images older than 30 days.
- Dropping files from Finder onto the composer attaches them. The composer highlights while a drag is over it.

Picked and dropped paths go through `resolve_chat_files`, which returns canonical regular files. A folder or a missing file is rejected with a message such as "Projects is a folder. Attach files instead.", shown above the composer.

## Drop routing

The frontend owns every file drop (`hooks/use-file-drop.ts`, mounted in `App`). Native `WindowEvent::DragDrop` handling is gone. A drop whose position, converted to CSS pixels, lands inside `[data-chat-drop]` while a note is active attaches its files. Any other drop calls `open_dropped_paths`, which opens the first openable path exactly as the native handler did.

## Sending

Pending files live on the chat (`Chat.files`, in memory like `draft`), deduped and removable from their chips. Backspace on an empty draft removes the last file first. On Send:

- The user message keeps `files` (absolute paths). They are persisted with the thread in `chats.json`; the file contents are not stored.
- `writer_context.files` lists the paths, and the system prompt tells Claude to Read each one before answering.
- `claude_send` receives the same paths, canonicalizes them (failing the send if one has gone), and adds them to the process scope's `attached` set.
- An accepted send clears them from the composer. A failed send puts them back.

Feedback-batch turns don't take files.

## Read grant

Files are sent by reference, and Claude reads them with its own `Read` tool, so every type it supports works. In `Scope::hook` and `Scope::permission`, a `Read` whose canonical path is in `attached` is allowed without a host prompt, during the active turn only. Other reads keep today's CLI rules and approvals. The grant belongs to the turn's process, so a later turn has to attach the file again to read it without a prompt.

## Display

`FileChip` shows a thumbnail for png/jpg/gif/webp via the asset protocol, falling back to an icon when the file is gone. PDFs and other files show an icon and the file name, with the full path as the title. On sent messages, a workspace Markdown note opens on click.

## Validation

- Native: attached reads allowed (aliases included) by both the hook and the permission callback; other outside reads still prompt; no grant after the turn or in a new process; `resolve_attachments` rejects folders and missing files; saving pasted images prunes old ones.
- Store: files reach `writer_context.files` and the `claude_send` argument, stay on the saved message, leave the composer and come back on failure.
- Render: sent messages show file chips with image thumbnails.
- Real CLI (`real_cli_reads_attached_files`, ignored): a PNG, a PDF and a CSV outside the workspace were read with no prompt, and Claude answered red, PINEAPPLE-42 and MANGO.
- Browser harness with the real panel and mocked IPC: picker chips, folder rejection, drop routing to Chat or open, paste and send.
- Native Tauri GUI QA is still pending: `tauri-webdriver` isn't installed here, so drop positions under real Retina scaling haven't been checked.
