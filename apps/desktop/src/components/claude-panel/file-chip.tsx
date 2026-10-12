import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, File01Icon, Image01Icon, Pdf01Icon } from "@hugeicons/core-free-icons";
import { openLinkedFile } from "@/hooks/editor-api";
import { getFileExtension, getFileName } from "@/lib/paths";
import { useWorkspaceStore } from "@/stores/workspace-store";

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function FileIcon({ path }: { path: string }) {
  const extension = getFileExtension(path).toLowerCase();
  const [broken, setBroken] = useState(false);
  if (IMAGE.has(extension) && !broken)
    return (
      <img
        src={convertFileSrc(path)}
        alt=""
        onError={() => setBroken(true)}
        className="size-4 shrink-0 rounded-[3px] object-cover"
      />
    );
  return (
    <HugeiconsIcon
      icon={IMAGE.has(extension) ? Image01Icon : extension === "pdf" ? Pdf01Icon : File01Icon}
      size={12}
      strokeWidth={1.8}
      className="shrink-0"
    />
  );
}

/** A file attached to a message; removable while still in the composer. */
export function FileChip({ path, onRemove }: { path: string; onRemove?: () => void }) {
  const root = useWorkspaceStore((s) => s.root);
  const name = getFileName(path);
  const opens =
    !onRemove && !!root && path.startsWith(`${root}/`) && /\.(md|markdown)$/i.test(path);
  return (
    <span
      title={path}
      className={`chat-enter inline-flex h-[22px] max-w-full items-center gap-1 rounded-md bg-[var(--surface-subtle)] pl-[5px] text-[11.5px] text-[var(--text-secondary)] [[data-theme=dark]_&]:bg-[var(--surface-subtle-strong)] ${
        onRemove ? "pr-[3px]" : "pr-[7px]"
      }`}
    >
      <FileIcon path={path} />
      {opens ? (
        <button
          type="button"
          onClick={() => void openLinkedFile(path)}
          className="truncate hover:text-[var(--text-primary)]"
        >
          {name}
        </button>
      ) : (
        <span className="truncate">{name}</span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
          className="grid size-4 shrink-0 place-items-center rounded text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
        </button>
      )}
    </span>
  );
}
