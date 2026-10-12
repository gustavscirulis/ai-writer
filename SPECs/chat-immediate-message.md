# Show submitted messages immediately

An accepted Chat send adds its user message synchronously in the same per-note store update that clears a matching composer draft and starts Thinking. The empty conversation state should disappear as soon as Send is pressed, before autosave, note reads, prompt preparation, session loading, Claude startup or input acknowledgement.

Keep one message per accepted attempt, using the current text trimming and attachment shape for ordinary, suggestion and feedback sends. Reject empty/busy/invalid sends without adding a message. The later transport stage must not append it again. Messages belong to their originating canonical note; startup callbacks must not recreate them after New chat or workspace reset.

Keep the submitted message through Stop and save/start/send failures. Existing inline errors and conditional composer restoration provide recovery; a retry is a new accepted attempt. Preserve newer drafts, pending attachments, native ownership, save/lock sequencing and result-before-ack handling. No new delivery status, message type, UI component or IPC changes.

Validation: deferred save/start/delivery and attachment sends show a single message immediately; failure and Stop retain it, rejected sends add none, switching notes isolates it, and cleared chats/workspaces are not repopulated by stale completion. Use the production store tests plus frontend checks and build; rendered QA if the environment permits browser launch.
