import { useCallback, useState } from "react";

/**
 * Keeps an element mounted after `open` turns false, until it calls
 * `onExited` at the end of its exit transition.
 */
export function usePresence(open: boolean) {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const onExited = useCallback(() => setPresent(false), []);
  return { present: open || present, onExited };
}
