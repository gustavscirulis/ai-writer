# Chat web tools worksheet

Task: enable built-in WebSearch/WebFetch; see [spec](../chat-web-tools.md) and TODOS.

Reviewed current launch flags, native scope/permission classifier, hook initialization, existing command/approval tests, tool request summaries and owning Chat specs. Earlier MCP implementation remains uncommitted due external Git metadata permissions; preserve it as authorized work. No frontend components or state flow change is necessary.

Plan: add both web tools to launch availability, hook matcher and native host permissions. Extend existing tests with real query/URL-shaped inputs and parameterize frontend approval cases. Update owning specs and changelog. Keep note edits and unsupported-tool restrictions unchanged; inherit CLI permission policy without auto-allowing web tools.

Implementation: WebSearch/WebFetch added at launch, hook matching and native host-permission admission. No web auto-allow flags added. Native tests use complete query/domain and URL/prompt inputs; the actor fixture captures the actual initialization frame and validates its matcher with regex-lite. Existing frontend approval and generic summary tests cover both web tools. Owning Chat specs and changelog updated. Rust/Tauri and QA plan/implementation reviewers found no blocking issues.

Validation: vp check passes with the existing warning, 884 frontend tests pass, native agent suite passes (12 tests; live MCP test opt-in), cargo clippy/fmt pass with existing unrelated warnings. Full cargo test: 183 pass, one pre-existing Finder trash failure, one opt-in test ignored by default. The initial native run had one timing-sensitive existing concurrent-actor fixture failure; targeted rerun and final full run pass that test. QA identified its 0.2-second result delay; deterministic fixture signaling recorded as a separate TODO without weakening assertions.

Live CLI probe: .context/check-chat-web.py uses current source launch flags and hook matcher, inherited CLI policy, and a temporary note. It completed actual WebSearch and WebFetch calls, handled a WebFetch host approval and verified the note stayed unchanged. This proves live CLI availability; production native permission routing is covered by native actor/unit tests. No customizations, policy or persistent approvals changed.

Earlier Git metadata staging attempts remain blocked even with elevation, so this task and the earlier MCP changes remain uncommitted. No production UI changes require another browser launch.
