import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCREENSHOT_DIR = resolve(import.meta.dirname, "../../../../.context");
const NOTES = ["alpha", "bravo", "charlie", "delta"];
const APP_DATA = join(homedir(), "Library/Application Support/com.writer-computer.e2e");

async function invoke(cmd, args) {
  const error = await browser.executeAsync(
    (command, payload, done) => {
      window.__TAURI_INTERNALS__
        .invoke(command, payload)
        .then(() => done(null))
        .catch((err) => done(err && err.message ? err.message : String(err)));
    },
    cmd,
    args,
  );
  strictEqual(error, null);
}

async function reloadAndWaitForTabs(count) {
  await browser.execute(() => {
    window.__staleBeforeReload = true;
  });
  await browser.refresh();
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expected) =>
          !window.__staleBeforeReload &&
          document.querySelectorAll("[data-tab-strip] [data-tab-id]").length === expected,
        count,
      ),
    { timeout: 15_000, timeoutMsg: `reloaded app did not show ${count} tabs` },
  );
}

async function tabTitles() {
  return browser.execute(() =>
    [...document.querySelectorAll("[data-tab-strip] [data-tab-id]")].map((el) =>
      el.textContent.replace("×", "").trim(),
    ),
  );
}

async function activeTitle() {
  return browser.execute(() => {
    const active = [...document.querySelectorAll("[data-tab-strip] [data-tab-id]")].find((el) =>
      el.querySelector("[role=button].backdrop-blur-2xl"),
    );
    return active ? active.textContent.replace("×", "").trim() : null;
  });
}

/** Dispatches a pointer drag on the tab titled `title`, moving `dx` px in `steps`. */
async function dragTab(title, dx, { escape = false, screenshot } = {}) {
  await browser.execute(
    (tabTitle, distance) => {
      const tab = [...document.querySelectorAll("[data-tab-strip] [data-tab-id]")].find(
        (el) => el.textContent.replace("×", "").trim() === tabTitle,
      );
      const rect = tab.getBoundingClientRect();
      window.__tabDrag = { x: rect.left + 20, y: rect.top + rect.height / 2, distance };
      tab.firstElementChild.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          pointerId: 1,
          clientX: window.__tabDrag.x,
          clientY: window.__tabDrag.y,
        }),
      );
    },
    title,
    dx,
  );
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await browser.execute((fraction) => {
      const { x, y, distance } = window.__tabDrag;
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerId: 1,
          buttons: 1,
          clientX: x + distance * fraction,
          clientY: y,
        }),
      );
    }, i / steps);
    await browser.pause(30);
  }
  if (screenshot) await browser.saveScreenshot(join(SCREENSHOT_DIR, screenshot));
  if (escape) {
    await browser.execute(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  }
  await browser.execute((tabTitle) => {
    const { x, y, distance } = window.__tabDrag;
    window.dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 1, clientX: x + distance, clientY: y }),
    );
    [...document.querySelectorAll("[data-tab-strip] [data-tab-id]")]
      .find((el) => el.textContent.replace("×", "").trim() === tabTitle)
      .firstElementChild.click();
  }, title);
  await browser.pause(300);
}

describe("Tab drag reordering", function () {
  before(async function () {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "writer-tab-reorder-")));
    for (const name of NOTES) writeFileSync(join(workspace, `${name}.md`), `# ${name}\n`);

    await $('button[aria-label="Hide sidebar"]').waitForExist({ timeout: 15_000 });
    await invoke("open_workspace", { path: workspace });
    await invoke("save_session", {
      workspaceRoot: workspace,
      tabs: NOTES.map((name) => ({
        location: { kind: "file", path: join(workspace, `${name}.md`) },
        back: [],
        forward: [],
      })),
      activeIndex: 0,
    });
    // Startup restores recent_workspaces[0], so make this workspace the one a reload reopens.
    writeFileSync(join(APP_DATA, "recent_workspaces.json"), JSON.stringify([workspace]));
    await reloadAndWaitForTabs(NOTES.length);
  });

  it("moves a tab past its neighbours without activating it", async function () {
    deepStrictEqual(await tabTitles(), NOTES);
    strictEqual(await activeTitle(), "alpha");
    const pastLast = await browser.execute(() => {
      const tabs = document.querySelectorAll("[data-tab-strip] [data-tab-id]");
      return tabs[3].getBoundingClientRect().right - tabs[1].getBoundingClientRect().right;
    });

    await dragTab("bravo", pastLast, { screenshot: "tab-reorder-mid-drag.png" });

    deepStrictEqual(await tabTitles(), ["alpha", "charlie", "delta", "bravo"]);
    strictEqual(await activeTitle(), "alpha");
    await browser.saveScreenshot(join(SCREENSHOT_DIR, "tab-reorder-after.png"));
  });

  it("drags left to the front", async function () {
    await dragTab("delta", -1000);
    deepStrictEqual(await tabTitles(), ["delta", "alpha", "charlie", "bravo"]);
  });

  it("Escape cancels the drag", async function () {
    await dragTab("alpha", 400, { escape: true });
    deepStrictEqual(await tabTitles(), ["delta", "alpha", "charlie", "bravo"]);
    const transforms = await browser.execute(() =>
      [...document.querySelectorAll("[data-tab-strip] [data-tab-id]")].map(
        (el) => el.style.transform,
      ),
    );
    deepStrictEqual(transforms, ["", "", "", ""]);
  });

  it("keeps the new order after a reload", async function () {
    await browser.pause(1_000);
    await reloadAndWaitForTabs(NOTES.length);
    deepStrictEqual(await tabTitles(), ["delta", "alpha", "charlie", "bravo"]);
  });
});
