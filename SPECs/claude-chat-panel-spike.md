# Chat panel spike

Implemented 2026-10-10; parallel note ownership added 2026-10-11. This supersedes the attached planning draft. [Parallel note agents](parallel-note-agents.md) owns the concurrency contract.

## Goal and behavior

A conversation on the right of Writer can edit Markdown on disk using the user's installed, unmodified Claude Code CLI and its existing authentication. Each note has its own conversation; Writer does not attach to a running terminal transcript. The panel shows the active note's chat. Sessions can be resumed by the CLI and their IDs persist per note (`workspace:<root>:agent:claude-sessions`, keyed by path and rewritten when a note or folder moves). Each canonical note can run one turn independently, with no additional concurrency cap within a workspace window. Its messages, draft, activity, errors, notices and approvals belong to that note. Aliases share ownership and saved sessions. Closed tabs continue running; reopening restores their chat.

Open **Chat** in the title bar, press Cmd+Shift+L, or choose **Toggle Chat Panel** in the command palette. The panel is hidden by default and unavailable in compact single-file windows. Visibility and width use `appearance.agent-panel-visible` and `appearance.agent-panel-width` in the shared settings schema. Width defaults to 340px and adapts to the window/sidebar and reserves 320px for the editor where the combined column minimums fit. The separator supports dragging and keyboard arrows.

Enter sends, Shift+Enter adds a line, and IME composition does not submit. Accepted sends immediately show the submitted message and Thinking, before file saves or CLI startup; errors and Stop retain it (see [immediate messages](chat-immediate-message.md)). Drafts are per note and survive hiding the panel. Stop terminates the process; the next turn resumes the note's session. New chat stops only its note and reserves it throughout asynchronous session deletion. Each completed turn stops and reaps its process; the next send resumes the saved session in a new process. Your messages appear as right-aligned bubbles, with the selection they were sent with quoted above. Assistant replies stream Markdown; each reply's tool use collapses into a summary row ("Read and edited · 2") that expands to the per-tool list, with failed tools struck through. The panel UI (design chosen from a prototype round on 2026-10-10) is the "Thread" direction: icon-only header, suggestion chips in the empty state, an inline approval card, and a rounded composer showing how much selected text the message includes. Chat shows a reduced-motion-aware Thinking text shimmer, distinguishes writing/tool activity, preserves per-block snapshots and partial answers, and follows content growth only while the reader is at the bottom. See [thinking and streaming](chat-thinking-streaming.md). Errors appear inline. CLI stderr diagnostics are retained separately from errors in a collapsed CLI notices disclosure placed after the message that was last visible when they arrived, so it scrolls with the conversation. Each distinct line appears once per chat (latest 50), even though every turn's new process repeats its startup warnings. New chat and workspace transition clear them. Closing the panel hides it. Window close, quit and workspace transitions stop every run, reconcile their notes and flush persistence before teardown. Main-window close on macOS hides after successful reconciliation; failure keeps recovery available.

## Backend ownership

`commands/agent/claude.rs` exposes note-bound start, send, stop and permission decisions, using a provider-shaped `AgentEvent` channel envelope. Only Claude is implemented; adding Codex also requires a frontend provider adapter.

Login-shell discovery resolves executable/PATH using a framed response, an eight-second timeout and successful-only cache. Startup receives root/epoch, captures a cancellation epoch before asynchronous discovery, queries native visibility outside state locks, then validates identity under the workspace root and process locks. This prevents a late start after workspace transition or window close.

The CLI runs with cwd set to the workspace root, manual host permissions, stream-json input/output, partial messages, built-in Read/Glob/Grep/Edit/Write plus WebSearch/WebFetch and ToolSearch/WaitForMcpServers, broad Edit/Write allows, normal MCP server discovery and an appended note-scope system prompt. A saved session ID is supplied with `--resume`.

