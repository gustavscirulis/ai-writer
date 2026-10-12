# Immediate Chat message worksheet

Task: [chat-immediate-message.md](../chat-immediate-message.md), TODOS In Progress.

Reviewed claude-store send/receive/Stop/finish, composer and MessageList empty-state rendering, ChatMessage type, existing composer-send spec/tests, React/Zustand/consolidation guidance. Root cause: user message append occurs after awaiting claudeStart, including save/read/session/MCP startup. MessageList already renders directly from the per-note messages list.

Plan: move the existing user-message construction to accepted-send admission and append it atomically with running/Thinking/draft clearing. Remove the transport-stage append. Keep original shape and trimming; retain submitted messages on errors and Stop with existing recovery. Extend production store tests for synchronous first-message insertion, deferred save/start/delivery, single insertion, attachments, rejected attempts, failures and note/workspace ownership. No backend/UI components or new state fields.

Preserve earlier MCP/web changes; worktree is intentionally dirty with this session's authorized work. Git staging remains blocked by external metadata permissions. Browser launch was previously blocked even after escalation; attempt rendered QA only if available, document the limit honestly.

Implementation: constructed the existing ChatMessage and UUID outside the state callback, appended once in the accepted-send update alongside running/Thinking/draft clearing, and removed the post-startup append. Message shape, trimming, attachments and transport/save sequencing remain unchanged. Submitted messages stay visible on failed/cancelled attempts; the existing inline error and conditional composer restore provide recovery.

Validation: the immediate-message regression failed before the change (empty messages immediately after Send) and now passes. The 78 production store tests include deferred save/read/start/delivery, stable message identity, failure retention and retries, Stop, attachment visibility, suggestions/feedback, rejected sends, aliases and successful stale startup after New chat/workspace reset. Full frontend suite: 890 pass; vp check and desktop production build pass with existing unrelated warnings. No Rust change or native validation rerun needed for this task.

Rendered proof: a Chrome extension browser tab mounts actual MessageList and Composer with the production store and mocked native IPC. On the empty thread, pressing Enter immediately replaces suggestions with the user bubble and Thinking, clears the composer and keeps the bubble visible while Claude startup remains deliberately unresolved. Screenshot: .context/chat-immediate-message.png; harness: .context/chat-immediate-preview.html. The in-app browser is unavailable, but the connected Chrome extension worked despite earlier headless launch restrictions. No real CLI, external services or personal files are touched by this fixture.

Reviews: Zustand/State and QA approved the plan and implementation; UX reviewed the plan and browser behavior. Native Tauri UI remains unverified. Earlier authorized MCP/web changes are preserved. Commit remains blocked by external worktree Git metadata permissions, including the prior elevated staging attempt.
