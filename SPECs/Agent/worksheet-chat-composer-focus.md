# Chat composer focus

Task: remove the orange inner selected/focus state shown in the user's screenshot, matching the app's existing inputs.

Reviewed: user screenshot; Chat composer and chat-panel CSS; App.css focus rules/tokens; settings controls, search inputs, document header and frontmatter inputs. The app has one current Chat composer. Other input surfaces suppress the global accent outline and use the neutral `--focus-border` treatment.

Cause: the unlayered global `:focus-visible` outline overrides the textarea's Tailwind `outline-none`. The rounded composer already defines `focus-within:border-[var(--focus-border)]`.

Fix: identify the composer shell with `data-chat-composer`, and include only its textarea in App.css's existing focus-visible exceptions. Retain the shell focus border and button focus outlines. This is a small styling correction; no new tests or spec needed.

Workspace: prior selected-text changes remain uncommitted because worktree metadata writes were denied, and unrelated playground prototypes predate this task. Keep all of them intact.

Validation: vp check passes with the existing e2e/wdio.conf.js warning; all 834 tests pass; desktop frontend build passes with existing toolchain/chunk warnings. The emitted stylesheet includes the scoped outline exception, and the shell's neutral focus-within border remains. Rendered/native QA remains unverified due the earlier dismissed browser permission request.

Commit remains blocked: ordinary and escalated git add both failed to create the worktree index.lock with “Operation not permitted”. Changes are saved and unstaged.
