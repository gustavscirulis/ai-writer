import { create } from "zustand";
import { documentPath } from "@/lib/agent-turn";
import {
  SUGGESTION_SYSTEM_PROMPT,
  parseSuggestions,
  suggestionPrompt,
  type McpServer,
  type Suggestion,
} from "@/lib/co-writer-suggestions";
import { getRelativePath } from "@/lib/paths";
import { readPreferenceStrict, writePreferenceStrict } from "@/lib/preferences";
import * as tauri from "@/lib/tauri";
import { useEditorStore, type OpenFile } from "@/stores/editor-store";

interface CoWriterState {
  /** Per workspace root, absent until the cache or Claude Code reports them. */
  servers: Record<string, McpServer[]>;
  /** Per canonical note, generated at most once per launch. */
  suggestions: Record<string, Suggestion[]>;
}

export const useCoWriterStore = create<CoWriterState>(() => ({ servers: {}, suggestions: {} }));

const SERVERS_KEY = "co-writer.mcp-servers";
const MIN_NOTE_LENGTH = 80;

const setServers = (root: string, servers: McpServer[]) =>
  useCoWriterStore.setState((state) => ({ servers: { ...state.servers, [root]: servers } }));

type ServerCache = Record<string, McpServer[]>;
const noCache = (): ServerCache => ({});
let cache: Promise<ServerCache> | null = null;
const readCache = () =>
  (cache ??= readPreferenceStrict<ServerCache>(SERVERS_KEY).then((stored) => stored ?? {}));
function writeCache(root: string, servers: McpServer[]) {
  cache = readCache()
    .catch(noCache)
    .then(async (stored) => {
      const next = { ...stored, [root]: servers };
      await writePreferenceStrict(SERVERS_KEY, next).catch((error) =>
        console.error("[co-writer] Could not cache MCP servers", error),
      );
      return next;
    });
}

const discoveries = new Map<string, Promise<McpServer[]>>();
/** Shows the cached list at once and refreshes it from Claude Code once per launch. */
export function loadMcpServers(root: string) {
  let discovery = discoveries.get(root);
  if (discovery) return discovery;
  readCache().then(
    (stored) => {
      if (stored[root] && !useCoWriterStore.getState().servers[root])
        setServers(root, stored[root]);
    },
    (error) => console.error("[co-writer] Could not read cached MCP servers", error),
  );
  discovery = tauri.claudeMcpServers(root).then((servers) => {
    setServers(root, servers);
    writeCache(root, servers);
    return servers;
  });
  discovery.catch((error) => console.error("[co-writer] Could not list MCP servers", error));
  discoveries.set(root, discovery);
  return discovery;
}

async function serversFor(root: string) {
  const discovery = loadMcpServers(root);
  const known =
    useCoWriterStore.getState().servers[root] ?? (await readCache().catch(noCache))[root];
  return known ?? (await discovery.catch(() => []));
}

export function canSuggestFor(file: OpenFile | undefined) {
  return !!file && !file.isLoading && file.content.trim().length >= MIN_NOTE_LENGTH;
}

const attempted = new Set<string>();
let wanted: { root: string; path: string } | null = null;
let running = false;

/** One generation at a time; only the latest request waits behind it. */
export function requestSuggestions(root: string, path: string) {
  if (attempted.has(documentPath(path))) return;
  wanted = { root, path };
  if (!running) void drain();
}

async function drain() {
  running = true;
  while (wanted) {
    const { root, path } = wanted;
    wanted = null;
    const key = documentPath(path);
    const file = useEditorStore.getState().openFiles.get(path);
    if (attempted.has(key) || !file || !canSuggestFor(file)) continue;
    attempted.add(key);
    try {
      const servers = await serversFor(root);
      const prompt = suggestionPrompt(getRelativePath(key, root), file.content, servers);
      const suggestions = parseSuggestions(
        await tauri.claudeSuggest(root, SUGGESTION_SYSTEM_PROMPT, prompt),
        servers,
      );
      useCoWriterStore.setState((state) => ({
        suggestions: { ...state.suggestions, [key]: suggestions },
      }));
    } catch (error) {
      console.error("[co-writer] Could not suggest prompts", error);
    }
  }
  running = false;
}
