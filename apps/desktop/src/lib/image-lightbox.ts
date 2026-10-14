import { EXPAND_ICON_PATHS, makeWidgetButton, setWidgetButtonIcon } from "./widget-buttons";
import { openWidgetOverlay } from "./widget-overlay";
import "./image-lightbox.css";

const EXPAND_CLASS = "cm-image-expand";

/** Wraps an editor image so it gets a hover Expand button that opens it in
 *  the lightbox. Returns the wrapper to insert in the image's place. */
export function wrapExpandableImage(image: HTMLImageElement): HTMLElement {
  const frame = document.createElement("span");
  frame.className = "cm-image-frame";

  const button = makeWidgetButton("", "Expand image");
  setWidgetButtonIcon(button, EXPAND_ICON_PATHS, "cm-image-expand-icon");
  button.className = EXPAND_CLASS;
  button.hidden = true;
  button.addEventListener("click", () => openImageLightbox(image));
  image.addEventListener("load", () => (button.hidden = false));
  image.addEventListener("error", () => (button.hidden = true));

  frame.append(image, button);
  return frame;
}

/** For `ignoreEvent`: the Expand button's events stay out of CodeMirror. */
export function isImageExpandEvent(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(`.${EXPAND_CLASS}`) !== null;
}

function openImageLightbox(source: HTMLImageElement): void {
  const src = source.currentSrc || source.src;
  if (!src) return;
  openWidgetOverlay({
    className: "cm-image-lightbox",
    ariaLabel: source.alt || "Image",
    mount() {
      const image = document.createElement("img");
      image.className = "cm-image-lightbox-image";
      image.src = src;
      image.alt = source.alt;
      return { panel: image };
    },
  });
}
