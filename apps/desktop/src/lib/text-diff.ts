/** One replacement that preserves the unchanged prefix/suffix and selection mapping. */
export function textDiff(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > from && endAfter > from && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return { from, to: endBefore, insert: after.slice(from, endAfter) };
}
