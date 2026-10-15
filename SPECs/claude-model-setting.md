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
- The dropdown names the version each choice runs: `Default · Opus 5.5 (1M context)`, `Fable 5.1`, `Opus 5.5` and so on. These names come from the capabilities probe (`claude_capabilities`), which makes no model call:
  - `initialize` returns Claude Code's model list (`value`, `displayName`, `resolvedModel`).
  - `get_settings` returns `applied.model`, the model the CLI runs without `--model`, after user, project and managed settings. Default shows that model's name. When nothing is configured, Default falls back to the CLI's own `default` entry.
  - Until the probe reports, or if it fails, options show plain names (`Default`, `Opus`). A model ID the list doesn't name is shown as-is.
- Settings starts the probe only while it is open, and reuses the per-launch, per-workspace result the chat panel uses. A CLI settings change made while the app is running shows after a relaunch.
- The capabilities probe never passes `--model`.

## Ownership

- `apps/desktop/shared/settings.schema.json` owns the key, options, default and scope. The generic settings panel renders the dropdown.
- `commands/agent/capabilities.rs` owns asking Claude Code for its models. `lib/claude-models.ts` (`modelOptionLabel`) owns turning them into option labels. `SettingControl` takes an optional `optionLabel` for enum display text.
- `commands/agent/claude.rs` owns reading the value (`configured_model`, under the same settings lock as the allowed-tools load) and building the command (`scoped_command`).

## Tests

- TypeScript schema test asserts the setting contract.
- `tests/claude-models.test.ts` covers labels for aliases, a configured CLI model (including `[1m]`), the fallback to the recommended default, and plain names before the probe reports.
- Rust tests cover parsing the model list and `applied.model`. The ignored real-CLI capabilities test checks that `opus` is listed.
- Rust tests cover `--model` being added when an alias is set, being absent for the default, and unknown values being rejected.
