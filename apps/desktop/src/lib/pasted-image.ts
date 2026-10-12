const MAX_IMAGE_SIZE_MB = 5;
const MAX_IMAGE_SIZE = MAX_IMAGE_SIZE_MB * 1024 * 1024;

export function pastedImageFile(data: DataTransfer | null): File | null {
  for (const item of data?.items ?? []) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

export type PastedImage =
  | { ok: true; imageData: number[]; format: string }
  | { ok: false; error: string };

export async function readPastedImage(file: File): Promise<PastedImage> {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_IMAGE_SIZE) {
    const sizeMb = (buffer.byteLength / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      error: `Image not pasted: ${sizeMb} MB is over the ${MAX_IMAGE_SIZE_MB} MB limit`,
    };
  }
  return {
    ok: true,
    imageData: Array.from(new Uint8Array(buffer)),
    format: file.type.split("/")[1] || "png",
  };
}