The existing terminal authentication applies; Writer reads no credential files. Normal CLI configuration loads MCP servers and customizations; built-in shell tools and subagents remain unavailable. MCP servers and configured custom hooks own external side effects outside the built-in edit guard; see [MCP tools](chat-mcp-tools.md). A bounded version probe requires Claude Code 2.1.296 or newer. Native SDK initialization allows up to sixty seconds for MCP/plugin startup and remains immediately cancellable. It registers the PreToolUse hook before prompt delivery; Edit/Write can target only the captured canonical note, with no user override for another file. Workspace context remains readable. Read and MCP permission requests appear in the owning note's Chat when required by CLI permissions. See [tool approvals](claude-tool-approvals.md).

A per-window process registry rejects duplicate canonical-note ownership and validates process IDs, workspace generation and cancellation epochs. Native control replies cannot be supplied by the frontend. Initialization, hook parsing, transport and reply failures terminate the affected actor and retain its ownership until reaped.

One process actor owns stdin, stdout, stderr and exit. Input acknowledgements confirm delivery; cancellation has an independent channel so it can interrupt a blocked stdin write. Unix process groups cover tool descendants. Stop kills the group, reaps the root, drains output and acknowledges completion. Workspace reset retains the completion handle until teardown finishes, preventing a replacement process from racing old writes. IPC includes process IDs to reject stale sends/stops.

## Save, reload and undo

Before any await, a turn flushes pending widgets for its target and locks only that canonical note. It then drains that note's autosave controllers through the existing formatting/write pipeline, including in-flight writes and latest dirty content. A failed save preserves the unsaved buffer and prevents startup. Conflicting dirty alias buffers fail explicitly.

Per-document I/O revisions invalidate watcher and navigation reads spanning the turn. Unrelated files remain editable and autosave normally. After terminal result, exit or confirmed Stop, native termination/reaping finishes before the owner reloads only its canonical target. Closed buffers remain owned until completion, then are pruned if unreferenced. Deleted files are removed with an explicit error. Reload failure retains that note's lock and exposes Retry reload.

Each mounted target/alias view gets one minimal isolated history transaction for body and frontmatter together. Duplicate tabs each receive undoable reconciliation; Undo/Redo follows normal autosave. Reused panes flush the previous document's pending widgets before changing identity and immediately reconfigure readonly. Embedded Mermaid Undo/Redo uses the outer document history. Ordinary external reloads retain their existing behavior.

Attempt, channel and workspace generations reject late callbacks. The note stays reserved through input acknowledgement and reconciliation, even when a result arrives before delivery acknowledgement. Stop/New chat retain process ownership after IPC failure and reject Send until recovery succeeds. Strict session persistence errors retain note-local retry; feedback persistence errors stay workspace-wide. Counted lifecycle owners prevent overlapping window/workspace closes from releasing admission early.

## Distribution

See [third-party and fork notes](../docs/third-party.md). Preserve Writer's GPLv3 license, upstream notices and the vendored ProseMark MIT license. This spike bundles no CLI or SDK and adds no telemetry. A separately shipped fork still needs its own app identity, release/update configuration and release notice review.

The attached draft's blanket restriction on subscription-backed CLI integration is superseded by the current primary-source notes. An SDK or credential-proxy integration is a different design and must be evaluated separately.

## Validation and remaining work

Tests cover interleaved note starts, streams, acknowledgements and completion; startup/Stop/reset races; late callbacks; save draining and failure; aliases; independent feedback outcomes; duplicate-tab body/frontmatter undo; pane readonly rebinding; and process-group cancellation. Browser QA mounts the actual app/editor and close hook with mocked IPC, checks concurrent controls, unrelated editing/autosave, background approvals, closed-tab completion, retained Mermaid pane reuse, embedded body/frontmatter undo/redo and stop recovery. A production native actor integration probe uses the installed CLI to edit two synthetic notes concurrently with context unchanged.

Live macOS window hide/reopen still needs a manual pass: application-service/XPC failures prevented usable native UI automation in this environment. The pre-existing Finder trash test is affected by the same service failure. This is distinct from the passing native process/CLI workflow.

Future work: graceful protocol interrupt, onboarding/account recovery, persisted visible history/session picker, changed-file/diff review, native GUI end-to-end automation and a separate fork's identity/releases. Codex support remains future work.
