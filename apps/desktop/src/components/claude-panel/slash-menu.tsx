import type { Skill } from "@/lib/co-writer-skills";
import { ComposerMenu } from "./composer-menu";

export const SLASH_MENU_ID = "co-writer-skills";

/** Skills matching what follows `/` in the composer. */
export function SlashMenu({
  skills,
  active,
  onActive,
  onPick,
}: {
  skills: Skill[];
  active: number;
  onActive: (index: number) => void;
  onPick: (skill: Skill) => void;
}) {
  return (
    <ComposerMenu
      id={SLASH_MENU_ID}
      label="Skills"
      items={skills}
      itemKey={(skill) => skill.name}
      active={active}
      onActive={onActive}
      onPick={onPick}
    >
      {(skill) => (
        <>
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-[13px] text-[var(--text-primary)]">/{skill.name}</span>
            {skill.argumentHint && (
              <span className="truncate text-[11.5px] text-[var(--text-muted)]">
                {skill.argumentHint}
              </span>
            )}
          </span>
          {skill.description && (
            <span className="truncate text-[11.5px] leading-snug text-[var(--text-muted)]">
              {skill.description}
            </span>
          )}
        </>
      )}
    </ComposerMenu>
  );
}
