import { deepStrictEqual, ok } from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCREENSHOTS = process.env.E2E_SCREENSHOTS;

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

describe("Settings → Co-writer allowed tools", function () {
  before(async function () {
    const workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 3_000 })
      .catch(() => false);
    if (!workspaceRestored) await invoke("open_workspace", { path: E2E_WORKSPACE });
    await invoke("set_setting", {
      key: "co-writer.allowed-tools",
      value: ["Read", "mcp__notes__search"],
      scope: "global",
    });
    await browser.refresh();
    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 15_000 });
  });

  it("lists saved tools and revokes one", async function () {
    deepStrictEqual(await invoke("co_writer_allowed_tools"), {
      value: ["Read", "mcp__notes__search"],
    });
    await browser.execute(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
      ),
    );
    const settingsCommand = await $('[cmdk-item][data-value="open-settings"]');
    await settingsCommand.waitForExist({ timeout: 5_000 });
    await settingsCommand.click();

    const revokeRead = await $('button[aria-label="Revoke Read files"]');
    await revokeRead.waitForExist({ timeout: 5_000 });
    await browser.execute((el) => el.scrollIntoView({ block: "center" }), revokeRead);
    await browser.pause(300);
    ok(await $('button[aria-label="Revoke Use search from notes"]').isExisting());
    ok(
      !(await $(
        '//section[.//h2[normalize-space()="Co-writer"]]//button[normalize-space()="+ Add"]',
      ).isExisting()),
    );
    if (SCREENSHOTS) await browser.saveScreenshot(`${SCREENSHOTS}/allowed-tools-before.png`);

    await revokeRead.click();
    await browser.waitUntil(
      async () => !(await $('button[aria-label="Revoke Read files"]').isExisting()),
      { timeout: 5_000, timeoutMsg: "Read stayed listed after Revoke" },
    );
    deepStrictEqual(await invoke("co_writer_allowed_tools"), { value: ["mcp__notes__search"] });
    await browser.pause(300);
    if (SCREENSHOTS) await browser.saveScreenshot(`${SCREENSHOTS}/allowed-tools-after.png`);

    await $('button[aria-label="Revoke Use search from notes"]').click();
    await $('//*[normalize-space()="Nothing yet."]').waitForExist({ timeout: 5_000 });
    deepStrictEqual(await invoke("co_writer_allowed_tools"), { value: [] });
  });
});
