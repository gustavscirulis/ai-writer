import {
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import { isAgentEditing, subscribeAgentEditing } from "@/lib/agent-turn";
import { textDiff } from "@/lib/text-diff";
import type { EditorView } from "@codemirror/view";

export const agentFrontmatter = StateEffect.define<string | null>();
export const agentFrontmatterField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(agentFrontmatter)) value = effect.value;
    return value;
  },
});

export function agentEditingExtensions(
  frontmatter: string | null,
  compartment: Compartment,
  path: () => string,
): Extension {
  return [
    agentFrontmatterField.init(() => frontmatter),
    invertedEffects.of((tr) =>
      tr.effects.some((e) => e.is(agentFrontmatter))
        ? [agentFrontmatter.of(tr.startState.field(agentFrontmatterField))]
        : [],
    ),
    compartment.of(EditorState.readOnly.of(isAgentEditing(path()))),
    // readOnly alone does not reject explicit dispatches by widgets or menus.
    EditorState.transactionFilter.of((tr) =>
      isAgentEditing(path()) &&
      (tr.docChanged || tr.effects.some((e) => e.is(agentFrontmatter))) &&
      !tr.isUserEvent("writer")
        ? []
        : tr,
    ),
  ];
}
export function watchAgentEditing(view: EditorView, compartment: Compartment, path: () => string) {
  view.dispatch({
    effects: compartment.reconfigure(EditorState.readOnly.of(isAgentEditing(path()))),
  });
  return subscribeAgentEditing(() =>
    view.dispatch({
      effects: compartment.reconfigure(EditorState.readOnly.of(isAgentEditing(path()))),
    }),
  );
}
export function agentReloadTransaction(before: string, after: string, frontmatter: string | null) {
  return {
    changes: textDiff(before, after),
    effects: agentFrontmatter.of(frontmatter),
    annotations: [Transaction.addToHistory.of(true), isolateHistory.of("full")],
    userEvent: "writer.agent-reload",
  };
}
