# Chat text selection and copying

## Task and investigation

User-approved plan: enable ordinary text selection in sent messages and assistant replies, including nested Markdown, for native Cmd+C / Edit → Copy. Attachment controls and other chrome retain their selection behavior.

Reviewed `TODOS.md`, React guidelines, consolidation guidance, agent-loop/review workflow, Vite+ guide, global selection CSS, chat rendering, keyboard shortcuts and native Edit menu. The global CSS explicitly sets `user-select: none` on each element. A container-only override would leave nested Markdown disabled. Native Copy already exists and no chat copy handler intercepts it.

## Implementation

- Mark only user message bodies and assistant Markdown roots with `data-chat-selectable`.
- Exempt marked roots and descendants from the global no-selection rule and opt them into standard and WebKit text selection. Keep the policy in one CSS location.
- Validate actual drag/double-click selection and native copying where accessible, plus `vp check` and `vp test`.
- Formal delegated review is skipped for this trivial declarative CSS/attribute fix: no state, event handlers, async flows or backend behavior changes. Use the React best-practices checklist for the attribute-only component edits.

## Validation

- `vp install` completed with no tracked dependency changes.
- `vp check` passed; existing `typescript(no-redundant-type-constituents)` warning in `apps/desktop/e2e/wdio.conf.js` remains.
- `vp test`: 64 test files / 861 tests passed.
- `vp run desktop#build` passed (TypeScript and production build); existing toolchain/chunk warnings remain.
- Browser QA used real `UserMessage` and `MarkdownReply` components with the full app CSS in an isolated `.context/chat-selection-qa.html` fixture. Every nested Markdown element computed to `user-select: text`; the New chat control remained `none`. Verified user-message drag selection and double-click selection, selection across bold/italic/inline code, multi-line code selection, and table-cell selection. Native keyboard Cmd+C / Cmd+V pasted the selected user word, formatted paragraph and table-cell text correctly. Screenshot: `.context/chat-selection.png`.
- No new unit test: this declarative CSS change needs browser hit-testing/selection verification rather than a test that mirrors attributes. React review confirms no new hooks, state, subscriptions, handlers or changes to memo boundaries.
- Native Tauri Cmd+C / Edit → Copy QA remains pending: the running Writer is the installed `tauri://localhost` build, not this workspace's changed frontend. Rust files are unchanged, so Rust checks were not run.
- Commit blocked: `git add` and `git commit` cannot create the shared worktree `index.lock` under `/Users/gustavscirulis/GitHub/ai-writer/.git/worktrees/belo-horizonte-v2/`, including after an escalated retry. Changes remain uncommitted in the workspace.
