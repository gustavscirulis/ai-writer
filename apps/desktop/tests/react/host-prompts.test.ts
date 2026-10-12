import { expect, test, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

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
    'aria-label="Claude&#x27;s question"',
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
