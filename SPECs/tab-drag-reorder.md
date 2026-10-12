# Drag to reorder tabs

Let people rearrange editor tabs by dragging them along the tab strip, like Safari and Chrome.

- Press a tab and move the pointer at least 4px horizontally to start a drag. A plain click still selects the tab. Pressing the close × or the agent indicator never starts a drag.
- The grabbed tab follows the pointer horizontally and stays inside the strip. Its neighbours slide aside (150ms) once its leading edge passes their midpoint. The centre isn't used, because a tab wider than the first or last tab could then never pass it while clamped to the strip. With reduced motion, they jump instead.
- Release to drop. The order is saved through the editor store (`moveTab`), so session restore, Cmd+1…9 and next/previous tab follow it. The dropped tab slides from where it was released into its slot.
- Esc, or a cancelled pointer, ends the drag and puts the tabs back. If a tab opens or closes mid-drag, the drag is abandoned the same way.
- Dragging doesn't change the active tab, and the click after a drag is swallowed.
- Near the strip's left or right edge, the strip scrolls so the tab can reach tabs that are scrolled out of view.
- The drag uses pointer events, not HTML5 drag-and-drop, which Tauri's OS file drop suppresses (the same reason as the sidebar tree drag). Positions are applied directly in the DOM each frame. React renders once at the start and once at the drop.

Code: `src/components/editor-area/use-tab-drag.ts` (gesture), `tab-reorder.ts` (drop index and shift math, unit-tested), `editor-store.ts` `moveTab`.

Verification: `tests/tab-reorder.test.ts`, the `moveTab` test in `tests/stores.test.ts`, and `e2e/specs/tab-reorder.spec.js`. The e2e spec drives the gesture with synthetic pointer events in the built app and covers reorder, no activation, Esc and order after reload.
