import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { getChunks } from "@codemirror/merge";
import {
  firstChangePosition,
  historyPreviewState,
} from "../src/components/version-history/history-preview-extensions";
import { groupVersions } from "../src/components/version-history/version-groups";
import { bodyKey, useHistoryStore } from "../src/stores/history-store";
import { useEditorStore } from "../src/stores/editor-store";
import { clearAgentEditing } from "../src/lib/agent-turn";
import type { NoteVersion } from "../src/lib/tauri";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn(), resolveTheme: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 12, 15, 0).getTime();

function version(id: string, updatedAt: number, source: NoteVersion["source"] = "user") {
  return { id, createdAt: updatedAt, updatedAt, source };
}

describe("history preview", () => {
  test("shows the selected version with the changes since the previous one", () => {
    const state = historyPreviewState(
      "# Title\n\nNew paragraph.\n",
      "# Title\n\nOld paragraph.\n",
      () => "/n.md",
    );
    expect(state.doc.toString()).toBe("# Title\n\nNew paragraph.\n");
    expect(getChunks(state)?.chunks).toHaveLength(1);
    expect(firstChangePosition(state)).toBe(9);
  });

  test("is read-only and parks the selection on a trailing empty line", () => {
    const state = historyPreviewState("# Title", "# Title", () => "/n.md");
    expect(state.readOnly).toBe(true);
    expect(state.doc.toString()).toBe("# Title\n");
    expect(state.selection.main.head).toBe(state.doc.length);
    expect(firstChangePosition(state)).toBeNull();
    const next = state.update({ changes: { from: 0, insert: "x" } }).state;
    expect(next.doc.toString()).toBe("# Title\n");
  });

  test("versions group under day headings, newest first", () => {
    const groups = groupVersions(
      [version("3", NOW - 60_000), version("2", NOW - DAY), version("1", NOW - 3 * DAY)],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.versions.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 1],
      ["Oct 9", 1],
    ]);
  });
});

describe("history store", () => {
  const versions = [
    version("3-agent", NOW, "agent"),
    version("2-user", NOW - 1000),
    version("1-external", NOW - 2000, "external"),
  ];
  const contents: Record<string, string> = {
    "3-agent": "Claude edit",
    "2-user": "---\ntitle: T\n---\nMy edit",
    "1-external": "Original",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearAgentEditing();
    useHistoryStore.getState().close();
    useEditorStore.setState({ openFiles: new Map(), tabs: [], activeTabId: null });
    mockedInvoke.mockImplementation(async (command, args) => {
      const id = (args as { id?: string } | undefined)?.id ?? "";
      if (command === "history_list") return versions;
      if (command === "history_read" || command === "history_restore") return contents[id];
      return undefined;
    });
  });

  test("opening selects the current version and loads it with its predecessor", async () => {
    await useHistoryStore.getState().open("/n.md");
    await vi.waitFor(() => expect(useHistoryStore.getState().bodies.size).toBe(2));
    const state = useHistoryStore.getState();
    expect(state.selectedId).toBe("3-agent");
    expect(state.bodies.get(bodyKey(versions[1]))).toBe("My edit");
  });

  test("arrow navigation stays within the list", async () => {
    await useHistoryStore.getState().open("/n.md");
    useHistoryStore.getState().move(-1);
    expect(useHistoryStore.getState().selectedId).toBe("3-agent");
    useHistoryStore.getState().move(1);
    useHistoryStore.getState().move(1);
    useHistoryStore.getState().move(1);
    expect(useHistoryStore.getState().selectedId).toBe("1-external");
  });

  test("restoring the current version does nothing", async () => {
    await useHistoryStore.getState().open("/n.md");
    await useHistoryStore.getState().restore();
    expect(mockedInvoke).not.toHaveBeenCalledWith("history_restore", expect.anything());
  });

  test("restoring an earlier version writes it and closes history", async () => {
    await useHistoryStore.getState().open("/n.md");
    useHistoryStore.getState().select("1-external");
    await useHistoryStore.getState().restore();
    expect(mockedInvoke).toHaveBeenCalledWith("history_restore", {
      path: "/n.md",
      id: "1-external",
    });
    expect(useHistoryStore.getState().path).toBeNull();
  });

  test("a stale list for a closed history is ignored", async () => {
    const opening = useHistoryStore.getState().open("/n.md");
    useHistoryStore.getState().close();
    await opening;
    expect(useHistoryStore.getState().versions).toEqual([]);
  });
});
