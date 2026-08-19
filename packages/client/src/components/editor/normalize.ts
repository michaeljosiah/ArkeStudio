import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";

/**
 * Reflow the soft line breaks a hand-wrapped paragraph arrives with.
 *
 * Markdown treats a bare newline inside a paragraph as a space — it is where the author's text
 * editor wrapped, not something they meant — and the parser faithfully keeps it as a newline inside
 * a text node. On a page that is invisible, because HTML collapses it. In a contenteditable it is
 * a trap: the moment somebody types into that paragraph the browser rebuilds it from the DOM, where
 * the newline has no representation, and the editor takes it back as an explicit hard break. The
 * file then gains two trailing spaces the author never typed, and the paragraph that used to flow
 * renders as two lines everywhere — including in what the Studio reads.
 *
 * Reflowing at load removes the trap rather than trying to survive it: there is no newline left in
 * any paragraph, so there is nothing for a round trip through the DOM to reinterpret. The author's
 * wrapping is not lost — it lives in the file, and reconciliation patches edits onto those bytes,
 * so untouched lines keep breaking exactly where they always did.
 *
 * Hard breaks the author actually meant — two trailing spaces, or a backslash — parse as their own
 * node and never appear as text, so nothing here can reach them.
 */
/**
 * Nodes whose markdown is a marker and nothing else, so an empty one writes down as a line that
 * reads back as nothing: `>` for a quote, `#` for a heading.
 */
const MARKER_ONLY_BLOCKS = new Set(["blockquote", "heading"]);

/**
 * Remove empty quotes and headings the author has left behind.
 *
 * Asking for a quote makes an empty one, and until something is typed into it the document cannot
 * be written down at all: the file would get a bare `>` that reads back as nothing, so the commit
 * refuses (see `commit.ts`) and holds the whole document — including everything typed after it.
 * A block somebody made and moved on from is not content, and treating it as content lets one
 * stray keystroke stop a bible saving with no sign that anything is wrong.
 *
 * The one the caret is inside is left exactly where it is. That block is not stranded, it is being
 * written; deleting it out from under the cursor would be the app refusing to let anyone make a
 * quote at all. The commit holds for as long as that lasts, which is until the next character.
 */
export function dropStrandedEmptyBlocks(editor: Editor): void {
  const { doc, selection, tr } = editor.view.state;
  const stranded: { from: number; to: number }[] = [];

  doc.descendants((node, pos) => {
    if (!MARKER_ONLY_BLOCKS.has(node.type.name)) return true;
    if (node.textContent.trim() !== "" || hasLeafContent(node)) return true;
    // `from`/`to` rather than a containment test on the head alone, so a selection spanning the
    // block also counts as being in it.
    if (selection.from <= pos + node.nodeSize && selection.to >= pos) return false;
    stranded.push({ from: pos, to: pos + node.nodeSize });
    return false;
  });

  if (stranded.length === 0) return;
  for (const { from, to } of stranded.reverse()) tr.delete(from, to);
  editor.view.dispatch(tr.setMeta("addToHistory", false));
}

/** Whether anything is inside that carries meaning without carrying text — an image, a rule. */
function hasLeafContent(node: PmNode): boolean {
  let found = false;
  node.descendants((child) => {
    if (found) return false;
    if (child.isLeaf && !child.isText) found = true;
    return !found;
  });
  return found;
}

export function normalizeSoftBreaks(editor: Editor): void {
  // Read from the view's state rather than the editor's: after `setContent` the latter can still be
  // the one React last rendered, and a transaction built on a stale document maps to wrong positions.
  const { doc, tr } = editor.view.state;
  const replacements: { from: number; to: number; node: PmNode }[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text?.includes("\n")) return true;
    // Collapse the whitespace either side of the break too, so a line the author ended with a single
    // trailing space does not reflow into a double one.
    const reflowed = node.text.replace(/[ \t]*\n[ \t]*/g, " ");
    replacements.push({ from: pos, to: pos + node.nodeSize, node: editor.schema.text(reflowed, node.marks) });
    return true;
  });

  if (replacements.length === 0) return;

  // Back to front, so each replacement's positions are still the ones measured above.
  for (const replacement of replacements.reverse()) {
    tr.replaceWith(replacement.from, replacement.to, replacement.node);
  }
  // Housekeeping, not an edit: it must not become a step the author can undo into.
  editor.view.dispatch(tr.setMeta("addToHistory", false));
}
