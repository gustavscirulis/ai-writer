import { ok, equal } from "node:assert/strict";

// Embed isolation (see SPECs/embeds-spec.md). The probe embed checks what its
// own code can reach and reports through the frame's error channel, which the
// widget shows in `.cm-embed-error`, so no WebDriver frame switching is needed.
//
// Requires a restorable workspace (see latex-math.spec.js); self-skips without.
describe("HTML embeds", function () {
  const FILE_STEM = "embed-e2e";
  const PROBE = `
(async () => {
  const result = { tauri: typeof window.__TAURI_INTERNALS__ };
  const reach = async (name, run) => {
    try { await run(); result[name] = "reachable"; } catch { result[name] = "blocked"; }
  };
  await reach("parent", () => parent.document.title);
  await reach("top", () => { top.location.href = "about:blank"; });
  await reach("asset", () => fetch("asset://localhost/etc/hosts"));
  await reach("assetHttp", () => fetch("http://asset.localhost/etc/hosts"));
  await reach("ipc", () => fetch("ipc://localhost/plugin%3Aapp%7Cversion", { method: "POST" }));
  await reach("tauriScheme", () => fetch("tauri://localhost/index.html"));
  await reach("network", () => fetch("https://example.com/", { mode: "no-cors" }));
  document.body.style.height = "320px";
  throw new Error("probe " + JSON.stringify(result));
})();`;
  const DOC = [
    "# Embed check",
    "",
    "```html embed",
    "<p>Probe</p>",
    "<script>",
    PROBE,
    "</script>",
    "```",
    "",
    "After.",
    "",
  ].join("\n");

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

  before(async function () {
    workspaceRestored = await $('[data-sidebar-surface][data-workspace-open="true"]')
      .waitForExist({ timeout: 15_000 })
      .catch(() => false);
    if (!workspaceRestored) return;

    const recents = await invoke("get_recent_workspaces", {});
    const root = recents.ok && Array.isArray(recents.value) ? recents.value[0] : null;
    ok(root, "no workspace root to seed the embed document into");

    filePath = `${root}/${FILE_STEM}.md`;
    const wrote = await invoke("write_file", { path: filePath, content: DOC });
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

  it("renders the fence as a sandboxed writer-embed frame", async function () {
    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/embed-open.png`);
    }
    const row = await $(`span*=Embed check`);
    await row.waitForExist({ timeout: 15_000 });
    await row.click();

    const frame = await $(".cm-embed-iframe");
    await frame.waitForExist({ timeout: 10_000 });
    equal(await frame.getAttribute("sandbox"), "allow-scripts allow-forms");
    ok((await frame.getAttribute("src")).startsWith("writer-embed://"));
  });

  it("keeps embed code away from the app, local files and IPC", async function () {
    const error = await $(".cm-embed-error");
    await browser.waitUntil(
      async () => (await error.getProperty("textContent")).startsWith("probe "),
      {
        timeout: 15_000,
        timeoutMsg: "the probe never reported",
      },
    );
    const result = JSON.parse((await error.getProperty("textContent")).slice("probe ".length));
    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/embed-probe.png`);
    }
    console.log("embed probe:", JSON.stringify(result));
    equal(result.tauri, "undefined");
    for (const name of ["parent", "top", "asset", "assetHttp", "ipc", "tauriScheme"]) {
      equal(result[name], "blocked", `${name} should be blocked: ${JSON.stringify(result)}`);
    }
    equal(result.network, "reachable", "embeds may use the network");
  });

  it("sizes the frame to its content", async function () {
    await browser.waitUntil(async () => (await $(".cm-embed-iframe").getSize("height")) >= 320, {
      timeout: 10_000,
      timeoutMsg: "the frame never grew to its content",
    });
  });

  const sourceShown = () =>
    browser.execute(() =>
      [...document.querySelectorAll(".cm-line")].some((line) =>
        line.textContent.includes("html embed"),
      ),
    );

  it("keeps the source closed when the frame is clicked", async function () {
    await $(".cm-embed-iframe").click();
    await browser.pause(300);
    equal(await sourceShown(), false);
  });

  it("selects the whole block when the chrome around the frame is clicked", async function () {
    const rect = await browser.execute(() =>
      document.querySelector(".cm-embed-widget").getBoundingClientRect().toJSON(),
    );
    // Element-relative click offsets land outside the widget under tauri-webdriver.
    await browser
      .action("pointer")
      .move({
        origin: "viewport",
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + 3),
      })
      .down()
      .up()
      .perform();
    await browser.waitUntil(
      () => browser.execute(() => !!document.querySelector(".cm-embed-widget.cm-embed-selected")),
      { timeout: 5_000, timeoutMsg: "the block never became selected" },
    );
    equal(await sourceShown(), false);
    if (process.env.VERIFY_SHOT_DIR) {
      await browser.saveScreenshot(`${process.env.VERIFY_SHOT_DIR}/embed-selected.png`);
    }
  });
});
