# Co-writer Model Setting

## Goal

Let users choose which Claude model Co-writer chats run on.

## Behavior

- Settings → Co-writer has a **Model** dropdown with `default`, `fable`, `opus`, `sonnet` and `haiku`.
- `default` passes no `--model` flag, so the Claude Code CLI uses its own configured model. This is the default value.
- Any other option is passed to the CLI as `--model <alias>`. The CLI resolves each alias to the latest model in that family, so new model versions need no app update.
- Every chat turn spawns a new CLI process that resumes the session, so a change applies from the next message, including in an ongoing conversation.
- The setting is global, so it applies in every workspace and window. `claude_start` reloads the global config before reading it, so a change made in another window is picked up on the next turn.
- A value that isn't one of the schema options, for example a hand-edited config, stops the turn with an error that points to Settings → Co-writer. The value is never passed to the CLI.
- The capabilities probe (`claude_capabilities`) never passes `--model`.

## Ownership

- `apps/desktop/shared/settings.schema.json` owns the key, options, default and scope. The generic settings panel renders the dropdown.
- `commands/agent/claude.rs` owns reading the value (`configured_model`, under the same settings lock as the allowed-tools load) and building the command (`scoped_command`).

## Tests

- TypeScript schema test asserts the setting contract.
- Rust tests cover `--model` being added when an alias is set, being absent for the default, and unknown values being rejected.
