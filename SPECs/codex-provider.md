# Co-writer on Codex

## Goal

Let Co-writer run on the user's installed, signed-in `codex` CLI as well as Claude Code. Everything Co-writer does on Claude Code should work on Codex too: streaming replies, note-scoped edits, cross-note edit approvals, Stop, resume, model choice, skills, plan mode, questions, the MCP list and "don't ask again".

## Behavior

- Settings → Co-writer → **Agent** chooses between Claude Code and Codex. The setting is global (`co-writer.agent`) and applies from the next message, in every workspace.
- The Model row follows the agent. Claude Code shows `co-writer.model`. Codex shows `co-writer.codex-model`, whose options come from Codex's `model/list`: Default (labeled with the model Codex is configured to run) followed by the models Codex lists. If the configured model isn't in Codex's list, the turn fails with an error that points to Settings → Co-writer.
- Every saved chat remembers which agent its session belongs to (`ChatRecord` version 2, `session: {id, agent}`). Version 1 records load as Claude Code sessions. A chat resumes only when its session matches the current agent. Otherwise the chat starts a fresh session and shows a notice: "This chat now runs on Codex, which doesn't have the earlier messages as context." The visible thread stays.
- If a resumed Codex thread no longer exists ("no rollout found"), Co-writer shows the same "can't be continued … Start a new conversation" message it shows for Claude Code.
- The empty state's footnote, Stop errors and stream errors name the current agent. Prompts that apply to both agents, such as questions, plans and the history tag, say "Co-writer".
- The minimum Codex version is **0.162.1**. With an older CLI the turn fails, and the error asks the user to update Codex in their terminal.

## How a turn runs

- `codex_start` spawns `codex app-server -c web_search="live"` in its own process group, with the workspace root as its cwd and the `PATH` from CLI discovery. Codex uses its own login. Co-writer never reads Codex credentials.
- The process lives for one turn, the same as Claude Code. The registry, note claims, Stop and reaping are shared through `agent::launch`. The next message resumes the thread by ID.
- Handshake:
  1. `initialize` with `experimentalApi`, then `initialized`.
  2. `skills/list`.
  3. `model/list`, only when a model is chosen.
  4. `thread/start`, or `thread/resume` with `excludeTurns`, with permissions `:read-only`, approval policy `on-request`, cwd set to the root, and developer instructions.
  5. `turn/start`, with `collaborationMode` set to plan or default.
- The developer instructions are the shared `system_prompt` (worded for `apply_patch`) plus Codex rules: one file per patch, never move, rename or delete, and shell commands are read-only.
- Native code owns every JSON-RPC response. It forwards only this thread's display notifications (`turn/*`, `item/started`, `item/completed`, message and reasoning deltas) to the frontend. It adds its own `writer/*` lines for the thread ID, host requests, resolutions, cancels and failures.
- `lib/codex-stream.ts` turns those lines into the existing `ClaudeEvent` union, so the chat reducer, approvals and prompts are shared. Commands that only read show as Read, Grep or Glob. Other commands show as Bash, patches as Edit or Write, MCP calls as `mcp__server__tool`, and web searches as WebSearch.

## Safety model

- Each thread runs with `:read-only` permissions. Native code checks that the response reports a `readOnly` sandbox and stops the turn if it doesn't. With no writable roots, every `apply_patch` reaches Co-writer as a `fileChange` approval request.
- Patches go through the same scope rules as Claude Code's Edit and Write (`agent/scope.rs`):
  - A patch to the chat's own note, or to a note already approved, gets an edit gate (`EditStart`/`EditReady`) and is accepted once the note is saved and locked.
  - A patch to another Markdown note in the workspace, outside hidden folders, asks the user first, with the same cross-note approval.
  - These are declined: anything outside the workspace or in a hidden folder, non-Markdown files, deletes, moves, patches that touch more than one file, `grantRoot` requests, patches while planning, and patches with no matching file-change item in this turn.
- Command escalations are always declined, and permission requests get an empty grant. The shell stays read-only.
- MCP tool approvals (`mcpServer/elicitation/request` with `codex_approval_kind: mcp_tool_call`) map to `mcp__<server>__<tool>`. That way the saved allowed-tools list, auto-approval and "don't ask again" work the same as on Claude Code.
- `item/tool/requestUserInput` shows as Co-writer's questions. Native code checks the answers against the questions and maps them back to Codex's question IDs.
- **Tradeoff:** Codex's read-only sandbox can read any file the user can, not only files in the workspace. Claude Code asks before reading outside the workspace. Codex has no per-read approval, so Co-writer can't offer the same check.

## Plan mode

- A plan-mode turn that ends with a plan item doesn't finish. Native code holds `turn/completed` and asks the user with an `ExitPlanMode` request.
- Approving the plan starts a default-mode turn on the same thread, in the same process, with the message "The user approved the plan. Implement it now." The reply keeps going in the same chat turn.
- Feedback starts another plan-mode turn with the keep-planning message.

## Not surfaced

- Codex's stderr is internal tracing, so it goes only to the app log. Config warnings and `warning` notifications show as chat notices.

## Ownership

- `commands/agent/codex.rs`: actor, handshake, request handling, skill and model parsing.
- `commands/agent/scope.rs`: edit scope rules, note claims, answer checks.
- `commands/agent/cli_env.rs`: CLI discovery and version check.
- `commands/agent/capabilities.rs`: `codex_capabilities`.
- `commands/agent/mod.rs`: shared launch, prompt and `agent_*` commands.
- `lib/agent-providers.ts`: the provider registry.
- `lib/codex-stream.ts`: the stream adapter.

## Tests

- Rust:
  - Actor tests on scripted JSON-RPC: own-note patch, cross-note request, declines, sandbox refusal, plan approval and feedback, questions, MCP approvals, resume, unknown models and Stop.
  - Capabilities parsing.
  - Ignored real-CLI tests `real_codex_edits_note` and `real_codex_plan_mode`, which take `CODEX_BIN`.
- JS:
  - `tests/codex-stream.test.ts` replays a trimmed real plan-mode transcript.
  - Store tests for switching agents, resuming a matching thread, the expired-thread message and an unknown agent.
  - Capability caching for each agent.
- E2E: `e2e/specs/co-writer-agent.spec.js` switches the agent in Settings and checks that the Model row follows.
