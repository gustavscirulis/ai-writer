# Unified feedback/chat prototype worksheet

- Task: isolated design exploration, linked from TODOS; spec: `SPECs/unified-feedback-chat-prototype.md`.
- Existing workspace contains substantial uncommitted chat/feedback implementation. Preserve it; stage only this exploration's files.
- Read prototype skill/PICKER, agent loop/review, React guidelines, Vite+ docs, playground README, existing Feedback/Chat/AppLayout and paragraph-feedback spec.
- Plan: add a new playground HTML entry and three variant modules, shared sample interactions and styling. Production imports nothing from this surface. Use native browser selection, explicit Writing/Feedback mode, a shared passage target, sample changes and undo. Reuse Writer's neutral surfaces, system typography and orange accent.
- Validation: Vite+ checks/tests and browser QA; Rust unchanged, so Rust checks are unnecessary for this isolated page. Existing WIP failures will be recorded without modifying unrelated files.
- Review: UX and React reviewers inspect the isolated files; no editor/store/backend changes.
