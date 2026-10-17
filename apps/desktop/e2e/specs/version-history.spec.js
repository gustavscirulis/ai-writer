import { ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

// Self-skips without a restorable workspace, like latex-math.spec.js.
describe("Version history", function () {
  const FIRST = "# History check\n\nFirst draft.\n";
  const SECOND = "# History check\n\nSecond draft from another app.\n";
  const SHOTS = process.env.WRITER_E2E_SHOTS;
  // History outlives the note, so each run needs a fresh name.
  const FILE_STEM = `version-history-e2e-${Date.now()}`;

  let workspaceRestored = false;
  let filePath = null;

  async function invoke(cmd, args) {
    return browser.executeAsync(
      (c, a, done) => {
        window.__TAURI_INTERNALS__
          .invoke(c, a)
          .then((v) => done({ ok: true, value: v }))
          .catch((e) => done({ ok: false, error: e && e.message ? e.message : String(e) }));
      },
      cmd,
      args,
    );
  }

  async function versions() {
    const listed = await invoke("history_list", { path: filePath });
    ok(listed.ok, listed.error);
    return listed.value;
  }

  async function press(key, modifiers = {}) {
    await browser.execute(
      (pressed, mods) => {
        (document.activeElement ?? document).dispatchEvent(
          new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true, ...mods }),
        );
      },
      key,
      modifiers,
    );
  }

  async function shot(name) {
    if (SHOTS) await browser.saveScreenshot(`${SHOTS}/${name}.png`);
  }

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;
    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the note into");
    filePath = `${root}/${FILE_STEM}.md`;
    const wrote = await invoke("write_file", { path: filePath, content: FIRST });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);
    // The watcher drops the app's own writes, so reload to rescan the workspace.
    await browser.refresh();
    await $('[data-sidebar-surface][data-workspace-open="true"]').waitForExist({ timeout: 15_000 });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (filePath) await invoke("delete_entry", { path: filePath });
  });

  it("records the seeded save, an outside edit and a typed edit as versions", async function () {
    let row = await $("span*=History check");
    let found = await row.waitForExist({ timeout: 10_000 }).catch(() => false);
    if (!found) {
      row = await $(`span*=${FILE_STEM}`);
      found = await row.waitForExist({ timeout: 2_000 }).catch(() => false);
    }
    if (!found) await shot("history-no-row");
    ok(found, "seeded note never appeared in the sidebar");
    await row.click();
    await $(".cm-content").waitForExist({ timeout: 5_000 });

    // Writes within 2s of the app's own save are treated as its echo.
    await browser.pause(2_500);
    writeFileSync(filePath, SECOND);
    await browser.waitUntil(async () => (await versions()).length === 2, { timeout: 10_000 });

    await browser.execute(() => {
      document.querySelector(".cm-content").focus();
      document.execCommand("insertText", false, "Typed. ");
    });
    await browser.waitUntil(async () => (await versions()).length === 3, { timeout: 10_000 });
    const sources = (await versions()).map((v) => v.source);
    strictEqual(JSON.stringify(sources), JSON.stringify(["user", "external", "user"]));
  });

  it("opens history on the current version with its changes highlighted", async function () {
    await press("H", { metaKey: true, shiftKey: true });
    await $('section[aria-label="Version history"]').waitForExist({ timeout: 5_000 });
    await $(".writer-history-preview").waitForExist({ timeout: 5_000 });
    await browser.waitUntil(
      async () => (await $$(".writer-history-preview .cm-changedText")).length > 0,
      {
        timeout: 5_000,
      },
    );
    await shot("history-current");
  });

  it("flips to older versions with the arrow keys", async function () {
    await press("ArrowDown");
    await browser.waitUntil(
      async () => (await $$(".writer-history-preview .cm-deletedText")).length > 0,
      { timeout: 5_000 },
    );
    await shot("history-external");
    await press("ArrowDown");
    await browser.waitUntil(
      async () =>
        (await $(".writer-history-preview .cm-content").getText()).includes("First draft."),
      { timeout: 5_000 },
    );
  });

  it("restores the oldest version as a new Restored version", async function () {
    await $("button=Restore").click();
    await $('section[aria-label="Version history"]').waitForExist({
      reverse: true,
      timeout: 5_000,
    });
    strictEqual(readFileSync(filePath, "utf8"), FIRST);
    await browser.waitUntil(async () => (await versions())[0]?.source === "restore", {
      timeout: 5_000,
    });
    await press("H", { metaKey: true, shiftKey: true });
    await $("span=Restored").waitForExist({ timeout: 5_000 });
    await shot("history-restored");
    await press("Escape");
  });

  it("leaves the note alone when Esc closes history on an older version", async function () {
    const before = readFileSync(filePath, "utf8");
    const count = (await versions()).length;
    await press("H", { metaKey: true, shiftKey: true });
    await $('section[aria-label="Version history"]').waitForExist({ timeout: 5_000 });
    await $(".writer-history-preview").waitForExist({ timeout: 5_000 });
    await press("ArrowLeft");
    await $(".history-dock-actions[data-shown]").waitForExist({ timeout: 5_000 });
    await shot("history-esc-older");
    await press("Escape");
    await $('section[aria-label="Version history"]').waitForExist({
      reverse: true,
      timeout: 5_000,
    });
    // Longer than the save debounce, so a stray write would have landed.
    await browser.pause(2_500);
    strictEqual(readFileSync(filePath, "utf8"), before);
    strictEqual((await versions()).length, count);
    ok((await $(".cm-content").getText()).includes("First draft."));
  });

  it("opens from the Co-writer header and leaves Co-writer open", async function () {
    const toggled = !(await $('aside[aria-label="Co-writer"]').isExisting());
    if (toggled) await press("L", { metaKey: true, shiftKey: true });
    const button = await $('aside[aria-label="Co-writer"] button[aria-label="Version history"]');
    await button.waitForExist({ timeout: 5_000 });
    await button.click();
    await $('section[aria-label="Version history"]').waitForExist({ timeout: 5_000 });
    strictEqual(await $('aside[aria-label="Co-writer"]').isExisting(), true);
    await shot("history-chat-header");
    await button.click();
    await $('section[aria-label="Version history"]').waitForExist({
      reverse: true,
      timeout: 5_000,
    });
    if (toggled) await press("L", { metaKey: true, shiftKey: true });
  });
});
