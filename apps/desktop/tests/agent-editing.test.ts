import { afterEach, expect, test } from "vite-plus/test";
import { Compartment, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { history, undo, redo, undoDepth } from "@codemirror/commands";
import {
  agentEditingExtensions,
  agentFrontmatterField,
  agentReloadTransaction,
  watchAgentEditing,
} from "../src/components/editor-area/agent-editing";
import { acquireAgentEditing, clearAgentEditing } from "../src/lib/agent-turn";
import { EditorView } from "@codemirror/view";
afterEach(clearAgentEditing);
function harness(body: string, frontmatter: string | null) {
  let state = EditorState.create({
    doc: body,
    extensions: [
      history(),
      agentEditingExtensions(frontmatter, new Compartment(), () => "/note.md"),
    ],
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
    const release = acquireAgentEditing("/note.md");
    editor.change(agentReloadTransaction(editor.state.doc.toString(), after, "title: After"));
    expect(undoDepth(editor.state)).toBe(1);
    release();
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
  acquireAgentEditing("/note.md");
  editor.change({ changes: { from: 0, insert: "Unexpected" } });
  expect(editor.state.doc.toString()).toBe("Draft");
  editor.change(agentReloadTransaction("Draft", "Approved reload", null));
  expect(editor.state.doc.toString()).toBe("Approved reload");
});

test("a reused pane reconfigures readonly and dispatch guards for its current note", () => {
  let path = "/a.md";
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: "Draft",
    extensions: [agentEditingExtensions(null, compartment, () => path)],
  });
  const view = {
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  const release = acquireAgentEditing("/a.md");
  let unwatch = watchAgentEditing(view, compartment, () => path);
  expect(state.readOnly).toBe(true);
  view.dispatch({ changes: { from: 0, insert: "Blocked" } });
  expect(state.doc.toString()).toBe("Draft");
  unwatch();
  path = "/b.md";
  unwatch = watchAgentEditing(view, compartment, () => path);
  expect(state.readOnly).toBe(false);
  view.dispatch({ changes: { from: 0, insert: "B: " } });
  expect(state.doc.toString()).toBe("B: Draft");
  unwatch();
  path = "/a.md";
  unwatch = watchAgentEditing(view, compartment, () => path);
  expect(state.readOnly).toBe(true);
  release();
  expect(state.readOnly).toBe(false);
  unwatch();
});

test("the editor carries a wait-cursor marker only while its note is locked", () => {
  const compartment = new Compartment();
  let state = EditorState.create({
    doc: "Draft",
    extensions: [agentEditingExtensions(null, compartment, () => "/a.md")],
  });
  const view = {
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  const marked = () =>
    state.facet(EditorView.editorAttributes).some((attrs) => "data-agent-editing" in attrs);
  const unwatch = watchAgentEditing(view, compartment, () => "/a.md");
  expect(marked()).toBe(false);
  const release = acquireAgentEditing("/a.md");
  expect(marked()).toBe(true);
  release();
  expect(marked()).toBe(false);
  unwatch();
});
