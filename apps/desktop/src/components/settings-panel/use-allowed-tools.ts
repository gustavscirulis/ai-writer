import { useCallback, useEffect, useRef, useState } from "react";
import * as tauri from "@/lib/tauri";

/** Native code owns the list, so it is reloaded whenever Settings is shown or the
 *  window regains focus (another window may have added a tool). */
export function useAllowedTools(isActive: boolean) {
  const [tools, setTools] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const run = useCallback((load: () => Promise<string[]>) => {
    const id = ++latest.current;
    load().then(
      (next) => {
        if (id !== latest.current) return;
        setTools(next);
        setError(null);
      },
      (reason: unknown) => {
        if (id === latest.current) setError(String(reason));
      },
    );
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const refresh = () => run(tauri.coWriterAllowedTools);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [isActive, run]);

  const revoke = useCallback((tool: string) => run(() => tauri.revokeCoWriterTool(tool)), [run]);
  return { tools, error, revoke };
}
