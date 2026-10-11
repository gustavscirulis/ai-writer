import { beforeEach, expect, test, vi } from "vite-plus/test";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const attach = vi.hoisted(() => vi.fn());
vi.mock("@/stores/feedback-store", () => ({
  useFeedbackStore: { getState: () => ({ attach }) },
  captureFeedbackPathRewrite: vi.fn(),
}));
vi.mock("@/lib/editor-views", () => ({ getEditorView: vi.fn() }));
vi.mock("@/components/editor-area/editor-scroll", () => ({
  findOuterScroller: vi.fn(),
  scrollPosToSafeTop: vi.fn(),
}));
vi.mock("@/hooks/use-claude", () => ({ showChatPanel: vi.fn(), focusChatComposer: vi.fn() }));

import { attachFromEditor } from "../src/hooks/feedback-api";
import { showChatPanel, focusChatComposer } from "../src/hooks/use-claude";

beforeEach(() => {
  vi.clearAllMocks();
  attach.mockReturnValue(true);
});

function selectedView(doc: string, from: number, to: number) {
  const state = EditorState.create({ doc, selection: { anchor: from, head: to } });
  const dispatch = vi.fn<(spec: TransactionSpec) => void>();
  return { view: { state, dispatch } as unknown as EditorView, dispatch };
}

test("selected words attach as a quote, open Chat, focus the composer and collapse the selection", () => {
  const { view, dispatch } = selectedView("One two three", 4, 7);
  expect(attachFromEditor("/note.md", view)).toBe(true);
  expect(attach).toHaveBeenCalledWith(
    "/note.md",
    expect.objectContaining({ text: "One two three" }),
    "two",
  );
  expect(showChatPanel).toHaveBeenCalledOnce();
  expect(focusChatComposer).toHaveBeenCalledOnce();
  const spec = dispatch.mock.calls[0]![0];
  expect(view.state.update(spec).state.selection.main).toMatchObject({ from: 7, to: 7 });
});

test("a selection across blocks attaches each touched block", () => {
  const { view } = selectedView("First paragraph\n\nSecond paragraph", 6, 23);
  expect(attachFromEditor("/note.md", view)).toBe(true);
  expect(attach.mock.calls.map(([, anchor, quote]) => [anchor.text, quote])).toEqual([
    ["First paragraph", null],
    ["Second paragraph", null],
  ]);
});

test("rejected attachment leaves selection and composer focus unchanged", () => {
  attach.mockReturnValue(false);
  const { view, dispatch } = selectedView("One two three", 4, 7);
  expect(attachFromEditor("/note.md", view)).toBe(false);
  expect(dispatch).not.toHaveBeenCalled();
  expect(showChatPanel).not.toHaveBeenCalled();
  expect(focusChatComposer).not.toHaveBeenCalled();
});
