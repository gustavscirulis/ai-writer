import { describe, expect, test } from "vite-plus/test";
import { modelOptionLabel, type ClaudeModel } from "../src/lib/claude-models";

const models: ClaudeModel[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5" },
];

describe("model option labels", () => {
  test("name the version each alias runs", () => {
    const label = (option: string) => modelOptionLabel(option, { models, cliModel: null });
    expect(["fable", "opus", "sonnet", "haiku"].map(label)).toEqual([
      "Fable 5.1",
      "Opus 5.5",
      "Sonnet 5.5",
      "Haiku 5.5",
    ]);
  });

  test("default names the model the CLI is configured to run", () => {
    expect(modelOptionLabel("default", { models, cliModel: "claude-opus-5-5[1m]" })).toBe(
      "Default · Opus 5.5 (1M context)",
    );
    expect(modelOptionLabel("default", { models, cliModel: "sonnet" })).toBe(
      "Default · Sonnet 5.5",
    );
    expect(modelOptionLabel("default", { models, cliModel: "claude-opus-9" })).toBe(
      "Default · claude-opus-9",
    );
  });

  test("default falls back to Claude Code's recommended model when none is configured", () => {
    expect(modelOptionLabel("default", { models, cliModel: null })).toBe("Default · Opus 5.5");
    expect(modelOptionLabel("default", { models, cliModel: "default" })).toBe("Default · Opus 5.5");
  });

  test("plain names until Claude Code reports its models", () => {
    expect(modelOptionLabel("default", null)).toBe("Default");
    expect(modelOptionLabel("opus", null)).toBe("Opus");
    expect(modelOptionLabel("haiku", {})).toBe("Haiku");
  });
});
