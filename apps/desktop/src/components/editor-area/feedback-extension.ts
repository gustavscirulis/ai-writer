import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { CommentAdd01Icon } from "@hugeicons/core-free-icons";
import { attachBlock, attachFromEditor, feedbackState } from "@/hooks/feedback-api";
import { useFeedbackStore } from "@/stores/feedback-store";
import {
  attachmentRange,
  feedbackTargetAt,
  feedbackTargets,
  type FeedbackAnchor,
} from "@/lib/feedback-anchors";
import "./feedback-extension.css";

const WIDGETS =
  ".cm-table-widget, .cm-mermaid-widget, .cm-embed-widget, .cm-html-block-widget, .cm-image, .cm-math-widget, .cm-horizontal-rule-container";
const CONTROLS =
  "button, input, textarea, select, [role=button], [role=menu], [contenteditable=true]";
const SVG = "http://www.w3.org/2000/svg";

/** Widget positions are looked up live, preferring the block ending at a boundary. */
export function feedbackPositionAtEvent(view: EditorView, event: MouseEvent) {
  const element = event.target instanceof Element ? event.target : null;
  const widget = element?.closest(WIDGETS);
  if (widget && view.dom.contains(widget)) return { pos: view.posAtDOM(widget), side: -1 as const };
  if (!element?.closest(".cm-line")) return null;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  return pos === null ? null : { pos, side: 1 as const };
}

function icon(data: typeof CommentAdd01Icon, size: number) {
  const svg = document.createElementNS(SVG, "svg");
  for (const [name, value] of Object.entries({
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    "aria-hidden": "true",
  }))
    svg.setAttribute(name, String(value));
  for (const [tag, attributes] of data) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes))
      if (name !== "key")
        element.setAttribute(
          name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
          String(value),
        );
    svg.append(element);
  }
  return svg;
}

const focusChanged = StateEffect.define<boolean>();
const refresh = StateEffect.define<null>();
const marks = {
  attached: Decoration.mark({ class: "writer-mark-attached" }),
  pending: Decoration.mark({ class: "writer-mark-note" }),
  running: Decoration.mark({ class: "writer-mark-note" }),
  focus: Decoration.mark({ class: "writer-mark-focus" }),
};

/** "Add to Co-writer ⌘L" above a selection while the editor has focus. */
function selectionPill(getPath: () => string): Extension {
  const tooltip = (state: EditorState, previous: Tooltip | null): Tooltip | null => {
    const range = state.selection.main;
    if (range.empty || state.selection.ranges.length > 1) return null;
    if (previous?.pos === range.from) return previous;
    return {
      pos: range.from,
      above: true,
      create: (view) => {
        const dom = document.createElement("div");
        dom.className = "writer-comment-pill";
        const button = document.createElement("button");
        button.type = "button";
        const kbd = document.createElement("kbd");
        kbd.textContent = "⌘L";
        button.append(icon(CommentAdd01Icon, 14), "Add to Co-writer", kbd);
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => attachFromEditor(getPath(), view));
        dom.append(button);
        return { dom };
      },
    };
  };
  const field = StateField.define<{ focused: boolean; tooltip: Tooltip | null }>({
    create: () => ({ focused: false, tooltip: null }),
    update(value, tr) {
      let focused = value.focused;
      for (const effect of tr.effects) if (effect.is(focusChanged)) focused = effect.value;
      if (focused === value.focused && !tr.selection && !tr.docChanged) return value;
      return { focused, tooltip: focused ? tooltip(tr.state, value.tooltip) : null };
    },
    provide: (f) => showTooltip.from(f, (value) => value.tooltip),
  });
  return [field, EditorView.focusChangeEffect.of((_, focusing) => focusChanged.of(focusing))];
}

type Placement = {
  x: number;
  button: number | null;
  dots: { key: string; count: number; y: number }[];
};
const keyOf = (anchor: FeedbackAnchor) => `${anchor.from}:${anchor.to}`;

/**
 * Note highlights, ⌥-click, and the gutter right of the text column: a comment
 * button on the hovered block and a count on blocks with saved notes. The
 * gutter lives in `view.dom` because the scroller clips to the text column.
 */
