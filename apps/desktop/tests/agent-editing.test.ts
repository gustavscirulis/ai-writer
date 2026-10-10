import { afterEach, expect, test } from "vite-plus/test";
import { Compartment, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undo, redo, undoDepth } from "@codemirror/commands";
import {
  agentEditingExtensions,
  agentFrontmatterField,
  agentReloadTransaction,
} from "../src/components/editor-area/agent-editing";
import { setAgentEditing } from "../src/lib/agent-turn";
afterEach(() => setAgentEditing(false));
function harness(body: string, frontmatter: string | null) {
  let state = EditorState.create({
    doc: body,
    extensions: [history(), agentEditingExtensions(frontmatter, new Compartment())],
  });
  return {
    get state() {
      return state;
    },
    dispatch: (transaction: Transaction) => {
      state = transaction.state;
    },
    change: (spec: TransactionSpec) => {
      state = state.update(spec).state;
    },
  };
}
for (const after of ["Revised paragraph", "Original paragraph"]) {
  test(`agent reload undoes/redoes frontmatter and ${after === "Original paragraph" ? "unchanged" : "changed"} body in one step`, () => {
    const editor = harness("Original paragraph", "title: Before");
    setAgentEditing(true);
    editor.change(agentReloadTransaction(editor.state.doc.toString(), after, "title: After"));
    expect(undoDepth(editor.state)).toBe(1);
    setAgentEditing(false);
    expect(undo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe("Original paragraph");
    expect(editor.state.field(agentFrontmatterField)).toBe("title: Before");
    expect(redo(editor)).toBe(true);
    expect(editor.state.doc.toString()).toBe(after);
    expect(editor.state.field(agentFrontmatterField)).toBe("title: After");
  });
}
test("explicit widget/formatting document dispatches are rejected while locked", () => {
  const editor = harness("Draft", null);
  setAgentEditing(true);
  editor.change({ changes: { from: 0, insert: "Unexpected" } });
  expect(editor.state.doc.toString()).toBe("Draft");
  editor.change(agentReloadTransaction("Draft", "Approved reload", null));
  expect(editor.state.doc.toString()).toBe("Approved reload");
});
