# Note tools: anchored History and Co-writer toggles

## Problem

Version history and Co-writer were opened from two mismatched controls at the window's top right: a bare clock icon and a plain "Co-writer" text button. Opening Co-writer hid both, and the clock reappeared inside the Co-writer header next to a close button. The control that opened something was not where you closed it, and history (a note feature) lived in the chat's header.

## Decision

Picked "Anchored" from a three-way prototype (Anchored, Status line, Composer-first).

- One segmented control, `NoteTools` (`components/note-tools.tsx`), sits at the window's top right on every note-like tab: **History** (clock) and **Co-writer** (bubble), each icon plus label, with `aria-pressed` showing what is open.
- It never moves. When Co-writer opens, the panel slides in underneath it and the control ends up over the panel header, so pressing Co-writer again closes it. The panel header loses its own History and Close buttons and keeps the title and New conversation.
- History is hidden when there is no note (workspace chat).
- `NoteTools` publishes its width as `--note-tools-width` on `[data-app-layout]`; the tab strip and the Co-writer header pad by it instead of a hard-coded width. The header hides its title when the panel is too narrow to fit it beside the control.
- The panel fades and slides in 12px over 220ms on mount (none with reduced motion). It only animates when the window is visible at mount: WKWebView holds animations on their first frame in a hidden window, which left the panel at opacity 0 in the e2e harness and would do the same when the panel mounts before the window is shown at launch.

Shortcuts (⌘⇧H, ⌘⇧L) and command palette entries are unchanged.
