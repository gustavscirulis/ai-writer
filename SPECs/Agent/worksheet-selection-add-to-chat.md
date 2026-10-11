# Selected-text notes

Task/spec: [selection-add-to-chat.md](../selection-add-to-chat.md), “Make selected-text notes discoverable” in TODOS.

Reviewed: Stream feedback spec; React, Zustand, consolidation, editor, shortcut and Vite+ docs; feedback-extension, feedback-api, editor-body-menu, editor-context-menu, feedback store/tests and playground.

Findings: selection attachment, note saving and ⌘L already exist. The selection pill says “Comment” while the paragraph button says “Add to chat”; the native selection menu omits the action. Keep the existing behavior and make the two entry points explicit.

Plan: rename the pill; add an optional menu callback supplied only for nonempty selections; reuse attachFromEditor and check disposal before invoking it. Update Stream spec, changelog and task status. Test menu inclusion and action, plus selection quotes, cross-block selections, collapse and failed attachment via the API with real EditorState and mocked boundary effects.

Validation: vp install completed. Baseline vp check passes with the existing e2e/wdio.conf.js type warning. Browser attempt was blocked by a dismissed localhost permission request; do not bypass it. Untracked playground prototypes predate this task and will stay outside its commit.

Plan review: UX, Editor and QA reviewers approved reuse. Added QA's extension-handler tests for native-menu blur/disposal. For reused views, ignore a delayed menu action after the path changes, so a menu opened on one document cannot attach text from another.

Implementation: renamed the pill, added the optional top-level native menu action with ⌘L, and supplied it only for nonempty selections. The callback checks disposal and document identity and passes the view explicitly. Added API tests for quotes, cross-block attachments, composer open/focus and failed-attachment selection retention; existing store tests cover note saving and dedupe. Targeted tests: 22 passed.

Final review: Editor, UX and QA reviewers report no findings. Final validation: vp check passes with only the pre-existing e2e/wdio.conf.js warning; all 834 tests pass; vp run desktop#build passes with existing toolchain/chunk warnings. Rust is unchanged. Rendered pill geometry and real Tauri menu focus remain unverified due dismissed localhost permission. No new behavioral or persistence path was introduced.

Commit blocked: both ordinary and escalated git add failed to create `/Users/gustavscirulis/GitHub/ai-writer/.git/worktrees/islamabad-v1/index.lock` with “Operation not permitted”. All changes remain saved and unstaged in this workspace.
