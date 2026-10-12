import {
  Book02Icon,
  ChartBarLineIcon,
  File02Icon,
  Globe02Icon,
  Notebook01Icon,
  Plug01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

export interface McpServer {
  name: string;
  status: string;
}
/** `tool` is "web", "workspace", or an MCP server's display name. */
export interface Suggestion {
  label: string;
  tool: string;
}

// Ordered by how useful the tool is to a writer; the first matches fill the slots.
const KNOWN: { match: RegExp; name: string; icon: IconSvgElement; label: string }[] = [
  {
    match: /(^|:)glean$/i,
    name: "Glean",
    icon: Search01Icon,
    label: "Research this topic in Glean",
  },
  {
    match: /(^|:)snowflake$/i,
    name: "Snowflake",
    icon: ChartBarLineIcon,
    label: "Check the numbers in Snowflake",
  },
  {
    match: /google drive$/i,
    name: "Google Drive",
    icon: File02Icon,
    label: "Find related docs in Google Drive",
  },
  {
    match: /(^|[\s:])notion$/i,
    name: "Notion",
    icon: Book02Icon,
    label: "Find related pages in Notion",
  },
  { match: /(^|[\s:])coda$/i, name: "Coda", icon: Book02Icon, label: "Find related pages in Coda" },
];

const BUILT_IN: Suggestion[] = [
  { label: "Find recent sources on the web", tool: "web" },
  { label: "Fact-check claims on the web", tool: "web" },
  { label: "Find related notes in your workspace", tool: "workspace" },
];

export function displayName(server: string) {
  const known = KNOWN.find((entry) => entry.match.test(server));
  if (known) return known.name;
  const name = server.replace(/^plugin:[^:]+:/, "").replace(/^claude\.ai /, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Connected servers, one per display name, in the order Claude Code lists them. */
export function connectedServers(servers: McpServer[]) {
  const seen = new Set<string>();
  return servers.filter((server) => {
    const name = displayName(server.name).toLowerCase();
    if (server.status !== "connected" || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function knownConnected(servers: McpServer[]) {
  const connected = connectedServers(servers);
  return KNOWN.filter((entry) => connected.some((server) => entry.match.test(server.name)));
}

/** Up to three of the writer's best connected tools, filled to four with built-in ones. */
export function toolSuggestions(servers: McpServer[] | null): Suggestion[] {
  const known = knownConnected(servers ?? [])
    .slice(0, 3)
    .map((entry) => ({ label: entry.label, tool: entry.name }));
  return [...known, ...BUILT_IN].slice(0, 4);
}

export function suggestionIcon(tool: string) {
  if (tool === "web") return Globe02Icon;
  if (tool === "workspace") return Notebook01Icon;
  return KNOWN.find((entry) => entry.name === tool)?.icon ?? Plug01Icon;
}

function list(names: string[]) {
  return names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : names[0];
}

/** `null` servers means Claude Code couldn't report them. */
export function serversFootnote(servers: McpServer[] | null) {
  if (!servers) return "Uses your Claude Code, with web search and its MCP servers.";
  const connected = connectedServers(servers);
  if (!connected.length)
    return "Uses your Claude Code and web search. Add MCP servers in Claude Code to bring in more tools.";
  const known = knownConnected(servers).map((entry) => entry.name);
  const named = (known.length ? known : connected.map((server) => displayName(server.name))).slice(
    0,
    3,
  );
  if (connected.length === 1)
    return `Uses your Claude Code, with web search and its ${named[0]} MCP server.`;
  return `Uses your Claude Code, with web search and its ${connected.length} MCP servers, including ${list(named)}.`;
}
