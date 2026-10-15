import { deepStrictEqual } from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCREENSHOTS = process.env.E2E_SCREENSHOTS;
const MOUNTED = 'button[aria-label="Hide sidebar"], button[aria-label="Show sidebar"]';
const MODEL_SELECT =
  '//section[.//h2[normalize-space()="Co-writer"]]//*[normalize-space()="Model"]/ancestor::*[.//select][1]//select';

function invoke(cmd, args = {}) {
  return browser.executeAsync(
    (command, payload, done) => {
      window.__TAURI_INTERNALS__
        .invoke(command, payload)
        .then((value) => done({ value }))
        .catch((error) => done({ error: String(error) }));
    },
    cmd,
    args,
  );
}

describe("Settings → Co-writer model", function () {
  before(async function () {
    const workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 3_000 })
      .catch(() => false);
    if (!workspaceRestored) await invoke("open_workspace", { path: E2E_WORKSPACE });
    await invoke("reset_setting", { key: "co-writer.model", scope: "global" });
    await browser.refresh();
    await $(MOUNTED).waitForExist({ timeout: 15_000 });
  });

  after(async function () {
    await invoke("reset_setting", { key: "co-writer.model", scope: "global" });
  });

  it("lists the model aliases and saves the chosen one", async function () {
    await browser.execute(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
      ),
    );
    const settingsCommand = await $('[cmdk-item][data-value="open-settings"]');
    await settingsCommand.waitForExist({ timeout: 5_000 });
    await settingsCommand.click();

    const select = await $(MODEL_SELECT);
    await select.waitForExist({ timeout: 5_000 });
    await browser.execute((el) => el.scrollIntoView({ block: "center" }), select);
    deepStrictEqual(
      await browser.execute((el) => [...el.options].map((option) => option.value), select),
      ["default", "fable", "opus", "sonnet", "haiku"],
    );
    deepStrictEqual(await select.getValue(), "default");

    // The driver's selectByAttribute throws on WKWebView.
    await browser.execute((el) => {
      el.value = "haiku";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, select);
    await browser.waitUntil(
      async () => (await invoke("get_setting", { key: "co-writer.model" })).value === "haiku",
      { timeout: 5_000, timeoutMsg: "Model choice was not saved" },
    );
    await browser.pause(300);
    if (SCREENSHOTS) await browser.saveScreenshot(`${SCREENSHOTS}/co-writer-model.png`);

    await browser.refresh();
    await $(MOUNTED).waitForExist({ timeout: 15_000 });
    deepStrictEqual(await invoke("get_setting", { key: "co-writer.model" }), { value: "haiku" });
  });
});
