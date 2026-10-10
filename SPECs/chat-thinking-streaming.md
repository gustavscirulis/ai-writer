# Chat thinking and answer streaming

Show a quiet `Thinking…` text shimmer immediately after Send and while Claude thinks or waits between tools. Distinguish writing and tool execution from thinking. Approval, Stop, completion, errors, New chat, and workspace changes must not leave a thinking indicator running. Respect reduced motion and forced colors. Announce status changes, not every streamed token. Do not show empty assistant bubbles.

Render text chunks as they arrive, without artificial typing delays. Reconcile completed per-content-block snapshots into their original block, preserving earlier text and tool results. Support multiple text blocks in one message, tool-only snapshots, snapshot-only messages, and repeated completed snapshots. Ignore private reasoning text. Keep partial answers after Stop or error. Continue following content growth only while the reader remains near the bottom, including layout changes when approval cards appear/disappear.

The existing CLI already enables partial message streaming. Verify against its captured stream and [official streaming protocol](https://code.claude.com/docs/en/agent-sdk/streaming-output); no transport or dependency change is required. This task concerns plain-text answer streaming; Markdown rendering is a separate feature.
