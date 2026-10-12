export interface TabSlot {
  left: number;
  width: number;
}

function midpoint(slot: TabSlot) {
  return slot.left + slot.width / 2;
}

/**
 * Index the dragged tab would take if dropped with its left edge at
 * `draggedLeft`. It passes a neighbour once its leading edge crosses that
 * neighbour's midpoint; the leading edge, not the centre, so a tab wider than
 * the end tab can still pass it while clamped to the strip.
 */
export function dropIndexFor(slots: TabSlot[], fromIndex: number, draggedLeft: number): number {
  const dragged = slots[fromIndex];
  if (!dragged) return fromIndex;
  const right = draggedLeft + dragged.width;
  let index = fromIndex;
  for (let i = fromIndex + 1; i < slots.length && right > midpoint(slots[i]!); i += 1) {
    index = i;
  }
  if (index !== fromIndex) return index;
  for (let i = fromIndex - 1; i >= 0 && draggedLeft < midpoint(slots[i]!); i -= 1) {
    index = i;
  }
  return index;
}

/** Horizontal offset for a non-dragged tab while the dragged one hovers at `toIndex`. */
export function shiftFor(index: number, fromIndex: number, toIndex: number, distance: number) {
  if (fromIndex < toIndex && index > fromIndex && index <= toIndex) return -distance;
  if (toIndex < fromIndex && index >= toIndex && index < fromIndex) return distance;
  return 0;
}
