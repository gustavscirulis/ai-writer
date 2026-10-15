import { expect, test, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

import { PlanPrompt } from "../../src/components/claude-panel/plan-prompt";
import { QuestionPrompt } from "../../src/components/claude-panel/question-prompt";

test("a question shows its header, options with descriptions, a free answer and its position", () => {
  const html = renderToStaticMarkup(
    createElement(QuestionPrompt, {
      path: "/notes/a.md",
      queued: 1,
      request: {
        id: "ask",
        tool: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which sections should stay?",
              header: "Sections",
              multiSelect: true,
              options: [
                { label: "Arrival", description: "The first evening" },
                { label: "Soup", description: "" },
              ],
            },
            { question: "Which tone?", header: "Tone", multiSelect: false, options: [] },
          ],
        },
      },
    }),
  );
  for (const text of [
    'aria-label="Co-writer&#x27;s question"',
    "Sections",
    "1 of 2",
    "Which sections should stay?",
    "Choose any that apply.",
    "Arrival",
    "The first evening",
    'aria-pressed="false"',
    "Type your own answer…",
    "Next question",
    "Don&#x27;t answer",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("Back");
});

test("a plan shows its markdown and asks before Claude starts writing", () => {
  const html = renderToStaticMarkup(
    createElement(PlanPrompt, {
      path: "/notes/a.md",
      queued: 1,
      request: {
        id: "plan",
        tool: "ExitPlanMode",
        input: { plan: "## Steps\n\n1. Merge the **intro**", planFilePath: "/p/a.md" },
      },
    }),
  );
  for (const text of [
    'aria-label="Plan approval"',
    "Ready to start writing?",
    "<strong>intro</strong>",
    "Yes, start writing",
    "No, keep planning",
  ])
    expect(html).toContain(text);
});
