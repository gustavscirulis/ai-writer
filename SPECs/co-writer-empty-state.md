# Co-writer empty state and tool-aware suggestions

Chat is renamed **Co-writer** in every user-visible string (panel header and labels, "Add to Co-writer", command palette, settings, startup errors). "New chat" becomes "New conversation". Internal identifiers, settings keys and stored data keep their names.

## Empty state

Chosen from two prototype rounds. Everything sits at the bottom of the panel, just above the composer, left-aligned: a large "What are we working on?" heading, the subtitle "Ask for research, a first draft or edits to this note.", four plain suggestion rows (icon, label, ↵ on hover) and one footnote line. Clicking a suggestion sends its label as the message.

The footnote reads "Runs on your Claude Code, with the same tools and MCPs.", or "…with the same tools." when no MCP server is connected. It says Co-writer has whatever the user's Claude Code has, rather than counting or naming servers, which the rows already show. Centred layouts, a bordered card, chips and tiles were tried and rejected as too busy.

The composer placeholder is "Ask anything, or describe a change…" and its hint "Select text or ⌥-click to point at it".

## MCP servers

`claude_mcp_servers(root)` starts Claude Code in the workspace with normal MCP discovery, sends the SDK `initialize` and `mcp_status` control requests, reads the server list (name, status) and kills the process group. No prompt is sent, so there's no model call. It takes about 6s and runs once per root per launch. The last list is cached in `preferences.json` (`co-writer.mcp-servers`, keyed by root) so the suggestions and footnote show immediately on later launches.

Only `connected` servers count. Servers are shown by display name (`plugin:base:glean` → Glean, `claude.ai Google Drive` → Google Drive), deduplicated by that name.

## Suggestions

Up to three connected tools from a registry ordered by usefulness to a writer (Glean, Snowflake, Google Drive, Notion, Coda), filled to four with built-in ones: find recent sources on the web, fact-check claims on the web, find related notes in the workspace.

The list never changes after it first appears. On the first launch for a workspace, before discovery finishes, the empty state shows no list and no footnote; both fade in once. If discovery fails and nothing is cached, it shows the built-in suggestions and the footnote that mentions MCPs.

## Rejected: suggestions written for the note

An earlier version had Haiku write suggestions from the start of the note, replacing the registry list when ready. Each run took 8–15s: about 5s for Claude Code to start, then 3–9s for Haiku depending on whether it chose to think. Neither `--max-thinking-tokens 0`, `MAX_THINKING_TOKENS=0` nor prompting reliably turned thinking off, and a pre-started process saved only 1–2s. The late swap also changed the list under the user. It also sent note text to Anthropic without an explicit action.

## Validation

Rust unit tests cover the command arguments and `mcp_status` parsing. An ignored real-CLI test lists the servers. Frontend tests cover display names, suggestion filling, footnote wording, caching and the failure state.
