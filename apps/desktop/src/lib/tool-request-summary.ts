import { getFileName, getParentDir } from "./paths";

export interface ToolRequestSummary {
  verb: string;
  target: string;
  where: string | null;
  allowLabel: string;
}

function stringInput(input: Record<string, unknown>, key: string) {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Names a directory from the workspace folder down, or absolutely when it is outside. */
function displayDir(dir: string, root: string | null) {
  const normalized = dir.replace(/\\/g, "/").replace(/(.)\/$/, "$1");
  if (!root) return normalized;
  const normalizedRoot = root.replace(/\\/g, "/").replace(/(.)\/$/, "$1");
  const rootName = getFileName(normalizedRoot);
  if (normalized === normalizedRoot) return rootName;
  if (normalized.startsWith(`${normalizedRoot}/`))
    return `${rootName}/${normalized.slice(normalizedRoot.length + 1)}`;
  return normalized;
}

export function summarizeToolRequest(
  tool: string,
  input: Record<string, unknown>,
  root: string | null,
  target?: { path: string; exists: boolean },
): ToolRequestSummary {
  if (target && (tool === "Edit" || tool === "Write")) {
    const [verb, allowLabel] =
      tool === "Edit"
        ? ["Edit", "Yes, edit it"]
        : target.exists
          ? ["Replace", "Yes, replace it"]
          : ["Create", "Yes, create it"];
    return {
      verb,
      target: getFileName(target.path),
      where: displayDir(getParentDir(target.path), root),
      allowLabel,
    };
  }
  const path = stringInput(input, "path");
  const where = path && displayDir(path, root);
  const filePath = stringInput(input, "file_path");
  const pattern = stringInput(input, "pattern");
  if (tool === "Read" && filePath)
    return {
      verb: "Read",
      target: getFileName(filePath),
      where: displayDir(getParentDir(filePath), root),
      allowLabel: "Yes, read it",
    };
  if (tool === "Grep" && pattern)
    return { verb: "Search for", target: `“${pattern}”`, where, allowLabel: "Yes, search" };
  if (tool === "Glob" && pattern)
    return { verb: "Find files matching", target: pattern, where, allowLabel: "Yes, find them" };
  const preview = Object.values(input).find(
    (value): value is string => typeof value === "string" && !!value.trim(),
  );
  return { verb: "Use", target: tool, where: preview ?? null, allowLabel: "Allow" };
}

const ALWAYS_ACTIONS: Record<string, string> = {
  Read: "read files",
  Grep: "search files",
  Glob: "find files",
  Edit: "edit other notes",
  Write: "create or replace other notes",
  WebSearch: "search the web",
  WebFetch: "fetch web pages",
};

/** Labels the option that allows every later request for this tool in the chat. */
export function alwaysAllowLabel(tool: string) {
  return `Yes, and don't ask again to ${ALWAYS_ACTIONS[tool] ?? `use ${tool}`}`;
}

export const BUILT_IN_SOURCE = "Co-writer";

const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);
const SMALL_WORDS = new Set(["in", "of", "for", "and", "on"]);

/** "claude_ai_Google_Drive" → "Google Drive", "plugin_acme_wiki" → "Wiki". */
function serverName(server: string) {
  const bare = server.replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "") || server;
  return bare
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word, i) =>
      i > 0 && SMALL_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : capitalize(word),
    )
    .join(" ");
}

export interface AllowedTool {
  tool: string;
  source: string;
  name: string;
}

/** Names a tool saved with "don't ask again", and where it comes from, as listed in Settings. */
export function describeAllowedTool(tool: string): AllowedTool {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp)
    return {
      tool,
      source: serverName(mcp[1]),
      name: capitalize(mcp[2].replace(/_mcp$/, "").replace(/_/g, " ")),
    };
  const action = ALWAYS_ACTIONS[tool];
  return { tool, source: BUILT_IN_SOURCE, name: action ? capitalize(action) : tool };
}

/** Groups allowed tools by source: built-in tools first, then servers in the order they appear. */
export function groupAllowedTools(tools: string[]) {
  const groups = new Map<string, AllowedTool[]>([[BUILT_IN_SOURCE, []]]);
  for (const tool of tools) {
    const described = describeAllowedTool(tool);
    const group = groups.get(described.source);
    if (group) group.push(described);
    else groups.set(described.source, [described]);
  }
  return [...groups]
    .filter(([, items]) => items.length > 0)
    .map(([source, items]) => ({ source, tools: items }));
}
