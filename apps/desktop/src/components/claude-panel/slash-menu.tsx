import type { Skill } from "@/lib/co-writer-skills";

export const SLASH_MENU_ID = "co-writer-skills";
export const skillOptionId = (index: number) => `${SLASH_MENU_ID}-${index}`;

const keepVisible = (row: HTMLDivElement | null) => row?.scrollIntoView({ block: "nearest" });

/** Skills matching what follows `/` in the composer; the textarea keeps focus and drives the keys. */
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
    <div className="surface-card surface-card-opaque absolute inset-x-0 bottom-full z-20 mb-1.5 overflow-hidden">
      <div
        id={SLASH_MENU_ID}
        role="listbox"
        aria-label="Skills"
        className="max-h-[264px] overflow-y-auto p-1.5"
      >
        {skills.map((skill, index) => (
          <div
            key={skill.name}
            id={skillOptionId(index)}
            ref={index === active ? keepVisible : undefined}
            role="option"
            aria-selected={index === active}
            onPointerMove={() => index !== active && onActive(index)}
            // Picking on pointerdown keeps focus in the textarea instead of racing a blur.
            onPointerDown={(event) => {
              event.preventDefault();
              onPick(skill);
            }}
            className="flex cursor-default flex-col gap-px rounded-[10px] px-2.5 py-1.5 aria-selected:bg-[var(--surface-subtle)]"
          >
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
          </div>
        ))}
      </div>
    </div>
  );
}
