import { describe, expect, test } from "vite-plus/test";
import { dropIndexFor, shiftFor } from "../src/components/editor-area/tab-reorder";

// Three tabs of widths 100, 60, 140 with a 4px gap.
const slots = [
  { left: 0, width: 100 },
  { left: 104, width: 60 },
  { left: 168, width: 140 },
];

describe("dropIndexFor", () => {
  test("moving right, passes a neighbour once the right edge crosses its midpoint", () => {
    // Tab 1 midpoint is 134, tab 2 midpoint is 238.
    expect(dropIndexFor(slots, 0, 0)).toBe(0);
    expect(dropIndexFor(slots, 0, 34)).toBe(0);
    expect(dropIndexFor(slots, 0, 35)).toBe(1);
    expect(dropIndexFor(slots, 0, 138)).toBe(1);
    expect(dropIndexFor(slots, 0, 139)).toBe(2);
  });

  test("moving left, passes a neighbour once the left edge crosses its midpoint", () => {
    // Tab 1 midpoint is 134, tab 0 midpoint is 50.
    expect(dropIndexFor(slots, 2, 134)).toBe(2);
    expect(dropIndexFor(slots, 2, 133)).toBe(1);
    expect(dropIndexFor(slots, 2, 49)).toBe(0);
  });

  test("a tab wider than the end tab still reaches the end when clamped", () => {
    // Tab 2 (140px) dragged to the strip start: left edge 0 is past tab 0's midpoint.
    expect(dropIndexFor(slots, 2, 0)).toBe(0);
    // Tab 0 (100px) moved over a narrower last tab: clamped left = 308 - 100.
    const narrowLast = [...slots.slice(0, 2), { left: 168, width: 40 }];
    expect(dropIndexFor(narrowLast, 0, 108)).toBe(2);
  });

  test("returns the original index for an unknown slot", () => {
    expect(dropIndexFor(slots, 5, 0)).toBe(5);
  });
});

describe("shiftFor", () => {
  test("tabs between from and to make room in the opposite direction", () => {
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2, 104))).toEqual([0, -104, -104, 0]);
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1, 64))).toEqual([0, 64, 64, 0]);
  });

  test("nothing shifts when the tab is over its own slot", () => {
    expect([0, 1, 2].map((i) => shiftFor(i, 1, 1, 64))).toEqual([0, 0, 0]);
  });
});
