import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Follow content growth only while the reader is at the bottom, until a message is sent. A sent
 * message (`anchorId`) is scrolled to the top and held there while the reply streams in below it.
 */
export function useConversationScroll(anchorId: string | undefined) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const anchorTop = useRef<number | null>(null);
  const seenAnchorId = useRef(anchorId);
  const slide = useRef<Animation[]>([]);

  const update = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    if (anchorTop.current === null) {
      if (following.current) element.scrollTop = element.scrollHeight;
      return;
    }
    // Size from content height only: WebKit misreports descendant offsets mid-slide.
    const style = getComputedStyle(element);
    const contents = element.firstElementChild as HTMLElement;
    const bottom =
      parseFloat(style.paddingTop) + contents.offsetHeight + parseFloat(style.paddingBottom);
    const height = Math.max(0, anchorTop.current + element.clientHeight - bottom);
    if (spacerRef.current) spacerRef.current.style.height = `${height}px`;
  }, []);

  const scrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      scroller.current = element;
      const contents = element?.firstElementChild;
      if (!element || !contents) return;
      const onScroll = () => {
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      };
      const observer = new ResizeObserver(update);
      observer.observe(contents);
      observer.observe(element);
      element.addEventListener("scroll", onScroll, { passive: true });
      return () => {
        observer.disconnect();
        element.removeEventListener("scroll", onScroll);
        scroller.current = null;
      };
    },
    [update],
  );

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!anchorId || anchorId === seenAnchorId.current || !element) return;
    seenAnchorId.current = anchorId;
    const target = element.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(anchorId)}"]`,
    );
    if (!target) return;
    const top = target.offsetTop - parseFloat(getComputedStyle(element).paddingTop);
    anchorTop.current = top;
    update();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.scrollTop = top;
      return;
    }
    // Native smooth scroll drops frames while the reply starts rendering; a transform doesn't.
    const layers = [element.firstElementChild, spacerRef.current] as HTMLElement[];
    const transform = getComputedStyle(layers[0]).transform;
    const offset = transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
    for (const animation of slide.current) animation.cancel();
    const from = element.scrollTop - offset;
    element.scrollTop = top;
    const travel = element.scrollTop - from;
    if (!travel) return;
    const distance = Math.sign(travel) * Math.min(Math.abs(travel), element.clientHeight);
    target.dataset.pinned = "";
    slide.current = layers.map((layer) =>
      layer.animate([{ transform: `translateY(${distance}px)` }, { transform: "translateY(0)" }], {
        duration: 240,
        easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      }),
    );
  }, [anchorId, update]);

  return { scrollRef, spacerRef };
}
