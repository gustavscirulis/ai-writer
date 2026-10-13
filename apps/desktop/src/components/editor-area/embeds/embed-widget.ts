import { convertFileSrc } from "@tauri-apps/api/core";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";
import { makeWidgetButton, setWidgetButtonIcon } from "../widget-buttons";
import type { EmbedSpec } from "./embed-providers";
import { clampFrameHeight, parseFrameMessage, renderMessage } from "./frame-messages";
import "./embed.css";

// App-served frames must never get `allow-same-origin`: with it, embed code
// would share the app's origin and reach Tauri IPC.
const APP_FRAME_SANDBOX = "allow-scripts allow-forms";
const DEFAULT_HTML_HEIGHT = 150;
const WIDGET_VERTICAL_PADDING = 16;
const RELOAD_DEBOUNCE_MS = 300;

const CODE_ICON_PATHS = ["m16 18 6-6-6-6", "m8 6-6 6 6 6", "m13 4-2 16"] as const;
const RELOAD_ICON_PATHS = ["M3 12a9 9 0 1 0 2.64-6.36L3 8", "M3 3v5h5"] as const;

export type EmbedSourceNode = "FencedCode" | "Image";
export type EmbedMode = "view" | "selected" | "editing";

// Last measured height per embed, so widgets CodeMirror virtualizes away come
// back at their real height instead of shifting the heightmap.
const heightCache = new Map<string, number>();
const frameHeightCache = new Map<string, number>();
const handles = new WeakMap<HTMLElement, EmbedHandle>();

interface EmbedHandle {
  update(spec: EmbedSpec, mode: EmbedMode): boolean;
  destroy(): void;
}

interface KindHandle {
  update(spec: EmbedSpec): boolean;
  reload(): void;
  destroy(): void;
}

interface MountContext {
  key: string;
  setError(message: string | null): void;
}

export class EmbedWidget extends WidgetType {
  readonly key: string;

  constructor(
    readonly spec: EmbedSpec,
    readonly sourceNode: EmbedSourceNode,
    readonly mode: EmbedMode,
  ) {
    super();
    this.key = JSON.stringify(spec);
  }

  eq(other: EmbedWidget): boolean {
    return (
      this.key === other.key && this.sourceNode === other.sourceNode && this.mode === other.mode
    );
  }

