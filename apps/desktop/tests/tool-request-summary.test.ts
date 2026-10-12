import { describe, expect, test } from "vite-plus/test";
import {
  allowedToolLabel,
  alwaysAllowLabel,
  summarizeToolRequest,
} from "../src/lib/tool-request-summary";

const ROOT = "/Users/sam/Vault";

describe("summarizeToolRequest", () => {
  test.each([
    [
      "Read",
      { file_path: "/Users/sam/Vault/Research/maria.md" },
      { verb: "Read", target: "maria.md", where: "Vault/Research", allowLabel: "Yes, read it" },
    ],
    [
      "Read",
      { file_path: "/Users/sam/Desktop/brief.md" },
      { verb: "Read", target: "brief.md", where: "/Users/sam/Desktop", allowLabel: "Yes, read it" },
    ],
    [
      "Grep",
      { pattern: "first week", path: "/Users/sam/Vault/" },
      { verb: "Search for", target: "“first week”", where: "Vault", allowLabel: "Yes, search" },
    ],
    [
      "Glob",
      { pattern: "**/*.md" },
      { verb: "Find files matching", target: "**/*.md", where: null, allowLabel: "Yes, find them" },
    ],
    ["Read", { offset: 4 }, { verb: "Use", target: "Read", where: null, allowLabel: "Allow" }],
    [
      "mcp__notes__search",
      { query: "A writer's notes", options: { limit: 3 } },
      { verb: "Use", target: "mcp__notes__search", where: "A writer's notes", allowLabel: "Allow" },
    ],
    [
      "WebFetch",
      { url: "https://example.com", prompt: " " },
      { verb: "Use", target: "WebFetch", where: "https://example.com", allowLabel: "Allow" },
    ],
    [
      "WebSearch",
      { query: "IANA example domains", allowed_domains: ["iana.org"] },
      { verb: "Use", target: "WebSearch", where: "IANA example domains", allowLabel: "Allow" },
    ],
  ])("%s %j", (tool, input, expected) => {
    expect(summarizeToolRequest(tool, input, ROOT)).toEqual(expected);
  });

  test.each([
    ["Edit", true, { verb: "Edit", allowLabel: "Yes, edit it" }],
    ["Write", false, { verb: "Create", allowLabel: "Yes, create it" }],
    ["Write", true, { verb: "Replace", allowLabel: "Yes, replace it" }],
  ])("%s on another note (exists: %s)", (tool, exists, expected) => {
    const path = "/Users/sam/Vault/Ideas/next.md";
    expect(summarizeToolRequest(tool, { file_path: path }, ROOT, { path, exists })).toEqual({
      ...expected,
      target: "next.md",
      where: "Vault/Ideas",
    });
  });

  test("shows absolute paths when no workspace is open", () => {
    expect(summarizeToolRequest("Read", { file_path: "/notes/a.md" }, null).where).toBe("/notes");
  });
});

describe("alwaysAllowLabel", () => {
  test.each([
    ["Read", "Yes, and don't ask again to read files"],
    ["Write", "Yes, and don't ask again to create or replace other notes"],
    ["mcp__notes__search", "Yes, and don't ask again to use mcp__notes__search"],
  ])("%s", (tool, label) => expect(alwaysAllowLabel(tool)).toBe(label));
});

describe("allowedToolLabel", () => {
  test.each([
    ["Read", "Read files"],
    ["WebFetch", "Fetch web pages"],
    ["Write", "Create or replace other notes"],
    ["mcp__notes__search_all", "Use search_all from notes"],
    ["Unknown", "Use Unknown"],
  ])("%s", (tool, label) => expect(allowedToolLabel(tool)).toBe(label));
});
