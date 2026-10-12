# Clear the composer on send

- An accepted ordinary Chat send clears its matching composer draft synchronously, before saving the file, starting Claude or waiting for its input acknowledgement.
- Every accepted send also inserts its user message in that same state update, so the conversation replaces its empty state immediately. The submitted bubble is retained through failures and Stop; inline errors and conditional draft restoration provide recovery. See [immediate messages](chat-immediate-message.md).
- Composer Enter while the note's turn is running queues the draft instead of sending; see [Chat queue](chat-queue.md). Rejected empty/busy/invalid store sends keep the draft. A failed save/start/send restores the original draft only if the originating turn/workspace still owns the attempt and its draft remains empty.
- New text entered during startup or a reply remains intact. Another note's draft and feedback-apply/suggestion sends that do not match the composer are unaffected.
- The Chat store owns this lifecycle; the composer consumes attachments on successful delivery and no longer clears the draft after awaiting it.

Validation: deferred startup/delivery, failure restoration, newer drafts, workspace transitions and rejected/unrelated sends in the Chat store suite. Parallel note tests cover delivery ownership through result/ack interleaving and lifecycle admission. Browser QA verifies simultaneous sends and independent controls; the native two-note actor/CLI probe passes.
