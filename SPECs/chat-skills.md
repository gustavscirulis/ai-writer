# Claude Code skills in Co-writer

Typing `/` in the Co-writer composer lists the user's Claude Code skills and custom commands, the same ones `/` shows in a terminal session for that workspace. Picking one fills the composer with `/name `, and sending runs the skill.

## Listing skills

The SDK `initialize` control response carries `commands: [{name, description, argumentHint, aliases?, builtin?}]`. The capabilities probe (`claude_capabilities`, see [the empty state](co-writer-empty-state.md#mcp-servers)) already sends `initialize`, so it keeps that list next to the MCP servers: no second CLI start and no model call. It's cached per root with the servers and refreshed once per launch.

Built-ins (`builtin: true`, such as `/clear`, `/model` or `/code-review`) are left out because they manage a terminal session Writer doesn't have. Names with spaces (MCP prompts like `claude.ai Figma:… (MCP)`) are left out too, because they can't be typed as one word.

## Menu

The menu opens while the whole draft is `/` followed by one word, and shows skills whose name, or the part after a `plugin:` namespace, starts with that word, followed by skills that contain it. Each row shows `/name`, the argument hint and a one-line description. ↑/↓ move, Enter or Tab fill in `/name `, and Escape closes the menu until the draft changes. Clicking a row also fills it in. The textarea keeps focus and drives the list through `aria-activedescendant`. The menu doesn't show until skills are known, and typing is never blocked.

Enter fills in rather than sends, so a skill that needs instructions doesn't run without them. A second Enter sends.

## Sending

Claude Code only expands a skill when the user message starts with `/name`. Every turn normally starts with the `<writer_context>` block, so when the message starts with a known skill name or alias the block moves after it. The CLI then passes the rest, context included, as the skill's arguments. Other text that starts with `/`, such as a path, stays context-first and is sent as typed.

Checked with CLI 2.1.296: `/ux-copy …` in a `-p --input-format stream-json` turn expands even though Writer's `--tools` list has no `Skill` tool.

## Limits

- Skills run with Co-writer's tool allowlist. A skill whose instructions need `Bash` or other tools Co-writer doesn't offer can't do those steps.
- A `/skill` sent before the list has ever loaded for the workspace goes out as plain text.
- Queued messages are merged into one turn, so a queued `/skill` isn't expanded.

## Validation

Rust tests cover parsing the commands list (built-ins and spaced names dropped) and errors from either control response. An ignored real-CLI test lists servers and skills. Frontend tests cover the slash query, ranking, prompt ordering (known skill, alias, path, near-miss name), caching and the menu markup. `e2e/specs/co-writer-skills.spec.js` drives the menu in the built app.