function feedbackGutter(getPath: () => string) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      overlay = document.createElement("div");
      button = document.createElement("button");
      dots = new Map<string, HTMLElement>();
      hovered: FeedbackAnchor | null = null;
      targets: { doc: Text; list: FeedbackAnchor[] } | null = null;
      built: { items: unknown; highlighted: unknown } = { items: null, highlighted: null };
      queued = false;
      captured = false;
      destroyed = false;
      unsubscribe: () => void;

      constructor(readonly view: EditorView) {
        this.reconcile(null);
        this.decorations = this.build();
        this.overlay.className = "writer-feedback-gutter";
        this.button.type = "button";
        this.button.className = "writer-paragraph-comment";
        this.button.setAttribute("aria-label", "Add this block to Co-writer");
        this.button.title = "Add to Co-writer (⌥-click the block)";
        this.button.append(icon(CommentAdd01Icon, 15));
        this.button.addEventListener("pointerdown", (event) => event.preventDefault());
        this.button.addEventListener("click", () => {
          if (this.hovered) attachBlock(getPath(), this.hovered);
        });
        this.overlay.append(this.button);
        view.dom.append(this.overlay);
        view.dom.addEventListener("pointerdown", this.start, true);
        for (const type of ["mousedown", "mouseup", "click"] as const)
          view.dom.addEventListener(type, this.suppress, true);
        view.dom.addEventListener("pointermove", this.hover);
        view.dom.addEventListener("pointerleave", this.leave);
        this.unsubscribe = useFeedbackStore.subscribe(this.schedule);
        this.measure();
      }

      reconcile(before: string | null, changes?: ViewUpdate["changes"]) {
        feedbackState().reconcile(getPath(), before, this.view.state.doc.toString(), changes);
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          const external = update.transactions.some((tr) => tr.isUserEvent("writer"));
          this.reconcile(
            external ? null : update.startState.doc.toString(),
            external ? undefined : update.changes,
          );
        }
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refresh)),
        );
        if (update.docChanged || refreshed) this.decorations = this.build();
        if (update.docChanged || refreshed || update.geometryChanged || update.viewportChanged)
          this.measure();
      }

      build() {
        const { byPath, highlighted } = useFeedbackStore.getState();
        const path = getPath();
        const items = byPath[path] ?? [];
        this.built = { items, highlighted };
        const length = this.view.state.doc.length;
        const ranges = [];
        for (const item of items) {
          if (!item.anchor?.attached) continue;
          const { from, to } = attachmentRange(item.anchor, item.quote);
          if (from < to && to <= length) ranges.push(marks[item.status].range(from, to));
        }
        if (
          highlighted?.path === path &&
          highlighted.from < highlighted.to &&
          highlighted.to <= length
        )
          ranges.push(marks.focus.range(highlighted.from, highlighted.to));
        return Decoration.set(ranges, true);
      }

      // Store updates can arrive mid-update (reconcile runs inside `update`).
      schedule = () => {
        if (this.queued) return;
        this.queued = true;
        queueMicrotask(() => {
          this.queued = false;
          const { byPath, highlighted } = useFeedbackStore.getState();
          if (
            this.destroyed ||
            (byPath[getPath()] === this.built.items && highlighted === this.built.highlighted)
          )
            return;
          this.view.dispatch({ effects: refresh.of(null) });
        });
      };

      targetList() {
        const doc = this.view.state.doc;
        if (this.targets?.doc !== doc)
          this.targets = { doc, list: feedbackTargets(doc.toString()) };
        return this.targets.list;
      }

      measure() {
        this.view.requestMeasure<Placement>({
          key: this,
          read: (view) => {
            const dom = view.dom.getBoundingClientRect();
            const content = view.contentDOM.getBoundingClientRect();
            const padding = parseFloat(getComputedStyle(view.contentDOM).paddingRight);
            const lineHeight = view.defaultLineHeight;
            const centerOf = (anchor: FeedbackAnchor) => {
              const coords =
                anchor.from <= view.state.doc.length && view.coordsAtPos(anchor.from, 1);
              if (coords && coords.bottom - coords.top <= lineHeight * 2)
                return (coords.top + coords.bottom) / 2 - dom.top;
              const top = coords
                ? coords.top
                : view.documentTop + view.lineBlockAt(anchor.from).top;
              return top + lineHeight / 2 - dom.top;
            };
            const counts = new Map<string, { anchor: FeedbackAnchor; count: number }>();
            for (const item of useFeedbackStore.getState().byPath[getPath()] ?? []) {
              if (item.status === "attached" || !item.anchor?.attached) continue;
              const entry = counts.get(keyOf(item.anchor));
              if (entry) entry.count++;
              else counts.set(keyOf(item.anchor), { anchor: item.anchor, count: 1 });
            }
            return {
              x: content.right - padding - dom.left + 14,
              button: this.hovered ? centerOf(this.hovered) : null,
              dots: [...counts].map(([key, { anchor, count }]) => ({
                key,
                count,
                y: centerOf(anchor),
              })),
            };
          },
          write: ({ x, button, dots }) => {
            this.button.toggleAttribute("data-visible", button !== null);
            if (button !== null)
              this.button.style.translate = `${x}px ${Math.round(button - 13)}px`;
            const hovered = this.hovered && keyOf(this.hovered);
            const seen = new Set<string>();
            for (const dot of dots) {
              seen.add(dot.key);
              let element = this.dots.get(dot.key);
              if (!element) {
                element = document.createElement("span");
                element.className = "writer-note-dot";
                element.setAttribute("aria-hidden", "true");
                this.overlay.append(element);
                this.dots.set(dot.key, element);
              }
              element.textContent = String(dot.count);
              element.style.translate = `${x + 4}px ${Math.round(dot.y - 9)}px`;
              element.toggleAttribute("data-hidden", dot.key === hovered);
            }
            for (const [key, element] of this.dots)
              if (!seen.has(key)) {
                element.remove();
                this.dots.delete(key);
              }
          },
        });
      }

      hover = (event: PointerEvent) => {
        if (event.target === this.button || this.button.contains(event.target as Node)) return;
        const view = this.view;
        const y = event.clientY - view.documentTop;
        const inside = y >= 0 && y <= view.contentHeight;
        const line = inside ? view.lineBlockAtHeight(y) : null;
        const target = line
          ? (this.targetList().find((t) => t.from <= line.from && line.from <= t.to) ?? null)
          : null;
        if (target?.from === this.hovered?.from && target?.to === this.hovered?.to) return;
        this.hovered = target;
        this.measure();
      };

      leave = () => {
        if (!this.hovered) return;
        this.hovered = null;
        this.measure();
      };

      start = (event: PointerEvent) => {
        this.captured = false;
        if (!event.altKey || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
          return;
        const element = event.target instanceof Element ? event.target : null;
        const control = element?.closest(CONTROLS);
        if ((control && control !== this.view.contentDOM) || this.overlay.contains(element)) return;
        const hit = feedbackPositionAtEvent(this.view, event);
        if (!hit) return;
        const source = this.view.state.doc.toString();
        const target =
          feedbackTargetAt(source, hit.pos, hit.side) ??
          feedbackTargetAt(source, hit.pos, hit.side === -1 ? 1 : -1);
        if (!target) return;
        this.captured = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        attachBlock(getPath(), target);
      };

      suppress = (event: MouseEvent) => {
        if (!this.captured || event.button !== 0) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === "click") this.captured = false;
      };

      destroy() {
        this.destroyed = true;
        this.unsubscribe();
        this.overlay.remove();
        this.view.dom.removeEventListener("pointerdown", this.start, true);
        for (const type of ["mousedown", "mouseup", "click"] as const)
          this.view.dom.removeEventListener(type, this.suppress, true);
        this.view.dom.removeEventListener("pointermove", this.hover);
        this.view.dom.removeEventListener("pointerleave", this.leave);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

export function feedbackExtension(getPath: () => string): Extension {
  return [
    feedbackGutter(getPath),
    selectionPill(getPath),
    Prec.high(
      keymap.of([
        {
          key: "Mod-l",
          run: (view) => {
            attachFromEditor(getPath(), view);
            return true;
          },
        },
      ]),
    ),
  ];
}
