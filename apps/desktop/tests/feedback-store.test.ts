import { beforeEach, expect, test, vi } from "vite-plus/test";
import { EditorState } from "@codemirror/state";
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const data = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async () => null),
  setPreference: vi.fn(async () => {}),
  readPreferenceStrict: vi.fn(async (key: string) => data.get(key)),
  writePreferenceStrict: vi.fn(async (key: string, value: unknown) => {
    data.set(key, structuredClone(value));
  }),
}));
import {
  useFeedbackStore,
  flushFeedbackPersistence,
  reconcileFeedbackAfterTurn,
  captureFeedbackPathRewrite,
  flushAllFeedbackPersistence,
  resumeFeedbackPersistence,
} from "../src/stores/feedback-store";
import { readPreferenceStrict, writePreferenceStrict } from "../src/lib/preferences";
import { feedbackTargets } from "../src/lib/feedback-anchors";
import { invoke } from "@tauri-apps/api/core";

const root = "/feedback-test",
  path = `${root}/note.md`;
const store = () => useFeedbackStore.getState();
const items = () => store().byPath[path]!;
const create = (source = "Paragraph", target = 0, feedback = "Make it clearer") => {
  store().reconcile(path, null, source);
  store().attach(path, feedbackTargets(source)[target]!);
  const id = items().at(-1)!.id;
  store().saveNotes(path, feedback);
  return id;
};
const rewrite = (id: string, feedback: string) => {
  store().takeBack(path, id);
  store().saveNotes(path, feedback);
};
beforeEach(async () => {
  resumeFeedbackPersistence();
  await flushFeedbackPersistence(root).catch(() => {});
  data.clear();
  vi.mocked(writePreferenceStrict)
    .mockReset()
    .mockImplementation(async (key, value) => {
      data.set(key, structuredClone(value));
    });
  vi.mocked(readPreferenceStrict)
    .mockReset()
    .mockImplementation(async (key) => data.get(key));
  await store().load(root, store().generation + 1);
});

test("notes persist outside Markdown and survive restart; composer attachments do not", async () => {
  const id = create("First\n\nSecond");
  store().attach(path, feedbackTargets("First\n\nSecond")[1]!);
  await flushFeedbackPersistence(root);
  await store().load(root, store().generation + 1);
  expect(items()).toEqual([
    expect.objectContaining({ id, feedback: "Make it clearer", status: "pending", quote: null }),
  ]);
  expect(data.size).toBe(1);
});

test("attachments dedupe, save as one note each, and can be taken back into the composer", () => {
  const source = "First line\n\nSecond";
  const [first, second] = feedbackTargets(source);
  store().reconcile(path, null, source);
  store().attach(path, first!);
  store().attach(path, first!);
  store().attach(path, first!, "line");
  store().attach(path, second!);
  expect(items().map((item) => [item.anchor.text, item.quote])).toEqual([
    ["First line", null],
    ["First line", "line"],
    ["Second", null],
  ]);
  store().consume(path, [items()[2]!.id]);
  expect(store().saveNotes(path, "  ")).toBe(0);
  expect(store().saveNotes(path, " Tighten ")).toBe(2);
  expect(items().map((item) => [item.status, item.feedback])).toEqual([
    ["pending", "Tighten"],
    ["pending", "Tighten"],
  ]);
  expect(store().takeBack(path, items()[1]!.id)).toBe("Tighten");
  expect(items()[1]!.status).toBe("attached");
  store().clearAttached(path);
  expect(items()).toHaveLength(1);
});

test("canonical checkpoints map duplicate transactions exactly once", () => {
  create("Target\n\nOther");
  const state = EditorState.create({ doc: "Target\n\nOther" });
  const tr = state.update({ changes: { from: 0, insert: "Above\n\n" } });
  for (let i = 0; i < 2; i++)
    store().reconcile(path, state.doc.toString(), tr.newDoc.toString(), tr.changes);
  expect(items()[0]?.anchor).toMatchObject({ from: 7, text: "Target", attached: true });
});

