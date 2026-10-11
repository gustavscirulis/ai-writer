import { beforeEach, expect, test, vi } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

vi.mock("@codemirror/view", () => ({
  EditorView: { domEventHandlers: (handlers: unknown) => handlers },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(), readText: vi.fn() }));
vi.mock("../src/components/editor-area/editor-context-menu", () => ({
  buildEditorBodyMenuItemsSpec: (handlers: unknown) => handlers,
  showNativeContextMenu: vi.fn(),
}));
vi.mock("../src/components/editor-area/link-navigation", () => ({
  followLink: vi.fn(),
  linkHrefAtPos: vi.fn(),
}));
vi.mock("../src/components/editor-area/markdown-formatting", () => ({ runEditorCommand: vi.fn() }));
vi.mock("@/hooks/feedback-api", () => ({ attachFromEditor: vi.fn() }));

import { editorBodyContextMenuExtension } from "../src/components/editor-area/editor-body-menu";
import {
  showNativeContextMenu,
  type EditorBodyMenuHandlers,
} from "../src/components/editor-area/editor-context-menu";
import { attachFromEditor } from "../src/hooks/feedback-api";

beforeEach(() => vi.clearAllMocks());

function openMenu(selected = true) {
  let path = "/note.md";
  let disposed = false;
  const extension = editorBodyContextMenuExtension(
    () => path,
    () => disposed,
  ) as unknown as { contextmenu: (event: MouseEvent, view: EditorView) => boolean };
  const view = {
    state: EditorState.create({
      doc: "Selected text",
      selection: { anchor: 0, head: selected ? 8 : 0 },
    }),
    hasFocus: false,
    posAtCoords: () => null,
  } as unknown as EditorView;
  const event = { preventDefault: vi.fn(), clientX: 0, clientY: 0 } as unknown as MouseEvent;
  expect(extension.contextmenu(event, view)).toBe(true);
  const handlers = vi.mocked(showNativeContextMenu).mock
    .calls[0]![0] as unknown as EditorBodyMenuHandlers;
  return {
    view,
    handlers,
    dispose: () => {
      disposed = true;
    },
    switchFile: () => {
      path = "/other.md";
    },
  };
}

test("selected text attaches through its explicit view after native-menu blur", () => {
  const { view, handlers } = openMenu();
  expect(handlers.onAddToChat).toBeTypeOf("function");
  handlers.onAddToChat!();
  expect(attachFromEditor).toHaveBeenCalledWith("/note.md", view);
});

test("a caret alone does not expose the selection menu action", () => {
  expect(openMenu(false).handlers.onAddToChat).toBeUndefined();
});

test.each(["dispose", "switchFile"] as const)("a delayed menu action ignores %s", (invalidate) => {
  const menu = openMenu();
  menu[invalidate]();
  menu.handlers.onAddToChat!();
  expect(attachFromEditor).not.toHaveBeenCalled();
});
