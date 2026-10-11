# Claude Code tool approvals

Chat displays native, request-local approvals for Read, Glob and Grep. Each note owns its approval queue; a background request updates its tab indicator without switching notes or taking focus. Activating the indicator opens that note's Chat. For the selected note, an approval may open a hidden panel. Inputs remain keyboard-scrollable and available in full before Allow once or Deny.

## Native enforcement

Writer requires Claude Code 2.1.296 or newer and verified stream-json hook support. Startup uses safe mode, manual host permissions and only Read/Glob/Grep/Edit/Write. Ordinary customizations, Bash, subagents and MCP are disabled; existing terminal sign-in remains available. Unsupported startup fails explicitly.

Before delivering the user prompt, native code sends SDK `initialize` and requires its successful response, registering a PreToolUse hook. Edit/Write resolve the supplied absolute path natively, allow only the captured canonical note, and reply with its canonical I/O path. Other targets, missing/relative paths and unknown tools are denied without an approval override. Broad edit permission does not bypass the hook. Read tools retain request-local host approvals.

The native actor owns stdin and all control replies. `claude_decide_permission` accepts process ID, request ID and a boolean; the retained native request supplies the tool input. Frontend input IPC accepts only a user message, so forged control responses cannot escape scope enforcement. Decisions are single-use and process-local. Stop, terminal results, hook failure and workspace teardown invalidate pending approvals. Failed decision delivery stays visible in that note; transport/hook parsing/reply errors terminate and reap only the affected process. Ownership remains until termination and disk reconciliation succeed.

Unknown or malformed host callbacks fail closed, with bounded initialization, canonicalization and reply deadlines. No permission updates are persisted. MCP authentication, elicitation and interactive question forms are unavailable in these scoped runs.

## Validation

Native tests cover canonical aliases, out-of-note edits, relative/missing targets, forged and cross-process approvals, duplicate decisions, malformed hooks, cancellation and independent actors. An initial real CLI scope probe allowed A's edit and denied B's despite broad edit permissions. A production-command two-note integration probe completed concurrent own-note writes with context unchanged. Browser QA covers background approval indicators, keyboard activation and close/recovery while multiple runs remain owned.

Protocol references: [official SDK control handling](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py), [CLI reference](https://code.claude.com/docs/en/cli-reference). Writer bundles no SDK. See [parallel note agents](parallel-note-agents.md).
