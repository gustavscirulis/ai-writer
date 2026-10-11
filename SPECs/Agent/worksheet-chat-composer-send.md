# Clear Chat composer on send

Task/spec: [chat-composer-send.md](../chat-composer-send.md), current TODO.

Investigated: composer.tsx, hooks/use-claude.ts, claude-store.ts, Rust claude_send acknowledgement, existing claude-store tests, React/Zustand/consolidation guidance. The component currently clears only after awaiting sendChat, which includes save/start/IPC acknowledgement. Draft state is already per-note; the textarea height follows it.

Plan: let the store atomically clear a matching ordinary draft at accepted turn start. Capture the exact draft and restore it on unsuccessful delivery only while the same generation owns the turn and the draft remains empty. A single promise settlement handler restores failures only when pendingSend still identifies this exact attempt; generations alone can be shared by consecutive sends. Remove delayed component/hook clearing. Preserve feedback/suggestion prompts that differ from the draft. Add deferred/failure/race tests to the production store suite, update Stream contract/CHANGELOG/TODO and PR body.

Workspace: previous requested changes remain uncommitted due denied Git worktree metadata writes. Preserve unrelated untracked playground prototypes; provide updated publication commands.

Plan review: React/Frontend and QA approved. Accepted attempt-identity guard and tests for exact whitespace, failed save/start/delivery, next drafts, tab/workspace switches, cancellation and older acknowledgements. The immediate-clear regression failed before the implementation and now passes.

Implementation: accepted ordinary sends atomically clear the exact matching per-note draft with the running status. Failure settlement restores raw text only for the exact pending task, current generation and still-empty originating draft. Removed the old hook/component post-send clearing. Twelve production-store tests cover immediate clearing, deferred delivery, whitespace recovery, newer drafts, cross-note/workspace boundaries, Stop/New chat, old acknowledgements, and unrelated/rejected sends.

Validation: regression reproduced before implementation; all 59 targeted store tests and 861 full tests pass. vp check and desktop frontend build pass with existing wdio/Vite/chunk warnings. Native textarea sizing and rendered failure recovery remain pending under the existing browser permission limitation. No Rust changes.

Adjacent finding: the existing delivery-error catch can stop a newer turn if a streamed result precedes an old acknowledgement; recorded under Up Next. This task's draft restoration is guarded by exact pending-send identity.

Implementation review: React/Frontend and QA approved with no new findings. The adjacent late-acknowledgement transport race is tracked separately in TODOS.
