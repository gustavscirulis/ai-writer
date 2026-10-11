const bindingListeners = new WeakMap<EditorView, Set<() => void>>();
export function subscribeEditorDocument(view: EditorView, listener: () => void) {
  const listeners = bindingListeners.get(view) ?? new Set();
  listeners.add(listener);
  bindingListeners.set(view, listeners);
  return () => {
    listeners.delete(listener);
  };
}
const bindings = new WeakMap<EditorView, string>();
export function editorDocumentPath(view: EditorView) {
  return bindings.get(view) ?? "";
}
import type { EditorView } from "@codemirror/view";
const views = new Map<
  string,
  Map<EditorView, { synchronize: () => void; isActive: () => boolean }>
>();
export function registerEditorView(
  path: string,
  view: EditorView,
  synchronize: () => void,
  isActive: () => boolean = () => true,
) {
  bindings.set(view, path);
  for (const listener of bindingListeners.get(view) ?? []) listener();
  const entries = views.get(path) ?? new Map();
  entries.set(view, { synchronize, isActive });
  views.set(path, entries);
  return () => {
    if (bindings.get(view) === path) bindings.delete(view);
    entries.delete(view);
    if (entries.size === 0) views.delete(path);
  };
}
export function getEditorView(path: string) {
  return [...(views.get(path)?.entries() ?? [])].find(([, entry]) => entry.isActive())?.[0];
}
export function synchronizeEditorView(path: string) {
  for (const entry of views.get(path)?.values() ?? []) entry.synchronize();
}
