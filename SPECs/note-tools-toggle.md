# Note tools: History and Co-writer toggles

## Problem

Version history and Co-writer were opened from two mismatched controls at the window's top right: a bare clock icon and a plain "Co-writer" text button. Opening Co-writer hid both, and the clock reappeared inside the Co-writer header next to a close button. The control that opened something was not where you closed it, and history (a note feature) lived in the chat's header.

## Decision

Two prototype rounds. The first picked "Anchored", a segmented control with History and Co-writer labels. In use it read as a tab selector, as if the two were mutually exclusive views, when they are independent toggles. The second round (Mirrored, Collaborator, Edges) picked "Mirrored".

- `NoteTools` (`components/note-tools.tsx`) sits at the window's top right on every note-like tab. It holds two separate icon buttons with no shared container: a clock for **History** and a right-sidebar icon for **Co-writer**. The right-sidebar icon mirrors the left sidebar toggle in style and size.
- The pressed state swaps the outline glyph for a filled one (a solid clock, or a sidebar with its right pane filled) instead of putting a chip behind the button. The free Hugeicons set has no solid variants, so the filled glyphs are drawn in `note-tools.tsx`. `aria-pressed` carries the state.
- The buttons never move. When Co-writer opens, the panel slides in underneath them and they end up over the panel header, so pressing Co-writer again closes it. The panel header keeps its title and the New conversation button. New conversation only shows once the chat has messages.
- History is hidden when there is no note (workspace chat).
- `NoteTools` publishes its width as `--note-tools-width` on `[data-app-layout]`, and the tab strip and the Co-writer header pad by that amount rather than a hard-coded width. The header hides its title when the panel is too narrow to fit it beside the buttons.
- The panel fades and slides in 12px over 220ms on mount, with no motion under reduced motion. It only animates when the window is visible at mount. WKWebView holds animations on their first frame in a hidden window, which left the panel at opacity 0 in the e2e harness. The same would happen if the panel mounted before the window is shown at launch.

The shortcuts (⌘⇧H, ⌘⇧L) and the command palette entries are unchanged.
