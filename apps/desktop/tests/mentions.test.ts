import { expect, test } from "vite-plus/test";
import { insertMention, mentionQuery } from "../src/lib/mentions";

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

test("a mention replaces only the query and leaves the caret after one space", () => {
  expect(insertMention("match @sty", { query: "sty", from: 6, to: 10 }, "Style guide")).toEqual({
    text: "match @Style guide ",
    caret: 19,
  });
  expect(insertMention("@sty please", { query: "sty", from: 0, to: 4 }, "Style guide")).toEqual({
    text: "@Style guide please",
    caret: 13,
  });
  expect(insertMention("@x,", { query: "x", from: 0, to: 2 }, "Notes/Plan")).toEqual({
    text: "@Notes/Plan ,",
    caret: 12,
  });
});
