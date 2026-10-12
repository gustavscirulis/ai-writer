import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { flushSync } from "react-dom";
import type { Tab } from "@/hooks/use-tabs";
import { suppressNextClick } from "@/lib/suppress-next-click";
import { dropIndexFor, shiftFor, type TabSlot } from "./tab-reorder";

const DRAG_THRESHOLD_PX = 4;
const AUTO_SCROLL_EDGE_PX = 28;
const AUTO_SCROLL_SPEED_PX = 8;
const SHIFT_TRANSITION = "transform 150ms ease";

interface PendingTabDrag {
  pointerId: number;
  tabId: string;
  startX: number;
  startScrollLeft: number;
  strip: HTMLElement;
  elements: HTMLElement[];
  slots: TabSlot[];
  fromIndex: number;
  toIndex: number;
  /** Space a neighbour moves aside by: the dragged tab's width plus the strip gap. */
  distance: number;
  reduceMotion: boolean;
  started: boolean;
  cancelled: boolean;
}

function clearInlineMotion(el: HTMLElement) {
  el.style.transform = "";
  el.style.transition = "";
}

function animateToRest(el: HTMLElement, reduceMotion: boolean) {
  if (reduceMotion || !el.style.transform) {
    clearInlineMotion(el);
    return;
  }
  el.style.transition = SHIFT_TRANSITION;
  el.style.transform = "";
  el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
}

/**
 * Pointer-based drag-to-reorder for the editor tab strip (HTML5 DnD is
 * suppressed by Tauri's OS drag-drop; see use-tree-drag.ts). Positions are
 * applied imperatively per frame; the store only changes on drop.
 */
