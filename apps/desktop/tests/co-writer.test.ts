import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const data = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/preferences", () => ({
  readPreferenceStrict: vi.fn(async (key: string) => data.get(key)),
  writePreferenceStrict: vi.fn(async (key: string, value: unknown) => {
    data.set(key, structuredClone(value));
  }),
}));
import { invoke } from "@tauri-apps/api/core";
import {
  connectedServers,
  displayName,
  isBlankNote,
  newNoteSuggestions,
  serversFootnote,
  starterText,
  toolSuggestions,
  type McpServer,
} from "../src/lib/co-writer-suggestions";
import {
  matchSkills,
  promptContent,
  slashQuery,
  type Capabilities,
  type Skill,
} from "../src/lib/co-writer-skills";
import { loadCapabilities, skillsFor, useCoWriterStore } from "../src/stores/co-writer-store";

const server = (name: string, status = "connected"): McpServer => ({ name, status });
const skill = (name: string, aliases: string[] = []): Skill => ({
  name,
  description: "",
  argumentHint: "",
  aliases,
});
const servers = [
  server("plugin:base:glean"),
  server("claude.ai Gmail", "needs-auth"),
  server("plugin:analytics-tools:snowflake"),
  server("plugin:productivity:google calendar"),
  server("plugin:design:google calendar"),
  server("claude.ai Slack"),
];

describe("suggestion helpers", () => {
  test("names servers the way the user knows them", () => {
    expect(displayName("plugin:base:glean")).toBe("Glean");
    expect(displayName("claude.ai Google Drive")).toBe("Google Drive");
    expect(displayName("claude.ai Google Drive Custom")).toBe("Google Drive Custom");
    expect(displayName("plugin:productivity:linear")).toBe("Linear");
  });

  test("keeps connected servers once per display name", () => {
    expect(connectedServers(servers).map((s) => displayName(s.name))).toEqual([
      "Glean",
      "Snowflake",
      "Google calendar",
      "Slack",
    ]);
  });

  test("leads with the writer's best tools and fills to four with built-in ones", () => {
    expect(toolSuggestions(servers).map((s) => s.tool)).toEqual([
      "Glean",
      "Snowflake",
      "web",
      "web",
    ]);
    expect(toolSuggestions([server("claude.ai Google Drive")]).map((s) => s.tool)).toEqual([
      "Google Drive",
      "web",
      "web",
      "workspace",
    ]);
    expect(toolSuggestions(null).map((s) => s.tool)).toEqual(["web", "web", "workspace"]);
  });

  test("new notes get starters: an outline, two connected tools, then the web", () => {
    expect(newNoteSuggestions(servers)).toEqual([
      { label: "Draft an outline about…", tool: "draft", starter: true },
      { label: "Brief me from Glean on…", tool: "Glean", starter: true },
      { label: "Pull the numbers from Snowflake on…", tool: "Snowflake", starter: true },
      { label: "Find recent sources on…", tool: "web", starter: true },
    ]);
    expect(newNoteSuggestions(null).map((s) => s.tool)).toEqual(["draft", "web", "workspace"]);
    expect(starterText("Draft an outline about…")).toBe("Draft an outline about ");
  });

  test("a note with only headings counts as blank", () => {
    expect(isBlankNote("")).toBe(true);
    expect(isBlankNote("# Untitled\n\n")).toBe(true);
    expect(isBlankNote("# Pricing\n\nFin is $0.99 per resolution.")).toBe(false);
  });

  test("footnote mentions MCPs unless none are connected", () => {
    expect(serversFootnote(servers)).toBe(
      "Runs on your Claude Code, with the same tools and MCPs.",
    );
    expect(serversFootnote(null)).toBe("Runs on your Claude Code, with the same tools and MCPs.");
    expect(serversFootnote([server("claude.ai Gmail", "needs-auth")])).toBe(
      "Runs on your Claude Code, with the same tools.",
    );
  });
});

describe("co-writer store", () => {
  beforeEach(() => {
    data.clear();
    vi.mocked(invoke).mockReset();
  });

  const capabilities: Capabilities = { mcpServers: servers, skills: [skill("ux-copy")] };

  test("shows cached servers and skills at once and refreshes them from Claude Code", async () => {
    const stored: Capabilities = { mcpServers: [server("claude.ai Slack")], skills: [] };
    data.set("co-writer.capabilities", { "/cached": stored });
    let resolve!: (value: Capabilities) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const discovery = loadCapabilities("/cached");
    await vi.waitFor(() =>
      expect(useCoWriterStore.getState().capabilities["/cached"]).toEqual(stored),
    );
    resolve(capabilities);
    await discovery;
    expect(useCoWriterStore.getState().capabilities["/cached"]).toBe(capabilities);
    expect(skillsFor("/cached")).toEqual([skill("ux-copy")]);
    await vi.waitFor(() =>
      expect(data.get("co-writer.capabilities")).toEqual({ "/cached": capabilities }),
    );
    expect(loadCapabilities("/cached")).toBe(discovery);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("marks capabilities unavailable when Claude Code can't list them and nothing is cached", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValue(new Error("Not logged in"));
    await expect(loadCapabilities("/fail")).rejects.toThrow("Not logged in");
    await vi.waitFor(() =>
      expect(useCoWriterStore.getState().capabilities["/fail"]).toBe("unavailable"),
    );
    expect(skillsFor("/fail")).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      "[co-writer] Could not list MCP servers and skills",
      expect.any(Error),
    );
    error.mockRestore();
  });
});

describe("skills", () => {
  const skills = [
    skill("ux-copy"),
    skill("design:ux-copy"),
    skill("better-writing"),
    skill("pdf", ["anthropic-skills:pdf"]),
  ];

  test("the menu opens only while the draft is a single slash word", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/ux")).toBe("ux");
    expect(slashQuery("/ux-copy ")).toBeNull();
    expect(slashQuery("draft /ux")).toBeNull();
  });

  test("name and namespaced-name prefixes rank above substrings", () => {
    expect(matchSkills("ux", skills).map((s) => s.name)).toEqual(["ux-copy", "design:ux-copy"]);
    expect(matchSkills("writ", skills).map((s) => s.name)).toEqual(["better-writing"]);
    expect(matchSkills("", skills)).toEqual(skills);
    expect(matchSkills("zzz", skills)).toEqual([]);
  });

  test("a known skill leads the prompt so Claude Code runs it; other slashes stay as text", () => {
    const context = { openFile: "/n.md" };
    const block = '<writer_context>{"openFile":"/n.md"}</writer_context>';
    expect(promptContent(context, "/ux-copy the signup button", skills)).toBe(
      `/ux-copy the signup button\n\n${block}`,
    );
    expect(promptContent(context, "/anthropic-skills:pdf", skills)).toBe(
      `/anthropic-skills:pdf\n\n${block}`,
    );
    expect(promptContent(context, "/Users/me/notes.md is wrong", skills)).toBe(
      `${block}\n\n/Users/me/notes.md is wrong`,
    );
    expect(promptContent(context, "/ux-copywriter", skills)).toBe(`${block}\n\n/ux-copywriter`);
  });
});
