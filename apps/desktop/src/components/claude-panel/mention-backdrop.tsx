import type { MentionRange } from "@/lib/mentions";

/** Shared by the textarea and its backdrop so both wrap the draft the same way. */
export const COMPOSER_TEXT = "text-[13.5px] leading-[1.55]";

const PILL =
  "rounded-[5px] bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_16%,transparent)] box-decoration-clone";

/** Draws mention pills behind the textarea's own text, since a textarea can't style a range. */
export function MentionBackdrop({
  text,
  pills,
  scrollTop,
}: {
  text: string;
  pills: MentionRange[];
  scrollTop: number;
}) {
  if (!pills.length) return null;
  const parts = [];
  let at = 0;
  for (const pill of pills) {
    parts.push(text.slice(at, pill.from));
    parts.push(
      <span key={pill.from} data-mention-pill className={PILL}>
        {text.slice(pill.from, pill.to)}
      </span>,
    );
    at = pill.to;
  }
  parts.push(text.slice(at));
  return (
    <div
      aria-hidden="true"
      className={`${COMPOSER_TEXT} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent`}
    >
      <div style={{ transform: `translateY(${-scrollTop}px)` }}>{parts}</div>
    </div>
  );
}
