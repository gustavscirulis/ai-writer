# Chat panel spike

Implemented 2026-10-10. This supersedes the attached planning draft.

## Goal and behavior

A conversation on the right of Writer can edit Markdown on disk using the user's installed, unmodified Claude Code CLI and its existing authentication. Writer starts a separate workspace conversation; it does not attach to a running terminal transcript. Sessions can be resumed by the CLI and their IDs persist per workspace.

Open **Chat** in the title bar, press Cmd+Shift+L, or choose **Toggle Chat Panel** in the command palette. The panel is hidden by default and unavailable in compact single-file windows. Visibility and width use `appearance.agent-panel-visible` and `appearance.agent-panel-width` in the shared settings schema. Width defaults to 340px and adapts to the window/sidebar and reserves 320px for the editor where the combined column minimums fit. The separator supports dragging and keyboard arrows.

Enter sends, Shift+Enter adds a line, and IME composition does not submit. Drafts survive hiding the panel. Stop terminates the process; the next turn resumes the workspace session. New chat terminates the retained process and clears the workspace session ID and visible conversation. Assistant replies stream plain text with tool completion/error chips. Chat shows a reduced-motion-aware Thinking text shimmer, distinguishes writing/tool activity, preserves per-block snapshots and partial answers, and follows content growth only while the reader is at the bottom. See [thinking and streaming](chat-thinking-streaming.md). Errors appear inline. CLI stderr diagnostics are retained separately in a collapsed CLI notices disclosure (latest 50 distinct lines per process); a successful turn does not discard them. New process, New chat and workspace transition clear the notices. Closing the panel hides it; closing the window or changing workspaces cancels the process.

## Backend ownership

`commands/agent/claude.rs` exposes start, send and stop, using a provider-shaped `AgentEvent` channel envelope. Only Claude is implemented; adding Codex also requires a frontend provider adapter.

Login-shell discovery resolves executable/PATH using a framed response, an eight-second timeout and successful-only cache. Startup receives root/epoch, captures a cancellation epoch before asynchronous discovery, queries native visibility outside state locks, then validates identity under the workspace root and process locks. This prevents a late start after workspace transition or window close.

The CLI runs with cwd set to the workspace root:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --permission-mode acceptEdits \
  --permission-prompts host --permission-prompt-tool stdio --append-system-prompt "<editor instructions>" \
  [--resume <session ID>]
```

The existing CLI account, settings, instructions and tools apply. Edit permission is automatic. Other tool permission requests appear in Chat with the exact tool/input and Approve once or Deny controls. Approvals never persist rules. Managed denials and unavailable authentication still apply. See [tool approvals](claude-tool-approvals.md) for lifecycle and validation details. Writer does not sandbox the CLI to the active file. The panel explains this before the first message. No authentication or credential files are read by Writer.

One process actor owns stdin, stdout, stderr and exit. Input acknowledgements confirm delivery; cancellation has an independent channel so it can interrupt a blocked stdin write. Unix process groups cover tool descendants. Stop kills the group, reaps the root, drains output and acknowledges completion. Workspace reset retains the completion handle until teardown finishes, preventing a replacement process from racing old writes. IPC includes process IDs to reject stale sends/stops.

## Save, reload and undo

Before any await, a turn flushes pending embedded-editor changes and locks all open buffers. It then drains existing autosave controllers through the same formatting/write pipeline, including in-flight writes and latest dirty content. A failed save preserves the unsaved buffer and prevents startup.

An I/O revision invalidates watcher reads and initial navigation reads spanning the turn. Ordinary watcher reloads are suppressed while locked. On terminal result, exit or confirmed Stop, the turn owner reconciles every currently open file, including files opened while running. Closed files are skipped. Deleted files are removed with an explicit error. Reload failure retains the lock and exposes Retry reload.

Each mounted view gets one minimal common-prefix/suffix transaction for the completed turn, with isolated undo history. A frontmatter StateEffect and inverted history effect restore metadata and body together; Undo/Redo uses the normal autosave pipeline. Duplicate tabs all receive their own undoable transaction, and selection context comes from the active pane. Other external reloads retain the existing behavior. Files edited outside mounted views are updated on disk but have no editor undo history.

Conversation, process-channel and workspace generations reject stale callbacks. Stop/New chat retain process ownership after IPC failure and reject Send until termination succeeds. Workspace lifecycle resets draft/conversation and lets the backend own cancellation.

## Distribution

See [third-party and fork notes](../docs/third-party.md). Preserve Writer's GPLv3 license, upstream notices and the vendored ProseMark MIT license. This spike bundles no CLI or SDK and adds no telemetry. A separately shipped fork still needs its own app identity, release/update configuration and release notice review.

The attached draft's blanket restriction on subscription-backed CLI integration is superseded by the current primary-source notes. An SDK or credential-proxy integration is a different design and must be evaluated separately.

## Validation and remaining work

Tests cover stream reconciliation, batched tool results, minimal diff, save draining/failure, locks, deferred startup/Stop, stale channels, file deletion, navigation-read races, duplicate-tab undo and Unix process-group cancellation. Browser QA mounts the actual layout/editor/store with mocked IPC and checks edit, lock, draft retention and undo/autosave. A separate real CLI probe edited a synthetic note with the existing terminal sign-in.

`vp run dev` compiled and started the native binary, but macOS application-service/XPC errors prevented a usable native window in this automation session. Finder launch/PATH, native channel integration, permission denial and native close/resume should receive a manual pass before release. The pre-existing Finder trash test is affected by the same service failure.

Before shipping: add graceful protocol interrupt; onboarding and account/session recovery; persisted visible history/session picker; reply Markdown rendering; changed-file/diff review; a native end-to-end test; and the separate fork's identity/releases. Codex support remains future work.
