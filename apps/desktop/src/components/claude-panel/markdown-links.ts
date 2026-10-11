import { openUrl } from "@tauri-apps/plugin-opener";

/** Keep web/email links and local footnote fragments; never navigate the app webview. */
export function replyUrl(value: string, key?: string): string {
  if (key !== "src" && value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.href;
    if (key !== "src" && url.protocol === "mailto:") return url.href;
  } catch {
    // Relative destinations have no meaning in a chat reply.
  }
  return "";
}

/** Return an error for the link's inline alert instead of rejecting the event handler. */
export async function openReplyLink(
  event: { preventDefault: () => void },
  href: string,
): Promise<string | null> {
  const url = replyUrl(href);
  if (url.startsWith("#")) return null;
  event.preventDefault();
  if (!url) return null;
  try {
    await openUrl(url);
    return null;
  } catch (error) {
    return `Could not open link: ${error instanceof Error ? error.message : String(error)}`;
  }
}