export function useTabDrag(tabs: Tab[], moveTab: (tabId: string, toIndex: number) => void) {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const pendingRef = useRef<PendingTabDrag | null>(null);
  const pointerXRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const moveTabRef = useRef(moveTab);
  moveTabRef.current = moveTab;

  const layout = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending || !pending.started || pending.cancelled) return;
    const { strip, slots, fromIndex, elements } = pending;
    const dragged = slots[fromIndex]!;
    const last = slots[slots.length - 1]!;
    const minDx = slots[0]!.left - dragged.left;
    const maxDx = last.left + last.width - dragged.width - dragged.left;
    const rawDx = pointerXRef.current - pending.startX + strip.scrollLeft - pending.startScrollLeft;
    const dx = Math.max(minDx, Math.min(maxDx, rawDx));

    pending.toIndex = dropIndexFor(slots, fromIndex, dragged.left + dx);
    elements.forEach((el, index) => {
      if (index === fromIndex) {
        el.style.transform = `translateX(${dx}px)`;
        return;
      }
      const shift = shiftFor(index, fromIndex, pending.toIndex, pending.distance);
      el.style.transform = shift ? `translateX(${shift}px)` : "";
    });
  }, []);

  const tick = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const rect = pending.strip.getBoundingClientRect();
    const x = pointerXRef.current;
    if (x < rect.left + AUTO_SCROLL_EDGE_PX) pending.strip.scrollLeft -= AUTO_SCROLL_SPEED_PX;
    else if (x > rect.right - AUTO_SCROLL_EDGE_PX) pending.strip.scrollLeft += AUTO_SCROLL_SPEED_PX;
    layout();
    rafRef.current = requestAnimationFrame(tick);
  }, [layout]);

  const stopTracking = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    document.body.classList.remove("tab-dragging");
  }, []);

  const revert = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pending.cancelled = true;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    for (const el of pending.elements) animateToRest(el, pending.reduceMotion);
  }, []);

  const endDrag = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    stopTracking();
    if (pending?.started) {
      for (const el of pending.elements) clearInlineMotion(el);
      setDraggingTabId(null);
    }
  }, [stopTracking]);

  const commit = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const { elements, fromIndex, toIndex, tabId, reduceMotion } = pending;
    const draggedEl = elements[fromIndex]!;
    const droppedLeft = draggedEl.getBoundingClientRect().left;

    pendingRef.current = null;
    stopTracking();
    for (const el of elements) clearInlineMotion(el);
    flushSync(() => {
      setDraggingTabId(null);
      moveTabRef.current(tabId, toIndex);
    });

    // FLIP: start the dropped tab where it was released and let it settle into its slot.
    const offset = droppedLeft - draggedEl.getBoundingClientRect().left;
    if (reduceMotion || offset === 0) return;
    draggedEl.style.transform = `translateX(${offset}px)`;
    void draggedEl.offsetWidth;
    animateToRest(draggedEl, false);
  }, [stopTracking]);

  const handleEnd = useCallback(
    (event: globalThis.PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      if (!pending.started) {
        endDrag();
        return;
      }
      suppressNextClick();
      if (event.type !== "pointercancel" && !pending.cancelled) {
        commit();
        return;
      }
      if (!pending.cancelled) revert();
      pendingRef.current = null;
      stopTracking();
      setDraggingTabId(null);
    },
    [commit, endDrag, revert, stopTracking],
  );

  const handleMove = useCallback(
    (event: globalThis.PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      // A release outside the window never delivers pointerup.
      if (event.buttons === 0) {
        handleEnd(event);
        return;
      }
      pointerXRef.current = event.clientX;
      if (pending.cancelled) return;

      if (!pending.started) {
        if (Math.abs(event.clientX - pending.startX) < DRAG_THRESHOLD_PX) return;
        pending.started = true;
        pending.elements.forEach((el, index) => {
          el.style.transition =
            index === pending.fromIndex || pending.reduceMotion ? "none" : SHIFT_TRANSITION;
        });
        document.body.classList.add("tab-dragging");
        setDraggingTabId(pending.tabId);
        rafRef.current = requestAnimationFrame(tick);
      }
      layout();
    },
    [handleEnd, layout, tick],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const pending = pendingRef.current;
      if (event.key !== "Escape" || !pending?.started || pending.cancelled) return;
      event.preventDefault();
      event.stopPropagation();
      revert();
      document.body.classList.remove("tab-dragging");
      setDraggingTabId(null);
    },
    [revert],
  );

  const beginDrag = useCallback(
    (event: PointerEvent<HTMLElement>, tabId: string) => {
      if (event.button !== 0 || pendingRef.current) return;
      if ((event.target as HTMLElement).closest("button")) return;
      const strip = event.currentTarget.closest<HTMLElement>("[data-tab-strip]");
      if (!strip) return;
      const elements = [...strip.querySelectorAll<HTMLElement>("[data-tab-id]")];
      const fromIndex = elements.findIndex((el) => el.dataset.tabId === tabId);
      if (fromIndex === -1) return;

      for (const el of elements) clearInlineMotion(el);
      const stripLeft = strip.getBoundingClientRect().left - strip.scrollLeft;
      const slots = elements.map((el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left - stripLeft, width: rect.width };
      });
      const dragged = slots[fromIndex]!;
      const neighbour = slots[fromIndex + 1] ?? slots[fromIndex - 1];
      const gap = neighbour
        ? neighbour.left > dragged.left
          ? neighbour.left - (dragged.left + dragged.width)
          : dragged.left - (neighbour.left + neighbour.width)
        : 0;

      pendingRef.current = {
        pointerId: event.pointerId,
        tabId,
        startX: event.clientX,
        startScrollLeft: strip.scrollLeft,
        strip,
        elements,
        slots,
        fromIndex,
        toIndex: fromIndex,
        distance: dragged.width + gap,
        reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        started: false,
        cancelled: false,
      };
      pointerXRef.current = event.clientX;

      const controller = new AbortController();
      abortRef.current = controller;
      window.addEventListener("pointermove", handleMove, { signal: controller.signal });
      window.addEventListener("pointerup", handleEnd, { signal: controller.signal });
      window.addEventListener("pointercancel", handleEnd, { signal: controller.signal });
      window.addEventListener("keydown", handleKeyDown, {
        signal: controller.signal,
        capture: true,
      });
    },
    [handleEnd, handleKeyDown, handleMove],
  );

  // Measured slots go stale if a tab opens or closes mid-drag, so abandon the gesture.
  useEffect(() => {
    if (pendingRef.current?.started && !pendingRef.current.cancelled) revert();
  }, [tabs, revert]);

  useEffect(() => endDrag, [endDrag]);

  return { draggingTabId, beginDrag };
}
