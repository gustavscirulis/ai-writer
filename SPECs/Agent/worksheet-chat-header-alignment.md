# Chat header alignment

Task/spec: [chat-header-alignment.md](../chat-header-alignment.md), current TODO entry.

Reviewed: user screenshot; ClaudePanel, AppLayout, EditorTabs, Sidebar and MessageList; React and consolidation docs from this session; better-layout skill. Chat reserves `--chrome-drag-height` (72px) before a 42px header; tabs use a 56px row (32px controls plus 12px padding twice), centered at y=28.

Plan: remove the panel spacer, reuse the tab row height/padding expression for its header, and let Chat own its header drag region. Set the existing workspace drag overlay's right inset to the Chat panel width when visible. This avoids overlay capture of header actions and the first conversation row without adding listeners or state. Mark header/title and action-group empty space as drag regions; do not mark buttons.

Validation: no new tests for a reversible layout change. Run vp check/test and desktop build; inspect generated CSS and inline geometry. Browser/native verification of alignment, window dragging, buttons and resizing remains unverified because localhost permission was dismissed earlier. Prior changes and untracked playground prototypes stay intact; user requests updated publication commands after this fix.

Plan review: UX, React/Frontend and QA reviewers approved. Use the same live `--agent-panel-width` on the global overlay's right inset, so it tracks drag drafts and resolves to zero when hidden.

Result: implemented the two-file change, with local drag attributes only on header, title and action-group container. The resize handle remains z50 above the global z30 overlay. Implementation reviewers report no findings. vp check passes (existing e2e warning), 834 tests pass, and the desktop frontend build passes (existing build warnings). Static header math is 56px / centered at 28px in both columns; dynamic overlay uses the same root CSS variable as panel width. No rendered/native verification was possible.

Publication: user requests commands to run manually because this session cannot write Git worktree metadata. Prepared `.context/chat-pr-body.md` and explicit staging commands including all requested changes, excluding pre-existing playground prototypes.
