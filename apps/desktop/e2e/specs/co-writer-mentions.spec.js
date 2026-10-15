import { ok, strictEqual } from "node:assert/strict";

// Needs a restorable workspace.
describe("Co-writer @ mentions", function () {
  const SHOTS = process.env.WRITER_E2E_SHOTS;
  let workspaceRestored = false;
  let notePath = null;
  let mentionedPath = null;

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

  async function press(key) {
    await browser.execute((pressed) => {
      (document.activeElement ?? document).dispatchEvent(
        new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true }),
      );
    }, key);
  }

  async function type(text) {
    await browser.execute((value) => {
      const input = document.querySelector('textarea[aria-label="Message"]');
      input.focus();
      input.select();
      document.execCommand("insertText", false, value);
    }, text);
  }

  async function shot(name) {
    if (SHOTS) await browser.saveScreenshot(`${SHOTS}/${name}.png`);
  }

  const composer = () => $('textarea[aria-label="Message"]');
  const menu = () => $('[role="listbox"][aria-label="Files"]');

  before(async function () {
    this.timeout(60_000);
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;
    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the notes into");
    notePath = `${root}/co-writer-mentions-e2e.md`;
    mentionedPath = `${root}/Mention target e2e.md`;
    for (const [path, content] of [
      [mentionedPath, "# Mention target\n\nTone: plain.\n"],
      [notePath, "# Mentions check\n\nHi.\n"],
    ]) {
      const wrote = await invoke("write_file", { path, content });
      ok(wrote.ok, `failed to seed ${path}: ${wrote.error}`);
    }
    const row = await $("span*=Mentions check");
    await row.waitForExist({ timeout: 10_000 });
    await row.click();
    await $(".cm-content").waitForExist({ timeout: 5_000 });
    const open = await $('button[aria-label="Open Co-writer"]');
    if (await open.isExisting()) await open.click();
    await composer().waitForExist({ timeout: 5_000 });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    for (const path of [notePath, mentionedPath]) if (path) await invoke("delete_entry", { path });
  });

  it("lists matching notes after @ and inserts the picked one with a chip", async function () {
    this.timeout(30_000);
    await type("match @mention-tar");
    await menu().waitForExist({ timeout: 10_000, timeoutMsg: "mention menu never appeared" });
    const names = await browser.execute(() =>
      [
        ...document.querySelectorAll('[aria-label="Files"] [role="option"] span span:first-child'),
      ].map((el) => el.textContent),
    );
    ok(names.includes("Mention target e2e"), names.join());
    ok(!names.includes("co-writer-mentions-e2e"), "the chat's own note is listed");
    await shot("mentions-menu");

    await press("Enter");
    await browser.waitUntil(async () => !(await menu().isExisting()), { timeout: 5_000 });
    strictEqual(await composer().getValue(), "match @Mention target e2e ");
    await $(`[data-chat-composer] span[title="${mentionedPath}"]`).waitForExist({
      timeout: 5_000,
      timeoutMsg: "the mentioned note was not attached",
    });
    await shot("mentions-picked");
  });

  it("a bare @ lists recent notes, and Escape keeps the draft", async function () {
    await type("@");
    await menu().waitForExist({ timeout: 5_000 });
    await press("Escape");
    await browser.waitUntil(async () => !(await menu().isExisting()), { timeout: 5_000 });
    strictEqual(await composer().getValue(), "@");
  });

  it("an @ inside a word opens nothing", async function () {
    await type("me@mention");
    await browser.pause(300);
    ok(!(await menu().isExisting()), "menu opened for an email-like word");
  });
});
