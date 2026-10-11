# Paragraph feedback for AI writing

Superseded by [`stream-feedback-chat.md`](stream-feedback-chat.md): the separate column and feedback mode are gone. Anchor mapping, persistence and the batch handoff below still apply.

## Contract

Feedback mode changes block clicks into feedback targeting; writing mode remains unchanged. A separate 280px column between editor and chat holds one editable bubble per Markdown block and Apply all for the current document. Bubbles match Chat's user bubbles and show only the feedback text; clicking one opens it with Remove, Apply now and Save. The editor tints the block and draws one curved connector only while its bubble is hovered or open, or its block is hovered; there are no resting marks beside blocks. Every Markdown body block is supported; frontmatter and blank space are excluded. Enter saves except during IME, Shift+Enter inserts a newline, Escape retains drafts that have text; feedback that was opened but never written is dismissed whenever it closes (Escape, clicking elsewhere, opening another block, leaving feedback mode) and is not restored on reload. Keyboard users can target the block at the caret via the command palette.

Feedback persists locally across restarts, outside Markdown. Source ranges map through local changes and recover through exact text plus neighboring context on reload. Splits, merges, deletions, and ambiguous matches require explicit Reattach. Renames/moves rewrite saved paths; tab closure does not discard feedback.

One immutable batch captures path and feedback IDs. Existing Claude handoff owns flush/save/lock, process, permissions, reload, and isolated Undo. Validate current anchors after save; only successful completion plus reconciliation plus document changes resolve submitted bubbles into a collapsed Applied section. Failures, Stop, and no-op turns retain feedback. Partial writes require explicit review acknowledgement before retrying. Workspace generations reject stale callbacks and hydration. Normal chat also reconciles anchors.

Editor reserves 320px; narrow windows prefer feedback over chat. Tool approvals temporarily replace feedback with chat if necessary, and preferred layout returns afterward. Feedback provides progress/errors/Stop. Compact single-file windows are excluded. Claude only; no staged diff review.

## Implementation

- One syntax-tree target helper and anchor mapping/recovery module; one feedback store behind narrow hooks and an imperative API.
- Capture widget pointer events without changing widget selection/folding; geometry uses CodeMirror layout and the outer scroller, scheduled by actual layout/scroll/resize events.
- Feedback persistence uses serialized Tauri store writes with strict error reporting, generation-guarded hydration, and saved running states recovered as interrupted.
- Claude send accepts optional captured path, post-save preparation, and request-local completion; completion is emitted by its existing finish owner, including cancellation and changed-file evidence.
- Existing rename/move owner forwards path rewrites to feedback.

## Acceptance

Target all kinds and nested/incomplete syntax; preserve source/caret when clicking widgets. Test repeated text, range shifts, split/merge/delete, reload/restart, duplicate views, stale workspace reads, moves, captured paths, single/batch/no-op/error/partial/Stop, Undo/Redo. Render QA checks long-document connectors, both themes, zoom, focus, small windows, approval interruption, and reduced motion. Run vp check/test and Rust baseline checks; record any native environment limitations. Review via separate relevant personas before implementation and handoff, update owning docs/TODOS/CHANGELOG, and commit once complete.
