import { create } from "zustand";
import type { McpServer } from "@/lib/co-writer-suggestions";
import { readPreferenceStrict, writePreferenceStrict } from "@/lib/preferences";
import * as tauri from "@/lib/tauri";

export type McpServerList = McpServer[] | "unavailable";

interface CoWriterState {
  /** Per workspace root, absent until the cache or Claude Code reports them. */
  servers: Record<string, McpServerList>;
}

export const useCoWriterStore = create<CoWriterState>(() => ({ servers: {} }));

const SERVERS_KEY = "co-writer.mcp-servers";

const setServers = (root: string, servers: McpServerList) =>
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
  const cached = readCache().then(
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
  discovery.catch(async (error) => {
    console.error("[co-writer] Could not list MCP servers", error);
    await cached;
    if (!useCoWriterStore.getState().servers[root]) setServers(root, "unavailable");
  });
  discoveries.set(root, discovery);
  return discovery;
}
