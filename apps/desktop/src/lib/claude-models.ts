/** A model Claude Code offers, such as `opus` resolving to Opus 5.5. */
export interface ClaudeModel {
  value: string;
  displayName: string;
  resolvedModel: string;
}

/** Optional because capabilities cached by earlier versions lack them. */
export interface ModelInfo {
  models?: ClaudeModel[];
  /** The model Claude Code runs when Co-writer passes no `--model`. */
  cliModel?: string | null;
}

const LONG_CONTEXT = "[1m]";

function modelName(id: string, models: ClaudeModel[]): string {
  const known = models.find(
    (model) => model.value !== "default" && (model.value === id || model.resolvedModel === id),
  );
  if (known) return known.displayName;
  if (id.endsWith(LONG_CONTEXT))
    return `${modelName(id.slice(0, -LONG_CONTEXT.length), models)} (1M context)`;
  return id;
}

/** Label for a `co-writer.model` option, naming the version it runs when Claude Code has reported it. */
export function modelOptionLabel(option: string, info: ModelInfo | null): string {
  const models = info?.models ?? [];
  if (option === "default") {
    const configured = info?.cliModel && info.cliModel !== "default" ? info.cliModel : null;
    const id = configured ?? models.find((model) => model.value === "default")?.resolvedModel;
    return id ? `Default · ${modelName(id, models)}` : "Default";
  }
  return (
    models.find((model) => model.value === option)?.displayName ??
    option.charAt(0).toUpperCase() + option.slice(1)
  );
}
