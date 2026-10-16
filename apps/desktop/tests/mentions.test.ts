import { expect, test } from "vite-plus/test";
import {
  deleteMention,
  insertToken,
  mentionQuery,
  mentionRanges,
  snapOutOfMention,
} from "../src/lib/mentions";

test("the menu opens for an @ word at the caret that starts the draft or follows whitespace", () => {
  expect(mentionQuery("@", 1)).toEqual({ query: "", from: 0, to: 1 });
  expect(mentionQuery("match @sty", 10)).toEqual({ query: "sty", from: 6, to: 10 });
  expect(mentionQuery("a\n@sty", 6)).toEqual({ query: "sty", from: 2, to: 6 });
  expect(mentionQuery("match @sty and more", 10)).toEqual({ query: "sty", from: 6, to: 10 });
  expect(mentionQuery("me@example.com", 14)).toBeNull();
  expect(mentionQuery("@sty ", 5)).toBeNull();
  expect(mentionQuery("@@", 2)).toBeNull();
  expect(mentionQuery("match @sty", 3)).toBeNull();
});

test("a picked token replaces only the query and leaves the caret after one space", () => {
  expect(insertToken("match @sty", { query: "sty", from: 6, to: 10 }, "@Style guide")).toEqual({
    text: "match @Style guide ",
    caret: 19,
  });
  expect(insertToken("@sty please", { query: "sty", from: 0, to: 4 }, "@Style guide")).toEqual({
    text: "@Style guide please",
    caret: 13,
  });
  expect(insertToken("@x,", { query: "x", from: 0, to: 2 }, "@Notes/Plan")).toEqual({
    text: "@Notes/Plan ,",
    caret: 12,
  });
  expect(insertToken("tighten /ux this", { query: "ux", from: 8, to: 11 }, "/ux-copy")).toEqual({
    text: "tighten /ux-copy this",
    caret: 17,
  });
});

test("pills are whole-word @labels, and the longer label wins where two overlap", () => {
  const plan = { path: "/plan.md", label: "Plan" };
  const planV2 = { path: "/plan-v2.md", label: "Plan v2" };
  expect(mentionRanges("@Plan v2 and @Plan, not x@Plan or @Planned", [plan, planV2])).toEqual([
    { from: 0, to: 8, path: "/plan-v2.md" },
    { from: 13, to: 18, path: "/plan.md" },
  ]);
  const plans = [plan, planV2, { path: "/plan-v2-final.md", label: "Plan v2 final" }];
  expect(mentionRanges("@Plan v2 final", plans)).toEqual([
    { from: 0, to: 14, path: "/plan-v2-final.md" },
  ]);
});

test("Backspace or Delete at a pill removes all of it, and the caret can't stop inside one", () => {
  const text = "see @Style guide now";
  const pills = [{ from: 4, to: 16, path: "/style.md" }];
  expect(deleteMention(text, pills, 16, "Backspace")).toEqual({ text: "see  now", caret: 4 });
  expect(deleteMention(text, pills, 4, "Backspace")).toBeNull();
  expect(deleteMention(text, pills, 4, "Delete")).toEqual({ text: "see  now", caret: 4 });
  expect(deleteMention(text, pills, 16, "Delete")).toBeNull();
  expect(snapOutOfMention(pills, 15, 16)).toBe(4);
  expect(snapOutOfMention(pills, 5, 4)).toBe(16);
  expect(snapOutOfMention(pills, 6, 0)).toBe(4);
  expect(snapOutOfMention(pills, 14, 0)).toBe(16);
  expect(snapOutOfMention(pills, 2, 0)).toBe(2);
});
