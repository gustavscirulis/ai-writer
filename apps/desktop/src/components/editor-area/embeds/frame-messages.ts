// The postMessage contract with `src-tauri/src/embed-frame.html`.

export const MIN_FRAME_HEIGHT = 40;
export const MAX_FRAME_HEIGHT = 2000;

export type FrameMessage =
  | { type: "ready" }
  | { type: "escape" }
  | { type: "height"; height: number }
  | { type: "error"; message: string };

/** Embed code runs in the frame and can post anything, so only the known
 *  shapes get through. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.source !== "writer-embed") return null;
  switch (message.type) {
    case "ready":
      return { type: "ready" };
    case "escape":
      return { type: "escape" };
    case "height":
      return typeof message.height === "number" && Number.isFinite(message.height)
        ? { type: "height", height: message.height }
        : null;
    case "error":
      return typeof message.message === "string"
        ? { type: "error", message: message.message.slice(0, 500) }
        : null;
    default:
      return null;
  }
}

export function clampFrameHeight(height: number): number {
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(height)));
}

export function renderMessage(html: string) {
  return { source: "writer-embed", type: "render", html };
}
