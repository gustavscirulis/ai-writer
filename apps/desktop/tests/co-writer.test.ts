import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
vi.mock("@/lib/theme", () => ({ applyTheme: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const data = vi.hoisted(() => new Map<string, unknown>());
vi.mock("@/lib/preferences", () => ({
  getPreference: vi.fn(async () => null),
  setPreference: vi.fn(async () => {}),
  readPreferenceStrict: vi.fn(async (key: string) => data.get(key)),
  writePreferenceStrict: vi.fn(async (key: string, value: unknown) => {
    data.set(key, structuredClone(value));
  }),
}));
import { invoke } from "@tauri-apps/api/core";
import {
  connectedServers,
  displayName,
  fallbackSuggestions,
  parseSuggestions,
  serversFootnote,
  suggestionPrompt,
  type McpServer,
} from "../src/lib/co-writer-suggestions";
import {
  loadMcpServers,
  requestSuggestions,
  useCoWriterStore,
} from "../src/stores/co-writer-store";
import { useEditorStore, type OpenFile } from "../src/stores/editor-store";

const server = (name: string, status = "connected", tools: string[] = []): McpServer => ({
  name,
  status,
  tools,
});
const servers = [
  server("plugin:base:glean", "connected", ["search", "chat"]),
  server("claude.ai Gmail", "needs-auth"),
  server("plugin:analytics-tools:snowflake", "connected", ["sql_exec_tool"]),
  server("plugin:productivity:google calendar"),
  server("plugin:design:google calendar"),
  server("claude.ai Slack"),
];
const NOTE = "# Fin pricing\n\nToday Fin is $0.99 per resolution. Customers asked for a flat fee.";

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

  test("falls back to the writer's best tools, then the web", () => {
    expect(fallbackSuggestions(servers).map((s) => s.tool)).toEqual(["Glean", "Snowflake", "web"]);
    expect(fallbackSuggestions(null).map((s) => s.tool)).toEqual(["web", "web", "workspace"]);
  });

  test("footnote names the connected tools it knows", () => {
    expect(serversFootnote(servers)).toBe(
      "Uses your Claude Code, with web search and its 4 MCP servers, including Glean and Snowflake.",
    );
    expect(serversFootnote([server("claude.ai Slack")])).toBe(
      "Uses your Claude Code, with web search and its Slack MCP server.",
    );
    expect(serversFootnote([])).toMatch(/^Uses your Claude Code and web search\. Add MCP/);
    expect(serversFootnote(null)).toBe(
      "Uses your Claude Code, with web search and its MCP servers.",
    );
  });

  test("prompt lists connected tools and bounds the note", () => {
    const prompt = suggestionPrompt("pricing.md", "x".repeat(7000), servers);
    expect(prompt).toContain("- Glean: search, chat\n- Snowflake: sql_exec_tool\n");
    expect(prompt).not.toContain("Gmail");
    expect(prompt).toContain("Note path: pricing.md\n<note>\n");
    expect(prompt).toContain("[…note continues]");
    expect(prompt.length).toBeLessThan(6400);
  });

  test("parses suggestions and drops tools Co-writer lacks", () => {
    const text =
      'Here you go:\n```json\n[{"label": "Pull resolutions from snowflake.", "tool": "snowflake"},' +
      '{"label": "Search Gmail for requests", "tool": "Gmail"},' +
      '{"label": "Look up Zendesk pricing", "tool": "web"},' +
      '{"label": "Look up Zendesk pricing", "tool": "web"}, {"tool": "web"}]\n```';
    expect(parseSuggestions(text, servers)).toEqual([
      { label: "Pull resolutions from snowflake", tool: "Snowflake" },
      { label: "Look up Zendesk pricing", tool: "web" },
    ]);
    expect(() => parseSuggestions('[{"label": "Only one", "tool": "web"}]', servers)).toThrow();
    expect(() => parseSuggestions("Sorry, I can't help", servers)).toThrow();
  });
});

describe("co-writer store", () => {
  const open = (path: string, content = NOTE) =>
    useEditorStore.setState({
      openFiles: new Map([[path, { path, content, isLoading: false } as OpenFile]]),
    });
  const reply = JSON.stringify([
    { label: "Pull resolution share from Snowflake", tool: "Snowflake" },
    { label: "Look up Zendesk pricing", tool: "web" },
  ]);

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

  test("writes suggestions for a note once, with its servers and relative path", async () => {
    const path = "/vault/strategy/pricing.md";
    open(path);
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "claude_mcp_servers" ? servers : reply,
    );
    requestSuggestions("/vault", path);
    await vi.waitFor(() =>
      expect(useCoWriterStore.getState().suggestions[path]).toEqual([
        { label: "Pull resolution share from Snowflake", tool: "Snowflake" },
        { label: "Look up Zendesk pricing", tool: "web" },
      ]),
    );
    const call = vi.mocked(invoke).mock.calls.find(([command]) => command === "claude_suggest");
    expect(call?.[1]).toMatchObject({
      root: "/vault",
      prompt: expect.stringContaining("Note path: strategy/pricing.md"),
    });
    requestSuggestions("/vault", path);
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "claude_suggest")).toHaveLength(1);
  });

  test("runs one generation at a time and only the latest waiting note", async () => {
    const [a, b, c] = ["/queue/a.md", "/queue/b.md", "/queue/c.md"];
    useEditorStore.setState({
      openFiles: new Map(
        [a, b, c].map((path) => [path, { path, content: NOTE, isLoading: false } as OpenFile]),
      ),
    });
    const prompts: string[] = [];
    let finish!: () => void;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "claude_mcp_servers") return servers;
      prompts.push((args as { prompt: string }).prompt);
      if (prompts.length === 1) await new Promise<void>((r) => (finish = r));
      return reply;
    });
    requestSuggestions("/queue", a);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    requestSuggestions("/queue", b);
    requestSuggestions("/queue", c);
    finish();
    await vi.waitFor(() => expect(useCoWriterStore.getState().suggestions[c]).toBeDefined());
    expect(prompts.map((prompt) => prompt.match(/Note path: (\S+)/)?.[1])).toEqual([
      "a.md",
      "c.md",
    ]);
    expect(useCoWriterStore.getState().suggestions[b]).toBeUndefined();
  });

  test("skips short notes and logs failures without retrying", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    open("/short/a.md", "Hi");
    requestSuggestions("/short", "/short/a.md");
    expect(invoke).not.toHaveBeenCalled();

    open("/fail/a.md");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "claude_mcp_servers") return [];
      throw new Error("Not logged in");
    });
    requestSuggestions("/fail", "/fail/a.md");
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "[co-writer] Could not suggest prompts",
        expect.any(Error),
      ),
    );
    requestSuggestions("/fail", "/fail/a.md");
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "claude_suggest")).toHaveLength(1);
    expect(useCoWriterStore.getState().suggestions["/fail/a.md"]).toBeUndefined();
    error.mockRestore();
  });
});
