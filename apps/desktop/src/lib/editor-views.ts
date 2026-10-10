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
  const entries = views.get(path) ?? new Map();
  entries.set(view, { synchronize, isActive });
  views.set(path, entries);
  return () => {
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
