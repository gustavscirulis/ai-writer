/**
 * Swallow the single `click` that the browser fires after a drag completes, so
 * dragging an item never also opens/selects it. Self-removes after that click
 * (or on the next tick if no click arrives).
 */
export function suppressNextClick() {
  const handler = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    window.removeEventListener("click", handler, true);
  };
  window.addEventListener("click", handler, true);
  setTimeout(() => window.removeEventListener("click", handler, true), 0);
}
