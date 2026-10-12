import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import * as editorApi from "@/hooks/editor-api";
import { parseDocument, parseFrontmatter } from "@/lib/frontmatter";
import { formatMarkdownDestination } from "@/lib/paths";
import { pastedImageFile, readPastedImage } from "@/lib/pasted-image";
import * as tauri from "@/lib/tauri";
import { showEditorNotice } from "./editor-notice-store";

async function handleImagePaste(
  file: File,
  view: EditorView,
  filePath: string,
  isDisposed: () => boolean,
) {
  const image = await readPastedImage(file);
  if (isDisposed()) return;
  if (!image.ok) {
    showEditorNotice(image.error);
    return;
  }

  const result = await tauri.saveClipboardImage(filePath, image.imageData, image.format);
  if (isDisposed()) return;
  const imageMarkdown = `![${file.name}](${formatMarkdownDestination(result.relative_path)})`;
  const cursor = view.state.selection.main.head;
  view.dispatch({ changes: { from: cursor, insert: imageMarkdown } });
}

// Pasting a whole document (frontmatter + body) into a file without
// frontmatter adopts the frontmatter into the panel and inserts only the body.
function handleFrontmatterPaste(event: ClipboardEvent, view: EditorView, filePath: string) {
  const text = event.clipboardData?.getData("text/plain");
  if (!text) return false;

  const parsedFrontmatter = parseFrontmatter(text);
  if (parsedFrontmatter.frontmatter === null) return false;

  const parsedDocument = parseDocument(text);

  const file = editorApi.getOpenFile(filePath);
  if (!file || file.frontmatter !== null) return false;

  event.preventDefault();
  editorApi.updateFrontmatter(filePath, parsedFrontmatter.frontmatter);
  if (parsedDocument.body) {
    view.dispatch(view.state.replaceSelection(parsedDocument.body));
  }
  return true;
}

// Typing `---` on the first line of a file without frontmatter opens an empty
// frontmatter panel instead of leaving a horizontal rule in the body.
function handleFrontmatterStart(event: KeyboardEvent, view: EditorView, filePath: string) {
  if (event.key !== "-") return false;

  const { doc, selection } = view.state;
  const pos = selection.main.head;
  const firstLine = doc.line(1);

  if (pos !== firstLine.from + 2) return false;
  if (firstLine.text !== "--") return false;

  const file = editorApi.getOpenFile(filePath);
  if (!file || file.frontmatter !== null) return false;

  editorApi.updateFrontmatter(filePath, "");
  view.dispatch({
    changes: { from: firstLine.from, to: firstLine.from + 2 },
  });
  event.preventDefault();
  return true;
}

/** Paste and keyboard handling that touches files: image paste to disk,
 *  frontmatter adoption on paste, and the `---` frontmatter shortcut. */
export function editorClipboardExtension(
  getFilePath: () => string,
  isDisposed: () => boolean,
): Extension {
  return EditorView.domEventHandlers({
    paste(event, view) {
      if (handleFrontmatterPaste(event, view, getFilePath())) return true;

      const imageFile = pastedImageFile(event.clipboardData);
      if (!imageFile) return false;

      event.preventDefault();
      void handleImagePaste(imageFile, view, getFilePath(), isDisposed).catch((error) => {
        console.error("[editor] Failed to paste image:", error);
      });
      return true;
    },
    keydown(event, view) {
      return handleFrontmatterStart(event, view, getFilePath());
    },
  });
}
