import type { Editor } from "@tiptap/core";
import { BIBLE_HELPER_BOUNDS, type BibleHelperKind } from "@arke-studio/contracts";

/**
 * The helpers that act on a selection — the tray that appears when prose is highlighted.
 *
 * Written the way `slash-commands.ts` is written, and for the same reason: everything that can be
 * decided without a document is a plain function taking numbers and strings, so the placement rule
 * and the staleness rule can be tested without mounting an editor. Only `readSelectionState` needs
 * a live one, and all it does is read coordinates off it.
 */

export interface SelectionHelper {
  kind: BibleHelperKind;
  label: string;
  /**
   * Whether the result can be pressed back into the document.
   *
   * False for `ask`, and the absent Replace control is the whole statement — design 90 is explicit
   * that a card explaining itself in a sentence is the clutter turn 69 cut.
   */
  edits: boolean;
}

export const SELECTION_HELPERS: readonly SelectionHelper[] = [
  { kind: "rewrite", label: "Rewrite", edits: true },
  { kind: "expand", label: "Expand", edits: true },
  { kind: "tighten", label: "Tighten", edits: true },
  { kind: "ask", label: "Ask", edits: false },
];

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Between the selection's last line and the tray. */
export const TRAY_GAP = 6;
/** The tray's own height, pinned by design 90 so the flip threshold can be derived from it. */
export const TRAY_HEIGHT = 36;
/**
 * How much room below the selection the tray needs before it gives up and flips above.
 *
 * Derived rather than chosen: it is exactly the tray plus its gap, so changing either moves the
 * threshold with it instead of leaving a number that used to be right.
 */
export const TRAY_FLIP_MARGIN = TRAY_HEIGHT + TRAY_GAP;

/**
 * Where the tray goes, given where the selection ends and how tall the editor is.
 *
 * Below is the rule and above is the exception, which is the opposite of the usual convention. The
 * reason is in design 90: a heading and its paragraph sit 11px apart, the tray is 36 tall, and
 * putting it above would occlude the heading the author is looking at.
 */
export function placeTray(
  selectionTop: number,
  selectionBottom: number,
  editorHeight: number,
): { top: number; above: boolean } {
  const below = selectionBottom + TRAY_GAP;
  if (below + TRAY_HEIGHT <= editorHeight) return { top: below, above: false };
  return { top: Math.max(0, selectionTop - TRAY_GAP - TRAY_HEIGHT), above: true };
}

export interface SelectionState {
  /** Document positions the helpers act on. Mapped through every later edit, never re-read. */
  from: number;
  to: number;
  /** The selected prose. This is the anchor a result remembers itself by. */
  text: string;
  /** Offsets from the editor shell, which is the tray's positioned ancestor. */
  left: number;
  top: number;
  above: boolean;
}

/**
 * Read the live selection, or null when the tray should not be showing.
 *
 * Every path that is not a usable selection returns null rather than leaving the previous state
 * alone, so the tray closes the moment the selection collapses — exactly as `readSlashMenuState`
 * closes the block menu.
 */
export function readSelectionState(editor: Editor, shell: HTMLElement | null): SelectionState | null {
  if (!shell || !editor.isEditable || editor.view.composing) return null;

  const { selection } = editor.state;
  if (selection.empty) return null;

  const { from, to } = selection;
  const text = editor.state.doc.textBetween(from, to, "\n", " ");
  // Whitespace is not a passage. Selecting the gap between two paragraphs by dragging past the end
  // of a line is common enough that offering to rewrite it would be the app mishearing.
  if (text.trim() === "") return null;
  // Past this a selection is a document rather than a passage, and World Chat is the surface that
  // edits documents. Refused here rather than at the coordinator so no tokens are spent finding out.
  if (text.length > BIBLE_HELPER_BOUNDS.selection) return null;

  const bounds = shell.getBoundingClientRect();
  const head = editor.view.coordsAtPos(from);
  const tail = editor.view.coordsAtPos(to);
  const { top, above } = placeTray(head.top - bounds.top, tail.bottom - bounds.top, bounds.height);

  return { from, to, text, left: head.left - bounds.left, top, above };
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * Whether a result may still be pressed into the document.
 *
 * The anchor is the prose the run was made from, and the positions are carried forward through
 * every edit since by ProseMirror's own mapping — so typing elsewhere in the document moves a
 * result's range without invalidating it, and only a change to the passage itself does.
 *
 * `deleted` is the mapping's own verdict: when the range a result covered is gone, position
 * arithmetic cannot say so, because the two mapped positions collapse onto a perfectly valid
 * point in whatever replaced it.
 */
export function anchorHolds(
  current: string | null,
  anchor: string,
  deleted = false,
): boolean {
  return !deleted && current === anchor;
}

/** What a card shows where Replace would have been. One clause, on the thing refused. */
export const ANCHOR_MOVED = "the text moved";
