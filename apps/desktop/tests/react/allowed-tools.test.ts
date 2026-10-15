import { expect, test, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

import { AllowedTools } from "../../src/components/settings-panel/co-writer-section";

const render = (tools: string[] | null, error: string | null = null) =>
  renderToStaticMarkup(createElement(AllowedTools, { tools, error, onRevoke: () => {} }));

test("lists each saved tool under its source with a revoke button", () => {
  const html = render(["Read", "mcp__notes__search", "mcp__notes__read"]);
  expect(html).toContain('aria-label="Co-writer"');
  expect(html).toContain('aria-label="Notes"');
  expect(html).toContain('aria-label="Revoke Read files (Co-writer)"');
  expect(html).toContain('aria-label="Revoke Search (Notes)"');
  expect(html).toContain('title="mcp__notes__search"');
  expect(html).not.toContain("Nothing yet.");
});

test("offers revoke all only for sources with more than one tool", () => {
  const html = render(["Read", "mcp__notes__search", "mcp__notes__read"]);
  expect(html).toContain('aria-label="Revoke all Notes tools"');
  expect(html).not.toContain('aria-label="Revoke all Co-writer tools"');
});

test("says when nothing is saved, and shows load or revoke errors", () => {
  expect(render([])).toContain("Nothing yet.");
  expect(render(null)).not.toContain("Nothing yet.");
  expect(render([], "Settings not initialized")).toContain("Settings not initialized");
});
