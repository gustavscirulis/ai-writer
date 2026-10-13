import { create } from "zustand";
import type { Capabilities } from "@/lib/co-writer-skills";
import { readPreferenceStrict, writePreferenceStrict } from "@/lib/preferences";
import * as tauri from "@/lib/tauri";

export type CapabilityList = Capabilities | "unavailable";

interface CoWriterState {
  /** Per workspace root, absent until the cache or Claude Code reports them. */
  capabilities: Record<string, CapabilityList>;
}

export const useCoWriterStore = create<CoWriterState>(() => ({ capabilities: {} }));

const CAPABILITIES_KEY = "co-writer.capabilities";

const setCapabilities = (root: string, capabilities: CapabilityList) =>
  useCoWriterStore.setState((state) => ({
    capabilities: { ...state.capabilities, [root]: capabilities },
  }));

type CapabilityCache = Record<string, Capabilities>;
const noCache = (): CapabilityCache => ({});
let cache: Promise<CapabilityCache> | null = null;
const readCache = () =>
  (cache ??= readPreferenceStrict<CapabilityCache>(CAPABILITIES_KEY).then(
    (stored) => stored ?? {},
  ));
function writeCache(root: string, capabilities: Capabilities) {
  cache = readCache()
    .catch(noCache)
    .then(async (stored) => {
      const next = { ...stored, [root]: capabilities };
      await writePreferenceStrict(CAPABILITIES_KEY, next).catch((error) =>
        console.error("[co-writer] Could not cache MCP servers and skills", error),
      );
      return next;
    });
}

const discoveries = new Map<string, Promise<Capabilities>>();
/** Shows the cached MCP servers and skills at once and refreshes them from Claude Code once per launch. */
export function loadCapabilities(root: string) {
  let discovery = discoveries.get(root);
  if (discovery) return discovery;
  const cached = readCache().then(
    (stored) => {
      if (stored[root] && !useCoWriterStore.getState().capabilities[root])
        setCapabilities(root, stored[root]);
    },
    (error) => console.error("[co-writer] Could not read cached MCP servers and skills", error),
  );
  discovery = tauri.claudeCapabilities(root).then((capabilities) => {
    setCapabilities(root, capabilities);
    writeCache(root, capabilities);
    return capabilities;
  });
  discovery.catch(async (error) => {
    console.error("[co-writer] Could not list MCP servers and skills", error);
    await cached;
    if (!useCoWriterStore.getState().capabilities[root]) setCapabilities(root, "unavailable");
  });
  discoveries.set(root, discovery);
  return discovery;
}

/** Skills known for the workspace; empty until Claude Code or the cache reports them. */
export function skillsFor(root: string | null) {
  const capabilities = root ? useCoWriterStore.getState().capabilities[root] : undefined;
  return capabilities && capabilities !== "unavailable" ? capabilities.skills : [];
}
