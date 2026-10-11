# Paragraph feedback worksheet

Spec: [paragraph-feedback.md](../paragraph-feedback.md). Task: paragraph feedback for AI writing in TODOS.

Reviewed: prototype feedback context/panel/connectors and apply hook; Writer editor docs, React/Zustand/consolidation guidelines, editor layout/extensions/view registration, Claude store and handoff, preferences, rename/move owner, existing Claude/agent tests.

Plan: implement syntax targets and safe anchors first, persistent feedback owner second, request-local Claude completion third, editor capture and separate linked bubble column fourth. Keep existing disk-write and undo pipeline. Validate with focused target/store/Claude tests, rendered mocked IPC, and native probe where available. Separate review agents receive this worksheet/spec and their owned docs.

Baseline: clean tree at 9678ed2. vp install unchanged; vp check passes with one pre-existing warning; 767 frontend tests pass. Rust checks pending. No branch rename.

Plan-review decisions: active request record owned by Claude finish, exactly-once settlement including explicit cancellation; submitted bubbles locked and text captured. Hydration gates mutations and awaits earlier writes; strict persistence awaits set/save and exposes retry after failure. One path/body checkpoint maps each revision once; stale view clicks rejected. writer.swap/reload recover, ordinary local transactions map and revalidate exact kind/bounds; broad agent replacements recover untouched text. Capture pointerdown, mousedown, mouseup, and click ahead of widgets without intercepting explicit controls. At narrow widths transiently collapse sidebar before hiding chat; approval temporarily occupies the right slot. Keyboard command targets or reattaches at the retained caret; focus returns to editor on composer Escape. Applied status records completed requests, independent of document Undo, which is also exposed in Feedback. Partial changes show Review changes (navigate document) plus acknowledgement before retry.

Implementation/results: pending.
