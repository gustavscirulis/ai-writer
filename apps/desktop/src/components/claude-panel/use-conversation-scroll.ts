import { useCallback, useRef } from "react";

/** Follow content growth only while the reader is at the bottom. */
export function useConversationScroll() {
  const following = useRef(true);
  const ref = useCallback((scroller: HTMLDivElement | null) => {
    if (!scroller) return;
    const contents = scroller.firstElementChild;
    if (!contents) return;
    const onScroll = () => {
      following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    };
    const observer = new ResizeObserver(() => {
      if (following.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(contents);
    observer.observe(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, []);
  return ref;
}
