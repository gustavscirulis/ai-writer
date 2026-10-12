# Co-writer: Claude's questions and plan mode

Claude Code can stop to ask the user something (`AskUserQuestion`) and, in plan mode, can explore read-only and submit a plan for approval (`ExitPlanMode`). Co-writer supports both. They wait in the same slot as tool approvals, taking the composer's place, and they count toward the Dock badge and the tab indicator. See [tool approvals](claude-tool-approvals.md) for the shared prompt and native enforcement.

## Protocol

A real-CLI probe (Claude Code 2.1.296, `--permission-prompts host`) confirmed the following:

- `AskUserQuestion` arrives as `can_use_tool` with `requires_user_interaction: true`. Its input is `{questions: [{question, header, options: [{label, description}], multiSelect}]}`. To answer, reply allow with `updatedInput = {questions, answers: {[question text]: answer}}`. The tool result reads `Your questions have been answered: "Q"="A". …`, and the user message also carries `tool_use_result: {questions, answers}`, which Co-writer uses to show the answers in the thread. A deny reply is reported to Claude as the user declining.

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
