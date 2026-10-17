import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { invoke } from "@tauri-apps/api/core";
import { getChunks } from "@codemirror/merge";
import {
  firstChangePosition,
  historyPreviewState,
} from "../src/components/version-history/history-preview-extensions";
import {
  isCrowded,
  magnify,
  nearestMark,
  timelineMarks,
  visibleDays,
} from "../src/components/version-history/version-timeline";
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
});

describe("version timeline", () => {
  const versions = [
    version("4", NOW - 60_000),
    version("3", NOW - 120_000),
    version("2", NOW - DAY),
    version("1", NOW - 3 * DAY),
  ];

  test("lays versions out oldest first, labelling the first of each day", () => {
    const marks = timelineMarks(versions, NOW);
    expect(marks.map((mark) => [mark.version.id, mark.day])).toEqual([
      ["1", "Oct 9"],
      ["2", "Yesterday"],
      ["3", "Today"],
      ["4", null],
    ]);
    const at = marks.map((mark) => mark.at);
    expect(at[3] - at[2]).toBeLessThan(at[2] - at[1]);
    expect(at[0]).toBeGreaterThan(0);
    expect(at[3]).toBeLessThan(100);
  });

  test("only a change of day gets a label, however many versions a day holds", () => {
    // Two, two, then four versions a day: summing the gaps drifts past 1.0.
    const day = (ago: number, count: number) =>
      Array.from({ length: count }, (_, i) => version(`${ago}-${i}`, NOW - ago - i * 60_000));
    const marks = timelineMarks([...day(0, 4), ...day(DAY, 2), ...day(3 * DAY, 2)], NOW);
    expect(marks.filter((mark) => mark.day !== null).map((mark) => mark.day)).toEqual([
      "Oct 9",
      "Yesterday",
      "Today",
    ]);
  });

  test("a single version sits in the middle", () => {
    expect(timelineMarks([version("1", NOW)], NOW)[0].at).toBe(50);
  });

  test("crowded day labels thin out, keeping the newest day", () => {
    const marks = timelineMarks(versions, NOW);
    const at = marks.map((mark) => mark.at);
    expect(visibleDays(marks, at, 1)).toEqual([0, 1, 2]);
    expect(visibleDays(marks, at, 40)).toEqual([0, 2]);
    expect(visibleDays(marks, at, 100)).toEqual([2]);
  });

  test("a pointer picks the closest mark", () => {
    const at = timelineMarks(versions, NOW).map((mark) => mark.at);
    expect(nearestMark(at, 0)).toBe(0);
    expect(nearestMark(at, 100)).toBe(3);
    expect(nearestMark(at, at[1] + 1)).toBe(1);
  });

  test("the lens spreads versions near the pointer and keeps their order", () => {
    const at = Array.from({ length: 101 }, (_, i) => i);
    const lensed = magnify(at, 40);
    expect(lensed[40]).toBe(40);
    expect(lensed[0]).toBe(0);
    expect(lensed[100]).toBe(100);
    expect(lensed[41] - lensed[40]).toBeGreaterThan(4);
    expect(lensed[100] - lensed[99]).toBeLessThan(1);
    expect(lensed.every((x, i) => i === 0 || x > lensed[i - 1])).toBe(true);
    expect(magnify(at, 40, 0)).toEqual(at);
    const inset = Array.from({ length: 50 }, (_, i) => 2 + i * 2);
    for (const pointer of [0, 1, 99, 100]) {
      const edge = magnify(inset, pointer);
      expect(edge[0]).toBe(2);
      expect(edge[49]).toBe(100);
    }
  });

  test("the lens is only needed once versions sit too close to point at", () => {
    const few = timelineMarks(versions, NOW).map((mark) => mark.at);
    expect(isCrowded(few, 700)).toBe(false);
    const many = Array.from({ length: 250 }, (_, i) => version(`${i}`, NOW - i * 60_000));
    expect(
      isCrowded(
        timelineMarks(many, NOW).map((mark) => mark.at),
        700,
      ),
    ).toBe(true);
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
