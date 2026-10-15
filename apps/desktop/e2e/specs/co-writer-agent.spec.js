import { deepStrictEqual, ok } from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const E2E_WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCREENSHOTS = process.env.E2E_SCREENSHOTS;
const MOUNTED = 'button[aria-label="Hide sidebar"], button[aria-label="Show sidebar"]';
const row = (label) =>
  `//section[.//h2[normalize-space()="Co-writer"]]//*[normalize-space()="${label}"]/ancestor::*[.//select][1]//select`;
const KEYS = ["co-writer.agent", "co-writer.model", "co-writer.codex-model"];

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
const options = (select) =>
  browser.execute(
    (el) => [...el.options].map((option) => [option.value, option.textContent]),
    select,
  );
// The driver's selectByAttribute throws on WKWebView.
const choose = (select, value) =>
  browser.execute(
    (el, next) => {
      el.value = next;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    select,
    value,
  );

describe("Settings → Co-writer agent", function () {
  before(async function () {
    const workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 3_000 })
      .catch(() => false);
    if (!workspaceRestored) await invoke("open_workspace", { path: E2E_WORKSPACE });
    for (const key of KEYS) await invoke("reset_setting", { key, scope: "global" });
    await browser.refresh();
    await $(MOUNTED).waitForExist({ timeout: 15_000 });
  });

  after(async function () {
    for (const key of KEYS) await invoke("reset_setting", { key, scope: "global" });
  });

  it("switches to Codex and shows its own model choice", async function () {
    await browser.execute(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
      ),
    );
    const settingsCommand = await $('[cmdk-item][data-value="open-settings"]');
    await settingsCommand.waitForExist({ timeout: 5_000 });
    await settingsCommand.click();

    const agent = await $(row("Agent"));
    await agent.waitForExist({ timeout: 5_000 });
    await browser.execute((el) => el.scrollIntoView({ block: "center" }), agent);
    deepStrictEqual(await options(agent), [
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
    ]);
    deepStrictEqual(
      (await options(await $(row("Model")))).map(([value]) => value),
      ["default", "fable", "opus", "sonnet", "haiku"],
    );

    await choose(agent, "codex");
    await browser.waitUntil(
      async () => (await invoke("get_setting", { key: "co-writer.agent" })).value === "codex",
      { timeout: 5_000, timeoutMsg: "Agent choice was not saved" },
    );
    await browser.waitUntil(
      async () =>
        (await $$(row("Model"))).length === 1 &&
        (await options(await $(row("Model"))))[0][0] === "default" &&
        !(await options(await $(row("Model")))).some(([value]) => value === "fable"),
      { timeout: 5_000, timeoutMsg: "The Model row still lists Claude models" },
    );
    const codexModels = await options(await $(row("Model")));
    ok(codexModels.length >= 1);
    await browser.pause(300);
    if (SCREENSHOTS) await browser.saveScreenshot(`${SCREENSHOTS}/co-writer-agent.png`);

    if (codexModels.length > 1) {
      const [model] = codexModels[1];
      await choose(await $(row("Model")), model);
      await browser.waitUntil(
        async () => (await invoke("get_setting", { key: "co-writer.codex-model" })).value === model,
        { timeout: 5_000, timeoutMsg: "Codex model choice was not saved" },
      );
      deepStrictEqual(await invoke("get_setting", { key: "co-writer.model" }), {
        value: "default",
      });
    }
  });
});
