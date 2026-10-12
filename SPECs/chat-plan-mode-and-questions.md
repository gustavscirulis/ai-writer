# Co-writer: Claude's questions and plan mode

Claude Code can stop to ask the user something (`AskUserQuestion`) and, in plan mode, can explore read-only and submit a plan for approval (`ExitPlanMode`). Co-writer supports both. They wait in the same slot as tool approvals, taking the composer's place, and they count toward the Dock badge and the tab indicator. See [tool approvals](claude-tool-approvals.md) for the shared prompt and native enforcement.

## Protocol

A real-CLI probe (Claude Code 2.1.296, `--permission-prompts host`) confirmed the following:

- `AskUserQuestion` arrives as `can_use_tool` with `requires_user_interaction: true`. Its input is `{questions: [{question, header, options: [{label, description}], multiSelect}]}`. To answer, reply allow with `updatedInput = {questions, answers: {[question text]: answer}}`. The tool result reads `Your questions have been answered: "Q"="A". …`, and the user message also carries `tool_use_result: {questions, answers}`, which Co-writer uses to show the answers in the thread. A deny reply is reported to Claude as the user declining.
- Plan mode is `--permission-mode plan`. Claude explores read-only, and it can still call `AskUserQuestion`. Before submitting, the CLI Writes its plan to `~/.claude/plans/<slug>.md` (or under `CLAUDE_CONFIG_DIR`). That Write goes through the PreToolUse hook and `can_use_tool` like any other edit.
- `ExitPlanMode` arrives as `can_use_tool` with input `{plan, planFilePath}`. An allow reply approves the plan: the CLI switches itself to `default` mode, no permission update is needed, and Claude carries on editing in the same turn. A deny reply with a message sends Claude back to revise the plan.
- The CLI's `plansDirectory` setting must be inside the project root, so Co-writer leaves the plan file where the CLI puts it rather than moving it into the workspace.

## Questions

- Native code holds the request like any other host approval. A question is never answered from Always allow, and `claude_start` rejects it as an always-allowed tool.
- Native code checks the answer before it is sent. The frontend sends only `{kind: "questions", answers}` through `claude_answer`, and native code keeps the questions it received:
  - The answers must cover exactly the questions Claude asked.
  - Each answer must be 1–2,000 characters.
  - An answer that fails these checks is rejected, and the request stays pending.
  - `answers: null` declines.
- A malformed `AskUserQuestion` request, such as one with no questions or a question without text, is denied with a reply to Claude. It doesn't end the turn.
- The prompt (`question-prompt.tsx`) shows one question at a time:
  - At the top: the `header` as a small label, the question, and "n of N" when there are several.
  - Options form the same keyboard list as approvals: ↑/↓ move, Enter picks, and number keys pick directly. Descriptions appear under labels.
  - "Type your own answer…" opens a text field, where Enter answers and Esc closes the field.
  - For multi-select, options toggle, any typed text is added, and the answer is sent joined by ", ".
  - Back (or ←) returns to the previous question. Esc, or "Don't answer", declines.
  - All answers are sent together after the last question.
- The thread shows "Asked" in the tool list, with each question and its answer.

## Plan mode

- The composer has a Plan toggle next to +. Shift+Tab in the message box also toggles it, which replaces backwards focus there. While Plan is on, the placeholder reads "Describe what you want planned…".
- The toggle is per chat and in memory only, like Always allow. A new chat clears it. `send` passes it to `claude_start` as `plan`, which selects `--permission-mode plan` instead of `manual`.
- Native code (`Scope.planning`) enforces plan mode on top of the CLI's own gate:
  - While planning, Edit/Write are denied, including the chat's own note through the hook. The only exception is a Markdown file directly inside the CLI plans directory, which is allowed without a lock or an edit start.
  - `ExitPlanMode` is denied outside plan mode.
- The frontend answers with `{kind: "plan", approve, feedback}` through `claude_answer`.
  - Approving clears `planning` natively, and the frontend switches the toggle off. Later edits in the same turn then go through the normal approval rules.
  - "Keep planning" denies with "The user wants to keep planning. Revise the plan before editing." plus any feedback (trimmed, at most 4,000 characters).
- The prompt (`plan-prompt.tsx`) renders the plan as Markdown in a scrollable area. "Yes, start writing" approves. "No, keep planning" opens a feedback field, where Enter sends (empty is fine) and Esc closes it. Esc on the card means keep planning with no feedback.
- The thread shows each plan as a collapsible "Plan" card marked Approved, Kept planning or Waiting for approval. The plan file Write stays in the tool list, but it isn't a link, because only notes inside the workspace open from there.
