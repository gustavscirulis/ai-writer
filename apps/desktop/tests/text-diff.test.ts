import { expect, test } from "vite-plus/test";
import { textDiff } from "../src/lib/text-diff";
for (const [before, after] of [
  ["", "text"],
  ["text", ""],
  ["abc", "abc"],
  ["one two three", "one new three"],
  ["abc", "xbc"],
  ["🙂 note", "🙃 note"],
  ["a\nb", "a\nchanged\nb"],
]) {
  test(`minimal replacement: ${JSON.stringify(before)} → ${JSON.stringify(after)}`, () => {
    const diff = textDiff(before, after);
    expect(before.slice(0, diff.from) + diff.insert + before.slice(diff.to)).toBe(after);
    if (before === "one two three") expect(diff).toEqual({ from: 4, to: 7, insert: "new" });
  });
}