test("reload recovers untouched blocks and a split detaches the note", () => {
  create("Target\n\nOther");
  store().reconcile(path, null, "Above\n\nTarget\n\nOther");
  expect(items()[0]?.anchor.from).toBe(7);
  const before = EditorState.create({ doc: "Above\n\nTarget\n\nOther" });
  const tr = before.update({ changes: { from: 10, insert: "\n\n" } });
  store().reconcile(path, before.doc.toString(), tr.newDoc.toString(), tr.changes);
  expect(items()[0]?.anchor.attached).toBe(false);
  expect(() => store().begin(path, [items()[0]!.id])).toThrow("Review or reattach");
});

test("submitted notes are immutable; success removes only the applied notes", () => {
  const first = create("First\n\nSecond");
  create("First\n\nSecond", 1, "Shorten this");
  const batch = store().begin(path, [first]);
  expect(store().takeBack(path, first)).toBeNull();
  store().remove(path, first);
  const prompt = store().prepare(batch, "---\ntitle: Note\n---\nFirst\n\nSecond");
  expect(prompt).toContain('"fromLine":4');
  expect(prompt).toContain("Make it clearer");
  expect(prompt).not.toContain("Shorten this");
  store().complete(batch, { status: "completed", changed: true, error: null });
  expect(items().map((item) => item.feedback)).toEqual(["Shorten this"]);
});

test("a quoted note sends its quote with the block", () => {
  store().reconcile(path, null, "One two three");
  store().attach(path, feedbackTargets("One two three")[0]!, "two");
  store().saveNotes(path, "Cut");
  const batch = store().begin(path, [items()[0]!.id]);
  expect(store().prepare(batch, "One two three")).toContain('"quote":"two"');
});

test.each(["failed", "cancelled", "completed"] as const)(
  "%s without changes keeps feedback pending",
  (status) => {
    const id = create();
    const batch = store().begin(path, [id]);
    store().complete(batch, { status, changed: false, error: null });
    expect(items()[0]).toMatchObject({ status: "pending", reviewRequired: false });
  },
);

test("partial writes require explicit review before retry; persisted running passes recover interrupted", async () => {
  const id = create();
  let batch = store().begin(path, [id]);
  await flushFeedbackPersistence(root);
  await store().load(root, store().generation + 1);
  expect(items()[0]).toMatchObject({ status: "pending", reviewRequired: true });
  expect(() => store().begin(path, [id])).toThrow("Review or reattach");
  store().acknowledge(path, id);
  batch = store().begin(path, [id]);
  store().complete(batch, { status: "cancelled", changed: true, error: null });
  expect(items()[0]?.reviewRequired).toBe(true);
});

test("closed documents are reconciled after normal chat passes and folder moves retain drafts", async () => {
  create();
  vi.mocked(invoke).mockResolvedValue({ content: "Above\n\nParagraph" });
  await reconcileFeedbackAfterTurn(path);
  expect(items()[0]?.anchor.from).toBe(7);
  store().rewritePaths(root, "/moved", true);
  expect(store().byPath["/moved/note.md"]?.[0]).toMatchObject({
    path: "/moved/note.md",
    feedback: "Make it clearer",
  });
});

test("write failure is visible, a subsequent retry persists the latest data", async () => {
  vi.mocked(writePreferenceStrict).mockRejectedValueOnce(new Error("Disk full"));
  create();
  await flushFeedbackPersistence(root).catch(() => {});
  expect(store().error).toContain("Disk full");
  await store().retryPersistence();
  expect(store().error).toBeNull();
  expect((data.values().next().value as { items: unknown[] }).items).toHaveLength(1);
});

test("delayed hydration rejects stale workspaces and gates user mutation", async () => {
  let resolve!: (data: undefined) => void;
  vi.mocked(readPreferenceStrict).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const old = store().load(root, 100);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(store().attach(path, feedbackTargets("Paragraph")[0]!)).toBe(false);
  expect(store().byPath).toEqual({});
  const next = store().load("/other", 101);
  resolve(undefined);
  await Promise.all([old, next]);
  expect(store()).toMatchObject({ root: "/other", loaded: true, byPath: {} });
});

