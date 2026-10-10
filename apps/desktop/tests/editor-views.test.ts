import { expect, test } from "vite-plus/test";
import { EditorState, Compartment } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { registerEditorView, getEditorView, synchronizeEditorView } from "../src/lib/editor-views";
import { markAgentReload, getAgentReload, consumeAgentReload } from "../src/lib/agent-turn";
import {
  agentEditingExtensions,
  agentReloadTransaction,
} from "../src/components/editor-area/agent-editing";
test("duplicate file tabs select the active view and each receives an undoable reload", () => {
  const makeView = () => {
    let state = EditorState.create({
      doc: "Original",
      extensions: [history(), agentEditingExtensions(null, new Compartment())],
    });
    return {
      get state() {
        return state;
      },
      dispatch(transaction: Parameters<EditorState["update"]>[0]) {
        state = state.update(transaction).state;
      },
    } as unknown as EditorView;
  };
  const first = makeView(),
    second = makeView();
  const sync = (view: EditorView) => {
    if (getAgentReload("/duplicate.md", 1))
      view.dispatch(agentReloadTransaction(view.state.doc.toString(), "Revised", null));
  };
  const disposeFirst = registerEditorView(
    "/duplicate.md",
    first,
    () => sync(first),
    () => true,
  );
  const disposeSecond = registerEditorView(
    "/duplicate.md",
    second,
    () => sync(second),
    () => false,
  );
  expect(getEditorView("/duplicate.md")).toBe(first);
  markAgentReload("/duplicate.md", 1, null);
  synchronizeEditorView("/duplicate.md");
  consumeAgentReload("/duplicate.md", 1);
  for (const view of [first, second]) {
    expect(view.state.doc.toString()).toBe("Revised");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("Original");
  }
  disposeSecond();
  expect(getEditorView("/duplicate.md")).toBe(first);
  disposeFirst();
  expect(getEditorView("/duplicate.md")).toBeUndefined();
});
