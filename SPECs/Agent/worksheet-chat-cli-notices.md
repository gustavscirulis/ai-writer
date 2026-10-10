# Chat CLI notices

References: user screenshots 2026-10-10, [chat spike](../claude-chat-panel-spike.md), TODO Chat CLI startup notices.

The screenshots show a startup MCP-policy warning followed by a successful response. The store assigns all stderr output to the terminal error field; successful finish clears that field. This both mislabels a nonfatal diagnostic and discards it. No CLI permission or enterprise-policy changes are needed.

Plan: retain bounded/deduplicated stderr notices per CLI process separately from errors; expose them through a focused domain hook; show them in a collapsed native details disclosure. Preserve actual protocol/result/process failures as alerts. Clear notices for a new CLI process, New chat and workspace transition. Regression: warning → successful result keeps notice, leaves error null, unlocks; terminal failure still appears; reset/stale-channel behavior.

Relevant code/docs: claude-store, use-claude, MessageList, existing store race tests, React guidelines. Existing spike work is uncommitted because Git index writes were denied, including elevated execution.

Completed: separate notices buffer, focused hook and native details disclosure. No CLI policy/configuration changes. Two regression scenarios cover success/error retention, deduplication, bounds, process restart, New chat, workspace reset and stale callbacks. Independent QA review found no P1/P2 issues. Browser mock transport reproduced stderr warning → successful edit, kept notices collapsed after completion, and verified Space/Enter expand/collapse. Screenshot `.context/chat-cli-notices.png`. Targeted store tests: 12 passed; full frontend suite: 742 passed across 58 files. Formatting/lint/types pass. Git commit remains blocked by the previously verified external worktree index restriction.
