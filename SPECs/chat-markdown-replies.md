# Markdown replies in Chat

Render assistant replies as Markdown during streaming and after completion. User messages, tool output and attachment labels keep their current plain-text behavior.

- Support CommonMark plus GFM: headings, emphasis, strikethrough, paragraphs, lists/task lists, quotes, links, fenced/inline code, tables and footnotes.
- Use a maintained React Markdown renderer rather than the editor's edit-mode pipeline or a partial custom parser. No raw HTML execution or dangerous URL protocols.
- Re-render each assistant message's current text directly as it streams. Incomplete fences and inline syntax must remain readable; preserve prior text/tool steps and partial replies after Stop. Memoize by message text/id so completed messages do not reparse on unrelated activity.
- Use existing fonts, colors and spacing. Code and tables scroll horizontally inside the panel; long prose/URLs wrap. Avoid editor-sized headings in the narrow column.
- External web/email links use Tauri's system opener with a visible error on failure. Unsupported relative/non-web links remain text; fragment links support message-local footnotes with unique prefixes. Images use safe web destinations and bounded sizing.
- Do not change the stream transport, persistence or reader-follow behavior.

Validation: actual React server rendering with the production component; core/GFM structures, incomplete-to-complete streaming snapshots, hostile HTML/URL input, footnote ID isolation, and assistant versus user message rendering. Check/build/test; browser/native QA remains pending the existing permission limitation.
