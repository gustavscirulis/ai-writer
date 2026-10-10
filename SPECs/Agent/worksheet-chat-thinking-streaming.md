# Thinking and streaming worksheet

Task: [spec](../chat-thinking-streaming.md).

Baseline is the uncommitted Chat spike and approvals from this session; Git index writes remain blocked. Reviewed stream parser/reducer, Claude store, MessageList, scroll hook, React/Zustand guidelines, existing real CLI fixture, and official streaming docs. The CLI emits per-block snapshots before block_stop; replacing all text for each snapshot loses earlier blocks.

Plan: retain indexed text blocks and correlate snapshots by current stream block (or snapshot UUID when no partial stream exists); expose current activity through a narrow hook; add CSS text shimmer and memoized message rendering; observe scroller as well as contents for streaming follow. Test lifecycle/block reconciliation and verify rendered UI if browser permissions permit.

Implemented indexed text block reconciliation, snapshot UUID deduplication, streamed tool starts and explicit activity phases. Private thinking text is ignored. The status has a CSS text shimmer with reduced-motion/forced-colors fallbacks and a terminal live announcement. Message rows are memoized; the scroll observer follows both content and viewport growth while respecting scrolling away.

Validation: 40 targeted tests pass, including multiple text blocks, repeated/snapshot-only replies, partial answers, old interrupted tools across turns, every activity reset boundary, scroll-away/return and observer cleanup. Independent QA replayed the captured real CLI fixture and confirmed incremental text before terminal completion, completed tools and no duplicated final answer. Full frontend suite: 767 tests pass; tracked-source vp check passes with one existing e2e JSDoc lint warning. No Rust changes in this task.

Independent State/Systems, Frontend/UX and QA reviews resolved findings about old tool activity and terminal announcements, with no remaining code findings. Browser verification retried but blocked again by dismissed localhost security permission; shimmer appearance, media-query rendering and native/browser event timing remain unverified. No screenshot captured.

Git staging remains blocked creating the external worktree index lock (Operation not permitted). All code remains available in the working tree.
