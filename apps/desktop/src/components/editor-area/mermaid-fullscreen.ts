import { openWidgetOverlay } from "@/lib/widget-overlay";
import { mountMermaidCanvas } from "./mermaid-canvas";
import { renderMermaid } from "./mermaid-renderer";

export function openMermaidFullscreen(source: string, ariaLabel: string): void {
  const result = renderMermaid(source);
  if (!result.svg) return;
  const svgHtml = result.svg;

  openWidgetOverlay({
    className: "cm-mermaid-fullscreen",
    ariaLabel,
    closeButton: false,
    mount(close) {
      const host = document.createElement("div");
      host.className = "cm-mermaid-canvas cm-mermaid-fullscreen-canvas";
      host.tabIndex = 0;
      mountMermaidCanvas(host, { svgHtml, ariaLabel, onClose: close });
      return { panel: host, focus: host };
    },
  });
}
