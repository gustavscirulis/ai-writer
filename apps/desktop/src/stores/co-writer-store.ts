import { create } from "zustand";
import type { AgentProvider } from "@/lib/agent-providers";
import type { Capabilities } from "@/lib/co-writer-skills";
import { readPreferenceStrict, writePreferenceStrict } from "@/lib/preferences";

export type CapabilityList = Capabilities | "unavailable";

interface CoWriterState {
  /** Per agent and workspace root (see `capabilityKey`), absent until the cache or the agent reports them. */
  capabilities: Record<string, CapabilityList>;
}

/** Each agent has its own models, skills and MCP servers for a workspace. */
export const capabilityKey = (agent: AgentProvider, root: string) => `${agent.id}\0${root}`;

export const useCoWriterStore = create<CoWriterState>(() => ({ capabilities: {} }));

const CAPABILITIES_KEY = "co-writer.capabilities";

const setCapabilities = (key: string, capabilities: CapabilityList) =>
  useCoWriterStore.setState((state) => ({
    capabilities: { ...state.capabilities, [key]: capabilities },
  }));

type CapabilityCache = Record<string, Capabilities>;
const noCache = (): CapabilityCache => ({});
let cache: Promise<CapabilityCache> | null = null;
const readCache = () =>
  (cache ??= readPreferenceStrict<CapabilityCache>(CAPABILITIES_KEY).then(
    (stored) => stored ?? {},
  ));
function writeCache(key: string, capabilities: Capabilities) {
  cache = readCache()
    .catch(noCache)
    .then(async (stored) => {
      const next = { ...stored, [key]: capabilities };
      await writePreferenceStrict(CAPABILITIES_KEY, next).catch((error) =>
        console.error("[co-writer] Could not cache MCP servers and skills", error),
      );
      return next;
    });
}

const discoveries = new Map<string, Promise<Capabilities>>();
/** Shows the cached MCP servers and skills at once and refreshes them from the agent once per launch. */
export function loadCapabilities(agent: AgentProvider, root: string) {
  const key = capabilityKey(agent, root);
  let discovery = discoveries.get(key);
  if (discovery) return discovery;
  const cached = readCache().then(
    (stored) => {
      if (stored[key] && !useCoWriterStore.getState().capabilities[key])
        setCapabilities(key, stored[key]);
    },
    (error) => console.error("[co-writer] Could not read cached MCP servers and skills", error),
  );
  discovery = agent.capabilities(root).then((capabilities) => {
    setCapabilities(key, capabilities);
    writeCache(key, capabilities);
    return capabilities;
  });
  discovery.catch(async (error) => {
    console.error("[co-writer] Could not list MCP servers and skills", error);
    await cached;
    if (!useCoWriterStore.getState().capabilities[key]) setCapabilities(key, "unavailable");
  });
  discoveries.set(key, discovery);
  return discovery;
}

/** The agent's skills for the workspace; empty until the agent or the cache reports them. */
export function skillsFor(agent: AgentProvider, root: string | null) {
  const capabilities = root
    ? useCoWriterStore.getState().capabilities[capabilityKey(agent, root)]
    : undefined;
  return capabilities && capabilities !== "unavailable" ? capabilities.skills : [];
}
