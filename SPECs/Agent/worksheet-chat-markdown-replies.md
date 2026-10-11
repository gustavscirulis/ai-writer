# Chat Markdown replies

Task/spec: [chat-markdown-replies.md](../chat-markdown-replies.md), current TODO.

Reviewed: ChatMessage/AssistantTurn, message-list, chat CSS, use-conversation-scroll, streaming spec, desktop dependencies, editor's inline table parser and link-navigation, React/consolidation docs and typography skill. Existing replies are `<p>{message.text}</p>`; the table renderer covers inline cells only, not full Markdown. Existing ResizeObserver already follows content growth only near the bottom.

Plan: add react-markdown + remark-gfm to desktop via vp; introduce a small memoized MarkdownReply component with stable plugin/component registries. Render per-message Markdown inside a styled div, supply a message-specific footnote prefix, safely route external links to OS opener and report errors. Scope Markdown CSS to Chat, including bounded pre/table scrolling and readable nested lists. Wire AssistantTurn to the component; keep user/tool text unchanged.

Test strategy: React renderToStaticMarkup of production component, structural/escaping assertions, sequential incomplete/complete snapshots and assistant/user integration. Exercise the actual production opener helper for success, failure, unsafe destinations and native fragments. React render tests live under tests/react with a tsconfig extending desktop; existing node tests retain their configuration. Run full vp check/test/build. Browser/native appearance and system opener remain unverified due earlier dismissed localhost permission.

Workspace: previous requested changes remain uncommitted because Git metadata is denied. Untracked playground prototypes predate the task. Preserve them and update the prepared PR body / publication commands with this feature.

Implementation: react-markdown + remark-gfm render each assistant text step with primitive memo props and stable registries. Chat CSS restores semantic lists/headings and bounds code/tables; keyboard-focusable scroll regions retain the global focus indicator. Raw HTML is skipped; only web/email links route to the system opener, with inline failure alerts, and images allow only web URLs. Footnote reference/definition prefixes plus scoped heading IDs and aria-describedby avoid collisions across messages (the parser does not prefix its fixed footnote heading).

Review: React/Frontend, UX and QA plan reviews approved; accepted keyboard-scroll and production-helper test guidance. Implementation reviews found a P2 stale link-error risk during streamed href changes; keying the stateful ReplyLink by the sanitized href resets attempts/errors. React and QA re-reviewed the fix; all personas gave green lights with no remaining findings. Memo behavior and error lifecycle are source-reviewed; SSR does not test mounted state updates.

Validation: vp check passes with the existing wdio type warning; 849 tests pass (15 new renderer/link cases); desktop frontend build passes with existing Vite/chunk warnings. No Rust changes. Browser/native spacing, overflow, reader-follow, footnote navigation and real system-opener QA remain unverified under the existing browser permission limitation. Git commit/push remain for the user's terminal because worktree metadata writes were denied earlier.
