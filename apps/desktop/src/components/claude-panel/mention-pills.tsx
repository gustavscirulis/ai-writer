import { openLinkedFile } from "@/hooks/editor-api";
import { mentionRanges, splitMentions, type Mention, type MentionRange } from "@/lib/mentions";

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
  return (
    <div
      aria-hidden="true"
      className={`${COMPOSER_TEXT} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-transparent`}
    >
      <div style={{ transform: `translateY(${-scrollTop}px)` }}>
        {splitMentions(text, pills).map((part) =>
          part.path === null ? (
            part.text
          ) : (
            <span key={part.from} data-mention-pill className={PILL}>
              {part.text}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/** A sent message's text with its mentions as pills that open the note. */
export function MentionText({ text, mentions }: { text: string; mentions: Mention[] }) {
  return splitMentions(text, mentionRanges(text, mentions)).map((part) =>
    part.path === null ? (
      part.text
    ) : (
      <button
        key={part.from}
        type="button"
        data-mention-pill
        title={part.path}
        onClick={() => void openLinkedFile(part.path!)}
        className={`${PILL} inline cursor-pointer text-left transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)]`}
      >
        {part.text}
      </button>
    ),
  );
}
