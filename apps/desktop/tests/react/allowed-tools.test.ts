import { expect, test, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

import { AllowedTools } from "../../src/components/settings-panel/co-writer-section";

const render = (tools: string[] | null, error: string | null = null) =>
  renderToStaticMarkup(createElement(AllowedTools, { tools, error, onRevoke: () => {} }));

test("lists each saved tool with a revoke button", () => {
  const html = render(["Read", "mcp__notes__search"]);
  expect(html).toContain("Read files");
  expect(html).toContain("Use search from notes");
  expect(html).toContain('aria-label="Revoke Read files"');
  expect(html).not.toContain("Nothing yet.");
});

test("says when nothing is saved, and shows load or revoke errors", () => {
  expect(render([])).toContain("Nothing yet.");
  expect(render(null)).not.toContain("Nothing yet.");
  expect(render([], "Settings not initialized")).toContain("Settings not initialized");
});
