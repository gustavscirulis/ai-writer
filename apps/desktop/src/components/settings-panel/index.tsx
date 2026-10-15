import { useMemo, type ReactNode } from "react";
import { useAllSettings, useResetSetting, useSetSetting } from "@/hooks/use-settings";
import { SETTINGS_SCHEMA, type SettingDef } from "@/lib/settings-schema";
import { SettingControl } from "./setting-control";
import { ThemesSection } from "./themes-section";
import { ALLOWED_TOOLS_KEY, AllowedToolsRows, CO_WRITER_CATEGORY } from "./co-writer-section";
import { useAgent, useModels } from "@/hooks/use-co-writer";
import { AGENT_KEY, AGENTS, isAgentId } from "@/lib/agent-providers";
import { EditorScrollContainer } from "@/components/editor-area/editor-scroll-container";

/** Section that renders above the Themes block. The schema-driven section
 *  list is rendered in two passes — these come first, the Themes section
 *  comes next, and everything else is rendered after. */
const SECTIONS_BEFORE_THEMES = ["Appearance", "Typography"] as const;

const AGENT_MODEL_KEYS = new Set<string>(Object.values(AGENTS).map((agent) => agent.modelKey));
const agentLabel = (option: string) => (isAgentId(option) ? AGENTS[option].label : option);

export function SettingsPanel({ isActive }: { isActive: boolean }) {
  const settings = useAllSettings();
  const setSetting = useSetSetting();
  const resetSetting = useResetSetting();
  const agent = useAgent();
  const models = useModels(isActive);

  const categories = useMemo(() => {
    const map = new Map<string, SettingDef[]>();
    for (const def of SETTINGS_SCHEMA) {
      // Theme settings are owned by ThemesSection; keep them out of the generic renderer.
      if (def.category === "Theme") continue;
      // Native code owns this list; AllowedToolsRows only lists and revokes entries.
      if (def.key === ALLOWED_TOOLS_KEY) continue;
      // Panel open state, toggled with ⌘⇧L; Co-writer itself can't be turned off.
      if (def.key === "appearance.agent-panel-visible") continue;
      if (AGENT_MODEL_KEYS.has(def.key) && def.key !== agent.modelKey) continue;
      const existing = map.get(def.category) ?? [];
      existing.push(def);
      map.set(def.category, existing);
    }
    return map;
  }, [agent.modelKey]);

  function isModified(def: SettingDef): boolean {
    return JSON.stringify(settings[def.key]) !== JSON.stringify(def.default);
  }

  function optionLabel(def: SettingDef) {
    if (def.key === AGENT_KEY) return agentLabel;
    return def.key === agent.modelKey ? models.label : undefined;
  }

  /** Codex models aren't known until Codex reports them, so the schema stores a plain string. */
  function withOptions(def: SettingDef): SettingDef {
    if (def.key !== AGENTS.codex.modelKey) return def;
    const value = settings[def.key];
    const options = ["default", ...models.models.map((model) => model.value)];
    if (typeof value === "string" && !options.includes(value)) options.push(value);
    return { ...def, type: "enum", options };
  }

  function renderSection(category: string, defs: SettingDef[], extra?: ReactNode) {
    return (
      <section key={category} className="mb-10">
        <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">{category}</h2>
        <div className="-mx-4 overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
          {defs.map((def, i) => (
            <div
              key={def.key}
              className={i === 0 ? undefined : "border-t border-[var(--line-subtler)]"}
            >
              <SettingControl
                def={withOptions(def)}
                value={settings[def.key]}
                onChange={(value) => setSetting(def.key, value)}
                onReset={() => void resetSetting(def.key)}
                isModified={isModified(def)}
                optionLabel={optionLabel(def)}
              />
            </div>
          ))}
          {extra}
        </div>
      </section>
    );
  }

  const beforeThemes: [string, SettingDef[]][] = [];
  for (const cat of SECTIONS_BEFORE_THEMES) {
    const defs = categories.get(cat);
    if (defs) beforeThemes.push([cat, defs]);
  }

  const beforeThemesSet = new Set<string>(SECTIONS_BEFORE_THEMES);
  const afterThemes = Array.from(categories.entries()).filter(([cat]) => !beforeThemesSet.has(cat));

  return (
    <div
      data-settings-panel
      className={
        isActive ? "relative z-10 h-full" : "absolute inset-0 invisible pointer-events-none h-full"
      }
      aria-hidden={!isActive}
    >
      <EditorScrollContainer>
        <div className="mx-auto max-w-2xl px-8 pt-32 pb-24 md:pt-[9rem]">
          <h1 className="mb-10 text-2xl font-semibold text-[var(--text-primary)]">Preferences</h1>

          {beforeThemes.map(([cat, defs]) => renderSection(cat, defs))}

          <ThemesSection />

          {afterThemes.map(([cat, defs]) =>
            renderSection(
              cat,
              defs,
              cat === CO_WRITER_CATEGORY && <AllowedToolsRows isActive={isActive} />,
            ),
          )}
        </div>
      </EditorScrollContainer>
    </div>
  );
}
