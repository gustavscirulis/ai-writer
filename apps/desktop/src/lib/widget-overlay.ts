// A plain div rather than `<dialog>`, so layering and event handling don't
// depend on the user agent's modal-dialog quirks.

import { makeWidgetButton } from "./widget-buttons";
import "./widget-overlay.css";

export interface WidgetOverlayContent {
  /** The element that animates in and out; clicks outside it close. */
  panel: HTMLElement;
  /** Where focus goes on open. Defaults to the close button. */
  focus?: HTMLElement;
  destroy?(): void;
}

export interface WidgetOverlayOptions {
  className: string;
  ariaLabel: string;
  /** Mermaid draws its own ✕ inside the canvas. */
  closeButton?: boolean;
  mount(close: () => void): WidgetOverlayContent;
}

export function openWidgetOverlay(options: WidgetOverlayOptions): () => void {
  const overlay = document.createElement("div");
  overlay.className = `cm-widget-overlay ${options.className}`;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", options.ariaLabel);
  overlay.tabIndex = -1;

  // Restoring focus on close keeps the editor out of CodeMirror's blurred
  // selection-sync race on the next widget-button click.
  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  let closed = false;
  let content: WidgetOverlayContent | null = null;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeyDown, true);
    previouslyFocused?.focus({ preventScroll: true });

    // The timeout covers `transitionend` not firing when closed mid-entry.
    overlay.classList.remove("is-open");
    let removed = false;
    const finalize = () => {
      if (removed) return;
      removed = true;
      content?.destroy?.();
      overlay.remove();
    };
    const panel = content?.panel;
    panel?.addEventListener("transitionend", (e) => {
      if (e.target === panel) finalize();
    });
    setTimeout(finalize, 240);
  };

  // Capture phase, so Esc closes before CodeMirror sees it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKeyDown, true);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  content = options.mount(close);
  content.panel.classList.add("cm-widget-overlay-panel");
  overlay.append(content.panel);

  let closeButton: HTMLButtonElement | null = null;
  if (options.closeButton ?? true) {
    closeButton = makeWidgetButton("✕", "Close");
    closeButton.className = "cm-widget-overlay-close";
    closeButton.addEventListener("click", close);
    overlay.append(closeButton);
  }

  document.body.append(overlay);
  (content.focus ?? closeButton ?? overlay).focus({ preventScroll: true });

  // Commit the closed state first so the entry transition has a start.
  void overlay.getBoundingClientRect();
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  return close;
}
