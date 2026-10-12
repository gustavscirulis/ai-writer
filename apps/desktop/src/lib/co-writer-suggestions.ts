import {
  Book02Icon,
  ChartBarLineIcon,
  File02Icon,
  Globe02Icon,
  Notebook01Icon,
  Plug01Icon,
  QuillWrite01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

export interface McpServer {
  name: string;
  status: string;
}
/** `tool` is "web", "workspace", "draft", or an MCP server's display name. A starter fills the
 * composer for the writer to finish instead of sending. */
export interface Suggestion {
  label: string;
  tool: string;
  starter?: boolean;
}

// Ordered by how useful the tool is to a writer; the first matches fill the slots.
const KNOWN: {
  match: RegExp;
  name: string;
  icon: IconSvgElement;
  label: string;
  starter: string;
}[] = [
  {
    match: /(^|:)glean$/i,
    name: "Glean",
    icon: Search01Icon,
    label: "Research this topic in Glean",
    starter: "Brief me from Glean on…",
  },
  {
    match: /(^|:)snowflake$/i,
    name: "Snowflake",
    icon: ChartBarLineIcon,
    label: "Check the numbers in Snowflake",
    starter: "Pull the numbers from Snowflake on…",
  },
  {
    match: /google drive$/i,
    name: "Google Drive",
    icon: File02Icon,
    label: "Find related docs in Google Drive",
    starter: "Start from a Google Drive doc about…",
  },
  {
    match: /(^|[\s:])notion$/i,
    name: "Notion",
    icon: Book02Icon,
    label: "Find related pages in Notion",
    starter: "Start from a Notion page about…",
  },
  {
    match: /(^|[\s:])coda$/i,
    name: "Coda",
    icon: Book02Icon,
    label: "Find related pages in Coda",
    starter: "Start from a Coda doc about…",
  },
];

const BUILT_IN: Suggestion[] = [
  { label: "Find recent sources on the web", tool: "web" },
  { label: "Fact-check claims on the web", tool: "web" },
  { label: "Find related notes in your workspace", tool: "workspace" },
];

const NEW_NOTE: Suggestion[] = [
  { label: "Find recent sources on…", tool: "web", starter: true },
  { label: "Pull together my notes on…", tool: "workspace", starter: true },
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

/** An outline, up to two connected tools, then the web and workspace, all as starters. */
export function newNoteSuggestions(servers: McpServer[] | null): Suggestion[] {
  const known = knownConnected(servers ?? [])
    .slice(0, 2)
    .map((entry) => ({ label: entry.starter, tool: entry.name, starter: true }));
  const outline = { label: "Draft an outline about…", tool: "draft", starter: true };
  return [outline, ...known, ...NEW_NOTE].slice(0, 4);
}

/** Text a starter leaves in the composer, ready for the writer to finish. */
export const starterText = (label: string) => `${label.replace(/…$/, "")} `;

/** Empty, or only headings, so there's nothing yet to research or edit. */
export const isBlankNote = (content: string) => !content.replace(/^#.*$/gm, "").trim();

export function suggestionIcon(tool: string) {
  if (tool === "web") return Globe02Icon;
  if (tool === "draft") return QuillWrite01Icon;
  if (tool === "workspace") return Notebook01Icon;
  return KNOWN.find((entry) => entry.name === tool)?.icon ?? Plug01Icon;
}

/** `null` servers means Claude Code couldn't report them. */
export function serversFootnote(servers: McpServer[] | null) {
  return servers && !connectedServers(servers).length
    ? "Runs on your Claude Code, with the same tools."
    : "Runs on your Claude Code, with the same tools and MCPs.";
}
