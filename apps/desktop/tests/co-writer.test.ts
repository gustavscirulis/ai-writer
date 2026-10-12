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
  serversFootnote,
  toolSuggestions,
  type McpServer,
} from "../src/lib/co-writer-suggestions";
import { loadMcpServers, useCoWriterStore } from "../src/stores/co-writer-store";

const server = (name: string, status = "connected"): McpServer => ({ name, status });
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

  test("shows cached servers at once and refreshes them from Claude Code", async () => {
    data.set("co-writer.mcp-servers", { "/cached": [server("claude.ai Slack")] });
    let resolve!: (value: McpServer[]) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const discovery = loadMcpServers("/cached");
    await vi.waitFor(() =>
      expect(useCoWriterStore.getState().servers["/cached"]).toEqual([server("claude.ai Slack")]),
    );
    resolve(servers);
    await discovery;
    expect(useCoWriterStore.getState().servers["/cached"]).toBe(servers);
    await vi.waitFor(() =>
      expect(data.get("co-writer.mcp-servers")).toEqual({ "/cached": servers }),
    );
    expect(loadMcpServers("/cached")).toBe(discovery);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("marks servers unavailable when Claude Code can't list them and nothing is cached", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValue(new Error("Not logged in"));
    await expect(loadMcpServers("/fail")).rejects.toThrow("Not logged in");
    await vi.waitFor(() =>
      expect(useCoWriterStore.getState().servers["/fail"]).toBe("unavailable"),
    );
    expect(error).toHaveBeenCalledWith("[co-writer] Could not list MCP servers", expect.any(Error));
    error.mockRestore();
  });
});
