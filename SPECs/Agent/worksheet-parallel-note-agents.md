# Parallel note agents worksheet

Task: [parallel agents per note](../parallel-note-agents.md), tracked in TODOS.md. Initial working tree was clean; this task is one feature commit.

## Investigation and plan

Read Chat/store/hooks/components/tests; agent-turn/save/editor/watchers/Mermaid; feedback store/close persistence; Rust actor/WorkspaceState/filesystem commands; and the React, Zustand, editor, consolidation and review workflow docs. Installed dependencies with vp; no lockfile changes.

Approved plan: per-canonical-note state/runtime and locks; native per-window process registry and mandatory Edit/Write hook; canonical I/O with display aliases; targeted save/reconciliation; independent feedback; tab status; recoverable all-run lifecycle drains. Retain saved sessions and stop/reap every completed process. Cross-window manual editing coordination remains outside scope.

## Implementation and review

- Chat owns messages, drafts, activity, approvals, notices, errors and runtime by canonical note. Synchronous admission covers startup, pending delivery acknowledgement, reconciliation and New chat reset. Late callbacks validate the originating attempt/workspace. Session writes serialize and use strict persistence with retry.
- Native registry binds each actor to its note and rejects duplicate ownership. Require CLI 2.1.296+ and successful SDK initialize before delivery. Production safe-mode command exposes only Read/Glob/Grep/Edit/Write, disables customizations/shell/subagents/MCP and retains terminal sign-in. Native PreToolUse canonicalizes Edit/Write, denies other targets without override, and owns immutable request-local permission replies. Failures kill/reap only that actor.
- Native reads return canonical identity; saves preserve symlinks. Aliases share locks/revisions/chat/session keys. Flush/save/reload only the target; retain closed buffers through completion. Reused panes flush the old binding before swapping; retained Mermaid editors rebind readonly and use outer Undo/Redo. One isolated history step restores body and frontmatter.
- Feedback outcomes/errors are per note, persistence errors workspace-wide. Window/workspace close owners count independently; Stop/drain/reconcile precedes persistence and teardown. macOS main close hides only after success and resumes admission. File relocation is blocked during turns, recovery and resets.
- Selected Chat owns disclosure/scroll/focus; background approval changes only its tab indicator. Accessible indicator buttons open the owning chat.

Plan and implementation reviewed independently with State, Rust, Architecture, Editor, UX, QA, Startup and React personas. Fixed findings: alias snapshots taken before pending widget flush; stale alias identity reads; canonical rename/session rekey; retained Mermaid readonly rebinding; session errors that could not retry; close barriers released early or by another lifecycle owner; reset/move admission; aggregated close errors missing note paths. Strengthened actor tests to assert B's successful completion when A stops, plus independent feedback outcomes and actual pane/close-hook browser QA. No remaining blocking review finding. Applied the React best-practices skill checklist.

Owning editor, approvals, Chat spike/composer and feedback docs updated; changelog and TODOs updated. The older result-before-delivery-ack TODO is resolved by retaining attempt ownership.

## Validation

- Baseline: vp check, 861 frontend tests and Rust format passed. The Finder trash test already failed with macOS XPC/Finder (-1728); an unrestricted rerun reproduced it.
- Final: vp check passes (one existing e2e type warning); **869 frontend tests pass**; desktop build passes. Rust **179 pass**, one real-CLI test normally ignored, and only the same pre-existing Finder trash failure. Cargo clippy passes with 12 existing warnings; cargo fmt --check passes.
- Explicit ignored integration test: production command builder and native actors ran A/B concurrently, both wrote their exact assigned REVISED-a/REVISED-b contents, completed successfully and left context.md unchanged (19 seconds). Current log: .context/real-cli.log. Models may decline to attempt the forbidden write in this prompt; this probe is not counted as proof of hook denial. Out-of-note/alias/forged-reply denial is tested directly, and the initial plan-time real CLI callback probe allowed A and denied B despite broad Edit/Write permissions.
- Native actor tests cover malformed/forged hooks, rejected initialize, failed native hook reply with closed stdin, process-group cancellation, no late descendant writes and independent stop/completion. Strict session/read retries, two-note stream/ack interleaving, resets, closed-tab saving/execution, lifecycle admission and feedback outcomes are covered in frontend tests.
- Browser QA used actual App/editor/Chat/useFeedbackPersistence with mocked IPC and visible QA controls: simultaneous A/B sends; C editable/autosaving; background A approval without selection/focus change; keyboard indicator activation; closed A completing while B runs; close waiting for both; failure ACK retaining recovery; retry ACK only after both reconcile. Reused the same tab pane across Mermaid A/B, kept pending edits in A, edited B while A ran, and rejected further A input. Embedded Undo/Redo restored agent-changed body and frontmatter together. Screenshot: .context/parallel-agents.png.
- Native development app compiled and was launched with an isolated app identifier and synthetic workspace. macOS application-service/XPC errors prevented a usable window; live native hide/reopen remains unverified. This is separate from the passing real native actor/CLI workflow. Dev process stopped, temporary QA HTML removed; harness/logs/screenshots remain gitignored in .context.

No feature behavior was deferred. The only remaining validation limitation is live macOS GUI hide/reopen in this environment.

Commit is pending: both ordinary and escalated `git add` failed to create `/Users/gustavscirulis/GitHub/ai-writer/.git/worktrees/stuttgart/index.lock` with “Operation not permitted.” The worktree's Git metadata is outside the managed writable workspace. No branch or Git metadata was changed; all implementation changes remain in the working tree. Read the bundled Conductor skill while diagnosing this; no settings/workspace changes were made.
