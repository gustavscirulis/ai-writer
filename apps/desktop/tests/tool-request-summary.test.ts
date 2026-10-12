import { describe, expect, test } from "vite-plus/test";
import { summarizeToolRequest } from "../src/lib/tool-request-summary";

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

  test("shows absolute paths when no workspace is open", () => {
    expect(summarizeToolRequest("Read", { file_path: "/notes/a.md" }, null).where).toBe("/notes");
  });
});
