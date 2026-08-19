import { Editor } from "@tiptap/core";
import { markdownExtensions } from "./extensions.js";
import { normalizeSoftBreaks } from "./normalize.js";

/**
 * Parse markdown and serialise it straight back, through a throwaway editor that is never mounted.
 *
 * This is the measuring instrument the rest of the editor is built on. `serializeMarkdown(text)` is
 * the canonical form of `text`: what the mounted editor would emit if the author opened the
 * document and changed nothing. The gate uses it to find out what a document loses on the way in,
 * and reconciliation uses it to prove a patched result still says what the editor is showing.
 *
 * Returns null when the round trip throws, which is a real outcome rather than an error to report:
 * markdown the extension set cannot represent falls through to a DOM parse that does not exist in a
 * headless editor. Every caller treats null as "cannot be proved" and takes the safe branch.
 */
export function serializeMarkdown(markdown: string): string | null {
  let editor: Editor | null = null;
  try {
    editor = new Editor({
      element: null,
      extensions: markdownExtensions(),
      content: markdown,
      contentType: "markdown",
    });
    // The mounted editor reflows on load too. If this one did not, its canonical form would differ
    // from the live one for every hand-wrapped document, and the proof would reject them all.
    normalizeSoftBreaks(editor);
    return documentMarkdown(editor);
  } catch {
    return null;
  } finally {
    editor?.destroy();
  }
}

/**
 * What a live editor's document is worth as markdown.
 *
 * Trailing blank lines are dropped, and that is the whole reason this exists rather than everybody
 * calling `getMarkdown` directly. A mounted editor keeps an empty paragraph at the end of the
 * document so there is always somewhere to click below a list or a table — an affordance, not
 * content — and it is appended by the editor itself, moments after the document loads. Left in the
 * output it reads as an edit nobody made: the file saves, the version increments, and the history
 * fills with revisions whose only content is a blank line at the bottom.
 *
 * Both sides of every comparison in this module go through here, so the trailing paragraph is
 * invisible to all of them. The cost is that trailing blank lines cannot be authored, which no
 * markdown renderer would have shown anyway.
 */
export function documentMarkdown(editor: Editor): string {
  return editor.getMarkdown().replace(/\n+$/, "");
}