test("stale completion cannot mutate a new workspace", async () => {
  const id = create();
  const batch = store().begin(path, [id]);
  await store().load("/other", store().generation + 1);
  store().complete(batch, { status: "completed", changed: true, error: null });
  expect(store().byPath).toEqual({});
});

test("failed writes retain the latest drafts across workspace departure and return", async () => {
  const id = create();
  vi.mocked(writePreferenceStrict).mockRejectedValue(new Error("Disk full"));
  rewrite(id, "Latest unsaved draft");
  await flushFeedbackPersistence(root).catch(() => {});
  await store().load("/other", store().generation + 1);
  await store().load(root, store().generation + 1);
  expect(items()[0]!.feedback).toBe("Latest unsaved draft");
  expect(store().error).toContain("Disk full");
  vi.mocked(writePreferenceStrict).mockImplementation(async (key, value) => {
    data.set(key, structuredClone(value));
  });
  await store().retryPersistence();
});

test("renames during hydration and after workspace closure update their original durable record", async () => {
  create();
  await flushFeedbackPersistence(root);
  let resolve!: (data: unknown) => void;
  const saved = data.values().next().value;
  vi.mocked(readPreferenceStrict).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const load = store().load(root, store().generation + 1);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  store().rewritePaths(path, `${root}/renamed.md`, false);
  resolve(saved);
  await load;
  expect(store().byPath[`${root}/renamed.md`]?.[0]!.path).toBe(`${root}/renamed.md`);
  const rewrite = captureFeedbackPathRewrite();
  await store().load(null, store().generation + 1);
  await rewrite(`${root}/renamed.md`, path, false);
  await store().load(root, store().generation + 1);
  expect(items()).toHaveLength(1);
});

test("same-generation hydration rejects superseded reads before overwriting newly entered feedback", async () => {
  let first!: (data: unknown) => void, second!: (data: unknown) => void;
  vi.mocked(readPreferenceStrict)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          first = done;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          second = done;
        }),
    );
  const generation = store().generation + 1;
  const old = store().load(root, generation);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const newest = store().load(root, generation);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  second(undefined);
  await newest;
  create();
  first(undefined);
  await old;
  expect(items()).toHaveLength(1);
});

test("close freezes user edits and drains lifecycle completion written during a pending save", async () => {
  const id = create();
  const batch = store().begin(path, [id]);
  await flushFeedbackPersistence(root);
  let resolve!: () => void;
  vi.mocked(writePreferenceStrict).mockImplementationOnce(
    (key, value) =>
      new Promise((done) => {
        resolve = () => {
          data.set(key, structuredClone(value));
          done();
        };
      }),
  );
  const pendingId = create("Other");
  let closed = false;
  const close = flushAllFeedbackPersistence().then(() => {
    closed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(store().takeBack(path, pendingId)).toBeNull();
  store().complete(batch, { status: "completed", changed: true, error: null });
  expect(closed).toBe(false);
  resolve();
  await close;
  expect(closed).toBe(true);
  expect(items().map((x) => x.id)).toEqual([pendingId]);
  expect(items()[0]).toMatchObject({ status: "pending", feedback: "Make it clearer" });
  resumeFeedbackPersistence();
  await store().load(root, store().generation + 1);
  expect(items().map((x) => x.id)).toEqual([pendingId]);
});

test("quit retries retained failures from departed workspaces", async () => {
  create();
  vi.mocked(writePreferenceStrict).mockRejectedValueOnce(new Error("Disk full"));
  rewrite(items()[0]!.id, "Retain me");
  await flushFeedbackPersistence(root).catch(() => {});
  await store().load("/other", store().generation + 1);
  await flushAllFeedbackPersistence();
  resumeFeedbackPersistence();
  await store().load(root, store().generation + 1);
  expect(items()[0]!.feedback).toBe("Retain me");
});
