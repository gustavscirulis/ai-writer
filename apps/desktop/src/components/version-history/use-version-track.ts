import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Focuses the version track whenever the dock opens, including a reopen while
 * it is still exiting, and reports the track's width in pixels.
 */
export function useVersionTrack(open: boolean) {
  const [width, setWidth] = useState(0);
  const element = useRef<HTMLElement | null>(null);
  const ref = useCallback((track: HTMLElement | null) => {
    if (!track) return;
    element.current = track;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(track);
    return () => {
      observer.disconnect();
      element.current = null;
    };
  }, []);
  const focus = useCallback(() => element.current?.focus({ preventScroll: true }), []);
  useEffect(() => {
    if (open) focus();
  }, [open, focus]);
  return { ref, width, focus };
}
