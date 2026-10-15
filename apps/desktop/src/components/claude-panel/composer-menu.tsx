import type { ReactNode } from "react";

export const menuOptionId = (menuId: string, index: number) => `${menuId}-${index}`;

const keepVisible = (row: HTMLDivElement | null) => row?.scrollIntoView({ block: "nearest" });

/** A listbox above the composer; the textarea keeps focus and drives the keys. */
export function ComposerMenu<T>({
  id,
  label,
  items,
  itemKey,
  active,
  onActive,
  onPick,
  children,
}: {
  id: string;
  label: string;
  items: T[];
  itemKey: (item: T) => string;
  active: number;
  onActive: (index: number) => void;
  onPick: (item: T) => void;
  children: (item: T) => ReactNode;
}) {
  return (
    <div className="surface-card surface-card-opaque absolute inset-x-0 bottom-full z-20 mb-1.5 overflow-hidden">
      <div
        id={id}
        role="listbox"
        aria-label={label}
        className="max-h-[264px] overflow-y-auto p-1.5"
      >
        {items.map((item, index) => (
          <div
            key={itemKey(item)}
            id={menuOptionId(id, index)}
            ref={index === active ? keepVisible : undefined}
            role="option"
            aria-selected={index === active}
            onPointerMove={() => index !== active && onActive(index)}
            // Picking on pointerdown keeps focus in the textarea instead of racing a blur.
            onPointerDown={(event) => {
              event.preventDefault();
              onPick(item);
            }}
            className="flex cursor-default flex-col gap-px rounded-[10px] px-2.5 py-1.5 aria-selected:bg-[var(--surface-subtle)]"
          >
            {children(item)}
          </div>
        ))}
      </div>
    </div>
  );
}
