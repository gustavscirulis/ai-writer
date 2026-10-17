import { ok, strictEqual } from "node:assert/strict";

// Needs a restorable workspace and a signed-in Claude Code CLI that has at least one skill.
describe("Co-writer skills menu", function () {
  const SHOTS = process.env.WRITER_E2E_SHOTS;
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

  const composer = () => $('textarea[aria-label="Message"]');
  const menu = () => $('[role="listbox"][aria-label="Skills"]');

  before(async function () {
    this.timeout(120_000);
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;
    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the note into");
    filePath = `${root}/co-writer-skills-e2e.md`;
    const wrote = await invoke("write_file", {
      path: filePath,
      content: "# Skills check\n\nHi.\n",
    });
    ok(wrote.ok, `failed to seed ${filePath}: ${wrote.error}`);
    const row = await $("span*=Skills check");
    await row.waitForExist({ timeout: 10_000 });
    await row.click();
    await $(".cm-content").waitForExist({ timeout: 5_000 });
    const open = await $('button[aria-label="Co-writer"][aria-pressed="false"]');
    if (await open.isExisting()) await open.click();
    await composer().waitForExist({ timeout: 5_000 });
  });

  beforeEach(function () {
    if (!workspaceRestored) this.skip();
  });

  after(async function () {
    if (filePath) await invoke("delete_entry", { path: filePath });
  });

  it("lists matching skills after / and completes the picked one", async function () {
    this.timeout(120_000);
    await composer().click();
    await composer().addValue("/ux");
    await menu().waitForExist({
      timeout: 90_000,
      timeoutMsg: "skills menu never appeared (Claude Code may not have listed skills)",
    });
    const names = await browser.execute(() =>
      [
        ...document.querySelectorAll('[aria-label="Skills"] [role="option"] span span:first-child'),
      ].map((el) => el.textContent),
    );
    ok(names.length > 0 && names.every((name) => name.toLowerCase().includes("ux")), names.join());
    await shot("skills-menu");

    await press("ArrowDown");
    const second = await browser.execute(
      () => document.querySelector('[aria-label="Skills"] [aria-selected="true"]')?.id,
    );
    strictEqual(second, names.length > 1 ? "co-writer-skills-1" : "co-writer-skills-0");
    await press("Enter");
    await browser.waitUntil(async () => !(await menu().isExisting()), { timeout: 5_000 });
    strictEqual(await composer().getValue(), `${names[names.length > 1 ? 1 : 0]} `);
    await shot("skills-picked");
  });

  it("opens after text already in the draft and completes in place", async function () {
    await browser.execute(() => {
      const input = document.querySelector('textarea[aria-label="Message"]');
      input.focus();
      input.select();
      document.execCommand("insertText", false, "tighten this /ux");
    });
    await menu().waitForExist({ timeout: 5_000 });
    const name = await browser.execute(
      () =>
        document.querySelector('[aria-label="Skills"] [aria-selected="true"] span span')
          ?.textContent,
    );
    await shot("skills-menu-mid-draft");
    await press("Enter");
    await browser.waitUntil(async () => !(await menu().isExisting()), { timeout: 5_000 });
    const draft = `tighten this ${name} `;
    strictEqual(await composer().getValue(), draft);
    const caret = await browser.execute(
      () => document.querySelector('textarea[aria-label="Message"]').selectionStart,
    );
    strictEqual(caret, draft.length);
    await shot("skills-picked-mid-draft");
  });

  it("Escape dismisses the menu and keeps the draft", async function () {
    await browser.execute(() => {
      const input = document.querySelector('textarea[aria-label="Message"]');
      input.focus();
      input.select();
      document.execCommand("insertText", false, "/ux");
    });
    await menu().waitForExist({ timeout: 5_000 });
    await press("Escape");
    await browser.waitUntil(async () => !(await menu().isExisting()), { timeout: 5_000 });
    strictEqual(await composer().getValue(), "/ux");
  });
});
