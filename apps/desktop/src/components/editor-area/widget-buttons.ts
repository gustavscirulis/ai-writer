const SVG_NS = "http://www.w3.org/2000/svg";

/** A button for chrome inside an editor widget. */
export function makeWidgetButton(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  // Keep editor focus and CM's pointer handlers out of the click; see
  // "Buttons inside widgets" in docs/editor.md.
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  return b;
}

/** Replace the button's content with a 24×24 stroked icon. */
export function setWidgetButtonIcon(
  button: HTMLButtonElement,
  paths: readonly string[],
  className: string,
): void {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }

  button.replaceChildren(svg);
}
