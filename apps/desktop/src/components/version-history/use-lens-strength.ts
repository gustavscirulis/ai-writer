import { useEffect, useRef, useState } from "react";

const GROW_MS = 340;
const SHRINK_MS = 420;

/** Starts and lands softly, so the lens swells rather than pops. */
const easeInOut = (t: number) => (1 - Math.cos(Math.PI * t)) / 2;

/**
 * Lens strength from 0 to 1: grows while the pointer is over the track and
 * settles back after it leaves, picking up from wherever it was.
 */
export function useLensStrength(active: boolean) {
  const [strength, setStrength] = useState(0);
  const current = useRef(0);

  useEffect(() => {
    const from = current.current;
    const to = active ? 1 : 0;
    if (from === to) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = reduced ? 0 : (active ? GROW_MS : SHRINK_MS) * Math.abs(to - from);
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = duration ? Math.min(1, (now - start) / duration) : 1;
      current.current = from + (to - from) * easeInOut(t);
      setStrength(current.current);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return strength;
}
