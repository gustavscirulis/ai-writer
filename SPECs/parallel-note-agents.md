# Parallel agents per note

Run independent Claude turns on notes A and B at the same time, with one turn per canonical note in each workspace window. Send, Stop, New chat, drafts, streams, approvals and recovery belong to their note. Other notes remain editable. Closing a tab lets its run finish; reopening restores its chat.

## Ownership and transport

- Per-note runtime owns its process, attempt, channel, pending delivery and completion. Keep the note busy through delivery acknowledgement, process termination and reconciliation. New chat reserves ownership through session deletion.
- Native process registry replaces the single window process slot. A process accepts one user turn, resumes the note's saved session, and is reaped after completion. Window/workspace teardown cancels all processes and invalidates pending starts.
- Register a native PreToolUse callback before user delivery. Edit/Write only the canonical target; deny other targets. Restrict tools to Read/Glob/Grep/Edit/Write, use safe mode, and deny MCP. Native owns control replies and validates request-local approvals; failures terminate the affected process. CLI capability failure is explicit.
- Require Claude Code 2.1.296 or newer and a successful SDK hook initialization. Shell discovery, capability probing, initialization, scope resolution and native replies are bounded. Keep terminal sign-in; disable ordinary customizations, shell tools, subagents and MCP.
- Persist session IDs through strict serialized workspace writes. A failed session write retains note-local recovery and retries without discarding the session. Counted lifecycle owners keep admission closed through overlapping window/workspace drains.
- Preserve display paths, but canonical I/O paths govern saves, locks and scope. Aliases share ownership. Cross-window manual editing coordination remains outside this feature.

## Editor and feedback

- Flush only the target's pending widgets, lock synchronously, then drain its saves. Guards, subscriptions and I/O revisions are document-aware, including reused panes and embedded editors.
- Retain owned buffers on tab closure. Reconcile only the target after confirmed termination, using a single body/frontmatter undo step. Failure retains only that lock until retry. File relocation remains blocked while any ownership exists.
- Saved feedback runs and outcome errors are per note; persistence failures stay workspace-wide.
- Close/quit/workspace transitions drain all turns and feedback before clearing state. Main-window close hides after successful drain; failures retain recovery.

## UI and validation

Chat follows the selected note. Tab indicators show running, approval needed or error, and open that note's Chat on activation. Background requests never change the selected note or steal focus. Respect reduced motion and keyboard activation.

Test interleaved starts/streams/acknowledgements/results/stops, stale callbacks, reset/send races, feedback outcomes, close/reopen during saving, aliases, unrelated autosave/watcher reads, reused panes and undo. Native tests cover scope denial, forged approvals, hook failures and independent actors. Run frontend checks/tests/build, Rust tests/clippy/fmt, browser QA and a real CLI two-note probe.

Implemented and reviewed; results and the macOS native-UI validation limitation are recorded in [the worksheet](Agent/worksheet-parallel-note-agents.md).
