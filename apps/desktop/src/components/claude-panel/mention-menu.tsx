import { getFileStem } from "@/lib/paths";
import type { SearchResult } from "@/types/fs";
import { ComposerMenu } from "./composer-menu";

export const MENTION_MENU_ID = "co-writer-mentions";

/** Notes matching what follows `@` in the composer. */
export function MentionMenu({
  files,
  active,
  onActive,
  onPick,
}: {
  files: SearchResult[];
  active: number;
  onActive: (index: number) => void;
  onPick: (file: SearchResult) => void;
}) {
  return (
    <ComposerMenu
      id={MENTION_MENU_ID}
      label="Files"
      items={files}
      itemKey={(file) => file.path}
      active={active}
      onActive={onActive}
      onPick={onPick}
    >
      {(file) => {
        const slash = file.relative_path.lastIndexOf("/");
        return (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-[13px] text-[var(--text-primary)]">
              {getFileStem(file.filename)}
            </span>
            {slash > 0 && (
              <span className="truncate text-[11.5px] text-[var(--text-muted)]">
                {file.relative_path.slice(0, slash)}
              </span>
            )}
          </span>
        );
      }}
    </ComposerMenu>
  );
}
