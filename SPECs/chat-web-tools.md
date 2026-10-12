# Web tools in Chat

Enable Claude Code's built-in WebSearch and WebFetch alongside the existing file and MCP tools. Include both in CLI tool availability, native hook matching and the host permission classifier. Requests requiring approval use the existing request-local Allow/Deny flow and preserve original query/URL inputs. CLI permissions and managed policy continue to apply; neither web tool is auto-approved by Writer.

Keep built-in Edit/Write confined to the canonical current note. Shell, subagent and other unsupported built-ins remain unavailable. No new UI, IPC or settings are needed. Generic tool summaries already expose full names, query/URL previews and raw inputs.

Validate launch arguments, active/inactive hooks and approvals, allow/deny input preservation and unsupported-tool rejection by extending the existing native cases. Cover WebSearch/WebFetch in the frontend approval queue and summary cases. Run frontend checks/tests and native agent tests, Clippy and formatting; use a temporary real CLI probe for availability and harmless web requests when feasible.
