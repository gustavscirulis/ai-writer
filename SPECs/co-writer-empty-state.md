# Co-writer empty state and note-aware suggestions

Chat is renamed **Co-writer** in every user-visible string (panel header and labels, "Add to Co-writer", command palette, settings, startup errors). "New chat" becomes "New conversation". Internal identifiers, settings keys and stored data keep their names.

## Empty state

Chosen from a playground prototype ("Quiet"): a centred mark, "What are we working on?", "Ask for research, a first draft or edits to this note.", and one card of up to four suggestions (icon, label, ↵ on hover). A footnote at the bottom says Co-writer runs on the user's Claude Code, with web search and their MCP servers, naming up to three. Clicking a suggestion sends its label as the message.

The composer placeholder is "Ask anything, or describe a change…" and its hint "Select text or ⌥-click to point at it".

## MCP servers

`claude_mcp_servers(root)` starts Claude Code in the workspace with normal MCP discovery, sends the SDK `initialize` and `mcp_status` control requests, reads the server list (name, status, tool names) and kills the process group. No prompt is sent, so there's no model call. It runs once per root per launch. The last list is cached in `preferences.json` (`co-writer.mcp-servers`, keyed by root) so the footnote and suggestions are right immediately on the next launch.

Only `connected` servers count. Servers are shown by display name (`plugin:base:glean` → Glean, `claude.ai Google Drive` → Google Drive), deduplicated by that name.

## Suggestions

Shown immediately: a static set from a registry ordered by usefulness to a writer (Glean, Snowflake, Google Drive, Notion, Coda), plus a web suggestion. Without known servers: web, fact-check and workspace suggestions.

Then `claude_suggest(root, systemPrompt, prompt)` runs one turn on the fastest model: `--model haiku --effort low --tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence --output-format json`, with a custom system prompt and the prompt sent over stdin. The prompt contains the connected servers with up to 15 tool names each, the note's workspace-relative path and its first 6,000 characters, marked as untrusted. The model returns a JSON array of `{label, tool}` showing research, data lookups, related documents, fact-checking or drafting from sources, not copy-editing. Writer keeps items whose tool is `web`, `workspace` or a listed server, drops duplicates, and requires at least two; otherwise the static set stays and the error is logged.

Generation runs once per note per launch, only for loaded notes with at least 80 characters, one at a time; while one runs, only the most recent request waits. A real run takes about 8–12s and costs about $0.001–0.003.

The list doesn't change under the pointer or keyboard focus. A late result waits until the pointer and focus leave, so a click always sends the label that was visible.

## Tradeoffs

- Opening Co-writer on an empty thread sends the start of the note to Anthropic through the user's Claude Code, without an explicit action. This is the same account and data path as a Co-writer turn.
- The suggestion run skips MCP loading and tools so it's fast and can't act. Server names come from the discovery run.
- `--json-schema` was rejected: it adds a second turn and took about 30s.

## Validation

Rust unit tests cover the command arguments, `mcp_status` parsing and result parsing. An ignored real-CLI test runs both commands. Frontend tests cover display names, fallbacks, footnote wording, prompt bounds, parsing, caching, the one-at-a-time queue and failure handling. A browser harness checked the real panel with mocked IPC: static → generated swap, label wrapping at 280px, and the hold under the pointer.
