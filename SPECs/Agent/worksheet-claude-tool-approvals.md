# Tool approval worksheet

Task: [spec](../claude-tool-approvals.md).

Implemented host/stdio tool approvals without an SDK dependency. Frontend owns protocol and per-request decisions; Rust owns serialized process input and cancellation. Exact inputs are shown, approvals do not update permission rules, and process-scoped request IDs prevent duplicate decisions. Terminal reconciliation immediately closes approval intake. Unknown interactive controls return explicit protocol errors.

Validation:

- Real installed CLI, existing terminal account, isolated synthetic workspace, forced harmless Bash approval: allow executed `python3 -c "print(12345)"`; deny did not execute. Both completed successfully and emitted the expected host control envelopes without initialization. Fixtures are in ignored `.context/approval-fixture-{allow,deny}.json`.
- Approval/parser tests: 27 passing, including queueing, cancellation during delivery, retryable failure, Stop/stale channel, terminal/exit/workspace clearing, duplicate completed IDs, late requests during reconciliation, and delayed unsupported-response failure overlapping teardown.
- Full frontend suite: 754 passing tests. Tracked-source `vp check` pass (one existing e2e JSDoc lint warning). Rust process tests: 3 passing; clippy and fmt pass with existing warnings. Full Rust suite: 170 passed, one existing Finder trash test failure because AppleScript cannot access Finder in this environment.
- Independent State/Startup, Rust/Systems and Frontend/UX/QA reviews resolved findings about terminal intake, error retention, duplicate request IDs and scroll reset between queued inputs.
- Browser verification attempted with actual panel/layout/store plus mocked IPC. The localhost security permission request was dismissed; browser tool blocked access. Rendered keyboard/minimum-window QA and actual native MCP approval remain unverified. No screenshot was captured for this task.

Git commit blocked: ordinary and escalated `git add` both failed creating `/Users/gustavscirulis/GitHub/ai-writer/.git/worktrees/houston-v2/index.lock` with Operation not permitted. All source changes remain unstaged and available for review.
