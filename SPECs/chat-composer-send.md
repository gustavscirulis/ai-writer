# Clear the composer on send

- An accepted ordinary Chat send clears its matching composer draft synchronously, before saving the file, starting Claude or waiting for its input acknowledgement.
- Rejected empty/busy/invalid sends keep the draft. A failed save/start/send restores the original draft only if the originating turn/workspace still owns the attempt and its draft remains empty.
- New text entered during startup or a reply remains intact. Another note's draft and feedback-apply/suggestion sends that do not match the composer are unaffected.
- The Chat store owns this lifecycle; the composer consumes attachments on successful delivery and no longer clears the draft after awaiting it.

Validation: deferred startup/delivery, failure restoration, newer drafts, workspace transitions and rejected/unrelated sends in the existing Chat store suite. Frontend checks/tests/build; native QA remains pending.