  get estimatedHeight(): number {
    return heightCache.get(this.key) ?? defaultHeight(this.spec) + WIDGET_VERTICAL_PADDING;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-embed-widget";
    wrapper.contentEditable = "false";
    wrapper.dataset.embedKind = this.spec.kind;
    wrapper.classList.toggle("cm-embed-selected", this.mode === "selected");
    // Clicks in the frame belong to the embed; a click on the chrome around
    // it selects the whole block instead of dropping a caret into its source.
    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.altKey) return;
      event.preventDefault();
      selectBlock(view, wrapper, this.sourceNode);
    });

    const box = document.createElement("div");
    box.className = "cm-embed-box";
    wrapper.append(box);

    const error = document.createElement("div");
    error.className = "cm-embed-error";
    error.setAttribute("role", "status");
    error.hidden = true;

    let key = this.key;
    const ctx: MountContext = {
      get key() {
        return key;
      },
      setError(message) {
        error.hidden = message === null;
        error.textContent = message ?? "";
        error.title = message ?? "";
      },
    };
    const content = mountKind(box, this.spec, ctx);

    const toolbar = document.createElement("div");
    toolbar.className = "cm-embed-toolbar";
    const edit = makeWidgetButton("", "Edit source");
    setWidgetButtonIcon(edit, CODE_ICON_PATHS, "cm-embed-button-icon");
    edit.className = "cm-embed-button";
    edit.hidden = this.mode === "editing";
    edit.addEventListener("click", () => revealSource(view, wrapper, this.sourceNode));
    const reload = makeWidgetButton("", "Reload");
    setWidgetButtonIcon(reload, RELOAD_ICON_PATHS, "cm-embed-button-icon");
    reload.className = "cm-embed-button";
    reload.addEventListener("click", () => content.reload());
    toolbar.append(edit, reload);
    box.append(toolbar, error);

    const resize = new ResizeObserver(() => {
      const height = wrapper.getBoundingClientRect().height;
      if (height > 0) heightCache.set(key, height);
      view.requestMeasure();
    });
    resize.observe(wrapper);

    handles.set(wrapper, {
      update(spec, mode) {
        if (!content.update(spec)) return false;
        key = JSON.stringify(spec);
        edit.hidden = mode === "editing";
        wrapper.classList.toggle("cm-embed-selected", mode === "selected");
        return true;
      },
      destroy() {
        resize.disconnect();
        content.destroy();
      },
    });
    return wrapper;
  }

  // Keeping the DOM preserves the embed's state when its source opens, and
  // source edits reload in place instead of flashing a fresh widget.
  updateDOM(dom: HTMLElement): boolean {
    return handles.get(dom)?.update(this.spec, this.mode) ?? false;
  }

  destroy(dom: HTMLElement): void {
    handles.get(dom)?.destroy();
    handles.delete(dom);
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function defaultHeight(spec: EmbedSpec): number {
  switch (spec.kind) {
    case "html":
      return DEFAULT_HTML_HEIGHT;
  }
}

function mountKind(box: HTMLElement, spec: EmbedSpec, ctx: MountContext): KindHandle {
  switch (spec.kind) {
    case "html":
      return mountHtml(box, spec.html, ctx);
  }
}

function mountHtml(box: HTMLElement, initialHtml: string, ctx: MountContext): KindHandle {
  let html = initialHtml;
  let rendered = false;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  const iframe = document.createElement("iframe");
  iframe.className = "cm-embed-iframe";
  iframe.setAttribute("sandbox", APP_FRAME_SANDBOX);
  iframe.title = "Embedded HTML";
  iframe.style.height = `${frameHeightCache.get(ctx.key) ?? DEFAULT_HTML_HEIGHT}px`;
  box.append(iframe);

  const load = () => {
    rendered = false;
    ctx.setError(null);
    iframe.src = convertFileSrc("frame", "writer-embed");
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const message = parseFrameMessage(event.data);
    if (!message) return;
    if (message.type === "ready" && !rendered) {
      rendered = true;
      iframe.contentWindow?.postMessage(renderMessage(html), "*");
    } else if (message.type === "height") {
      const height = clampFrameHeight(message.height);
      frameHeightCache.set(ctx.key, height);
      iframe.style.height = `${height}px`;
    } else if (message.type === "error") {
      ctx.setError(message.message);
    }
  };
  window.addEventListener("message", onMessage);
  load();

  return {
    update(spec) {
      if (spec.kind !== "html") return false;
      if (spec.html === html) return true;
      html = spec.html;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, RELOAD_DEBOUNCE_MS);
      return true;
    },
    reload: load,
    destroy() {
      if (reloadTimer) clearTimeout(reloadTimer);
      window.removeEventListener("message", onMessage);
    },
  };
}

/** Put the caret in the embed's source so its markdown shows for editing. */
function revealSource(view: EditorView, dom: HTMLElement, nodeName: EmbedSourceNode): void {
  const node = findSourceNode(view, dom, nodeName);
  if (!node) return;
  const selection =
    nodeName === "FencedCode"
      ? EditorSelection.cursor(view.state.doc.lineAt(node.from).to + 1)
      : EditorSelection.cursor(node.to);
  view.dispatch({ selection, scrollIntoView: true, effects: view.scrollSnapshot() });
  view.focus();
}

function selectBlock(view: EditorView, dom: HTMLElement, nodeName: EmbedSourceNode): void {
  const node = findSourceNode(view, dom, nodeName);
  if (!node) return;
  view.dispatch({ selection: EditorSelection.single(node.from, node.to) });
  view.focus();
}

function findSourceNode(view: EditorView, dom: HTMLElement, name: EmbedSourceNode) {
  const pos = view.posAtDOM(dom);
  const tree = syntaxTree(view.state);
  for (const side of [-1, 1] as const) {
    let node = tree.resolveInner(pos, side);
    while (node.name !== name && node.parent) node = node.parent;
    if (node.name === name) return node;
  }
  return null;
}
