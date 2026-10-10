# Claude Code tool approvals

Chat must let users approve or deny tool permission requests from their installed Claude Code, including configured MCP tools. Preserve existing account/configuration and `acceptEdits` behavior. Approval is per request; never persist permission changes or override policy/authentication.

Use the stream-json host control protocol. Display the exact tool name and complete input before approving once or denying. Queue simultaneous requests, prevent duplicate responses, and remove canceled requests. Reopen a hidden panel when approval is needed. Stop, workspace changes, terminal results, and process exit invalidate pending decisions. Errors sending a decision must remain visible and recoverable while notes stay locked. Unsupported host requests must receive an explicit error rather than hang.

Validate the protocol against the real installed CLI using harmless isolated Bash calls forced to ask, and test cancellation, stale responses, queueing, and transport errors. Verify the actual panel with a mocked transport in the browser. Native automation limitations and pre-existing test failures must be reported.

## Protocol and boundaries

Launch uses `--permission-prompts host --permission-prompt-tool stdio`. The installed CLI was verified to send `control_request` / `can_use_tool` without an SDK initialization request. Writer responds with `control_response`, success and request ID, plus either `behavior: allow` and unchanged `updatedInput`, or `behavior: deny` and a message. No `updatedPermissions` are sent. IDs are deduplicated per process. Cancellation invalidates pending UI and in-flight decision completions. Terminal reconciliation closes approval intake synchronously; late requests are denied.

The panel automatically opens on a pending request. Requests are queued and displayed individually; inputs are keyboard-scrollable without truncation. Changing the queue head resets scroll positions. Decision delivery errors leave a retryable request. Unknown host control subtypes receive a protocol error and CLI notice. MCP authentication/elicitation forms and interactive question forms are outside this change; existing terminal authentication still applies.

Protocol references: [official SDK control handling](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py), [CLI reference](https://code.claude.com/docs/en/cli-reference). These are references only; Writer bundles no SDK.
