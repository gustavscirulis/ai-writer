# Claude chat panel spike

Spec: [Claude chat panel](../claude-chat-panel-spike.md). TODO: Done (implementation complete; commit blocked by environment).

Clean working tree at start. Read the attached plan/transcript, agent-loop/review, React, Zustand, editor, consolidation, toolchain and shortcut docs; inspected save engine, editor mounting/reload, app layout, workspace/window lifecycle and settings.

## Plan

- Start the user-installed unmodified CLI via a per-workspace process actor. Resolve login-shell PATH once, guard insertion with workspace root/epoch, send process IDs with IPC to reject stale calls. Reset/close owns cancellation. Provider-shaped event envelope leaves room for Codex without implementing it yet.
- Flush through the existing save pipeline and await in-flight writes; fail the turn if saving fails. Lock editor and frontmatter before flushing to prevent new writes. Reload at turn completion/stop before unlocking, using minimal undoable changes for the turn's open files. Generation guards discard stale channel/async results.
- Use one per-window chat store with workspace-bound session IDs persisted via Tauri preferences; retain live CLI between turns. Capture active editor selection via a view registry. Workspace generation changes reset the conversation.
- Add a quiet right-hand panel using existing theme tokens/type, persisted width/visibility, accessible resize/composer/stop/new-chat controls, shortcut and command palette.
- Preserve GPL/upstream/MIT notices and document external CLI requirements. No SDK, bundled binary, credential handling or telemetry. Correct outdated legal claims from attached plan using current primary sources.

## Validation

Baseline and final frontend check/tests, Rust test/clippy/fmt. Targeted parser/diff/save/race tests. Browser panel QA and local CLI protocol probe with a temporary note if feasible. Separate plan and implementation review personas per repository workflow.

## Risks

CLI tools inherit normal workspace settings and permissions; auto-edit permissions are the explicit spike choice. Stop kills/reaps the process; session is resumed on next send. Approval UI, rich history, other-file diff UX and shipping/legal review remain follow-ups.

## Plan review corrections

Rust, State and Editor reviewers identified lifecycle, save, watcher and frontmatter undo gaps. Revised design: isolated process group terminated/reaped before Stop acknowledgement; explicit close invalidation under root write lock; bounded framed shell discovery; independent cancellation channel. Lock every open buffer synchronously, drain saves with explicit errors, invalidate/suppress watcher reads and publish one owned completion reload. A frontmatter StateEffect with inverted history effects restores metadata with body on undo/redo; central mutation guards cover widget/store writes. Stream reconciliation uses message/block IDs. Separate conversation/process/workspace generations reject stale callbacks.

## Implementation review and results

Independent Rust, State, Editor, Frontend, UX, QA, Systems and Workspace personas reviewed the change. Addressed process cancellation/completion ownership, native visibility getter deadlock, duplicate-send/deferred-start teardown, failed New chat termination, stale navigation success/failure, newly opened file reconciliation, duplicate-tab selection/undo, pending Mermaid edits, frontmatter-derived date, batched tool results, scroll following, viewport sizing, drafts and completion announcements. Rust/State/Editor final re-reviews report no unresolved P1 findings.

The live installed CLI edited a synthetic frontmatter note using existing authentication and the planned stream-json flags. Browser QA used the actual app/editor/store with mock IPC: Send locked the editor/properties, completion updated the paragraph, hiding/reopening retained draft, and Cmd+Z restored the note and invoked normal autosave. Screenshot: `.context/claude-chat-panel.png`.

Native `vp run dev` compiled and started the app but macOS application-service/XPC errors prevented usable native window QA. Baseline and escalated Rust suites also fail the existing Finder trash test because Finder cannot be reached; this is unrelated to the spike. Native integration/permission/close-resume verification is recorded as remaining release work in the spec.

Current Anthropic primary docs replace the attached draft's outdated blanket restriction; external unmodified CLI use still has Commercial Terms and authentication/trademark conditions. Added `docs/third-party.md`, preserving root GPLv3 and ProseMark MIT notices. Codex is explicitly future work.

Final validation: 58 frontend test files / 740 tests passed; tracked-file `vp check` and new-file targeted check passed (one existing e2e JSDoc warning); desktop production build passed. Rust: 170 tests passed, one existing Finder trash failure; all three new lifecycle tests passed. Clippy and formatting passed with existing warnings. Browser keyboard resize and 800px viewport clamp were checked; final native integration remains unverified.

Commit blocked: both ordinary and approved elevated `git add` fail creating `/Users/gustavscirulis/GitHub/ai-writer/.git/worktrees/houston-v2/index.lock` with Operation not permitted. Worktree files remain intact and unstaged; no branch changes. Filesystem permissions report the current user as owner, with no immutable flag. No attempt was made to bypass the restriction with an alternate Git directory/index.
