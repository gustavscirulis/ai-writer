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
