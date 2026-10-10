import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/theme", () => ({
  applyTheme: vi.fn(),
}));

import { flushSave } from "../src/lib/save";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore } from "../src/stores/editor-store";
import { useSettingsStore } from "../src/stores/settings-store";

const mockedInvoke = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("autosave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    useEditorStore.setState({
      openFiles: new Map(),
      tabs: [],
      activeTabId: null,
      activeFilePath: null,
    });

    useSettingsStore.setState({
      settings: {
        "files.trim-trailing-whitespace": false,
        "files.insert-final-newline": false,
      },
      isLoaded: true,
    });
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  test("flush drains an older in-flight write and bypasses the follow-up throttle", async () => {
    const first = deferred<{ path: string; modified_at: number }>();
    const second = deferred<{ path: string; modified_at: number }>();
    const payloads: string[] = [];
    mockedInvoke.mockImplementation((command, payload) => {
      if (command === "read_file")
        return Promise.resolve({ path: "/flush.md", content: "initial", modified_at: 1 });
      if (command === "write_file") {
        payloads.push((payload as { content: string }).content);
        return payloads.length === 1 ? first.promise : second.promise;
      }
      return Promise.resolve(null);
    });
    await useEditorStore.getState().openFile("/flush.md");
    useEditorStore.getState().updateContent("/flush.md", "old");
    useEditorStore.getState().updateContent("/flush.md", "latest");
    let done = false;
    const flush = flushSave("/flush.md").then(() => {
      done = true;
    });
    expect(done).toBe(false);
    first.resolve({ path: "/flush.md", modified_at: 2 });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(payloads).toEqual(["old", "latest"]);
    expect(done).toBe(false);
    second.resolve({ path: "/flush.md", modified_at: 3 });
    await flush;
    expect(useEditorStore.getState().openFiles.get("/flush.md")?.isDirty).toBe(false);
  });

  test("flush rejects write failures and preserves the dirty buffer", async () => {
    mockedInvoke.mockImplementation((command) =>
      command === "read_file"
        ? Promise.resolve({ path: "/failure.md", content: "initial", modified_at: 1 })
        : command === "write_file"
          ? Promise.reject(new Error("Disk full"))
          : Promise.resolve(null),
    );
    await useEditorStore.getState().openFile("/failure.md");
    useEditorStore.getState().updateContent("/failure.md", "unsaved");
    await expect(flushSave("/failure.md")).rejects.toThrow("Disk full");
    expect(useEditorStore.getState().openFiles.get("/failure.md")?.content).toBe("unsaved");
    expect(useEditorStore.getState().openFiles.get("/failure.md")?.isDirty).toBe(true);
  });

  test("keeps newer edits dirty until a follow-up save completes", async () => {
    const firstWrite = deferred<{ path: string; modified_at: number }>();
    const secondWrite = deferred<{ path: string; modified_at: number }>();
    const writePayloads: string[] = [];

    mockedInvoke.mockImplementation((command, payload) => {
      if (command === "read_file") {
        return Promise.resolve({
          path: "/test.md",
          content: "initial",
          modified_at: 1,
        });
      }

      if (command === "write_file") {
        writePayloads.push((payload as { content: string }).content);
        return writePayloads.length === 1 ? firstWrite.promise : secondWrite.promise;
      }

      return Promise.resolve(null);
    });

    await useEditorStore.getState().openFile("/test.md");

    useEditorStore.getState().updateContent("/test.md", "first draft");
    expect(writePayloads).toEqual(["first draft"]);

    useEditorStore.getState().updateContent("/test.md", "second draft");
    expect(writePayloads).toEqual(["first draft"]);

    firstWrite.resolve({ path: "/test.md", modified_at: 2 });
    await flushMicrotasks();

    const midSave = useEditorStore.getState().openFiles.get("/test.md");
    expect(midSave?.content).toBe("second draft");
    expect(midSave?.diskContent).toBe("first draft");
    expect(midSave?.isDirty).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(writePayloads).toEqual(["first draft", "second draft"]);

    secondWrite.resolve({ path: "/test.md", modified_at: 3 });
    await flushMicrotasks();

    const saved = useEditorStore.getState().openFiles.get("/test.md");
    expect(saved?.content).toBe("second draft");
    expect(saved?.diskContent).toBe("second draft");
    expect(saved?.isDirty).toBe(false);
  });
});
