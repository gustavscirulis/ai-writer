import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Follow content growth only while the reader is at the bottom, until a message is sent. A sent
 * message (`anchorId`) is scrolled to the top and held there while the reply streams in below it.
 */
export function useConversationScroll(anchorId: string | undefined) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  const anchor = useRef<HTMLElement | null>(null);
  const seenAnchorId = useRef(anchorId);

  const update = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const target = anchor.current;
    if (!target) {
      if (following.current) element.scrollTop = element.scrollHeight;
      return;
    }
    const style = getComputedStyle(element);
    const room =
      element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const contents = element.firstElementChild as HTMLElement;
    const used = contents.offsetTop + contents.offsetHeight - target.offsetTop;
    if (spacerRef.current) spacerRef.current.style.height = `${Math.max(0, room - used)}px`;
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
    anchor.current = target;
    update();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollTo({
      top: target.offsetTop - parseFloat(getComputedStyle(element).paddingTop),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [anchorId, update]);

  return { scrollRef, spacerRef };
}
