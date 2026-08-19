import type { RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { reconcileMarkdown } from "./reconcile.js";
import { documentMarkdown } from "./round-trip.js";

/**
 * The one place bytes are allowed to leave the editor, and the one place they are proved first.
 *
 * The rule is a single sentence: never write markdown that would not read back as the document on
 * screen. Everything below is that sentence made to hold against the two ways it can fail —
 * a fuzzy patch landing somewhere it was not meant to, and a document the editor can hold but
 * markdown cannot express.
 */

/**
 * The baselines reconciliation patches against, carried across edits.
 *
 * They move together or not at all, which is why advancing them lives here rather than at each of
 * the three places that ask for a serialisation (the debounce, the blur flush, the unmount flush).
 * A commit that advanced `originalSource` without advancing `baseCanonical` would make the next
 * edit diff against a base the source no longer matches, and the patch would land somewhere else
 * in the document.
 */
export interface ReconcileBaselines {
  /** The bible's bytes as they now stand — proved output from the last commit, or the load. */
  originalSource: RefObject<string>;
  /** Canonical serialisation of `originalSource`. */
  baseCanonical: RefObject<string>;
  /** The exact bytes last handed upward, which is what distinguishes our own echo from an edit
   *  arriving from the Studio or a text editor. */
  lastCommitted: RefObject<string>;
}

export interface MarkdownCommit {
  /** The bytes to persist. */
  markdown: string;
  /**
   * Whether these bytes differ from the ones last handed up, and may be written.
   *
   * False covers three different quiet outcomes on purpose, because the caller's response to all
   * three is the same — write nothing, change nothing, wait. Nothing was typed; the editor
   * dispatched a transaction of its own (the trailing paragraph it keeps below the last block
   * arrives looking exactly like an edit); or the document cannot be written down yet.
   */
  changed: boolean;
}

/**
 * Serialise the document, carry it into the source's style, prove it, and advance the baselines.
 *
 * Never throws for the ordinary reasons it might: an editor destroyed between scheduling a
 * serialisation and running it is a tab switch, not a fault.
 */
export function commitMarkdown(
  editor: Editor | null,
  baselines: ReconcileBaselines,
  roundTrip: (markdown: string) => string | null,
): MarkdownCommit {
  let edited: string | undefined;
  try {
    edited = editor ? documentMarkdown(editor) : undefined;
  } catch {
    edited = undefined;
  }
  if (edited === undefined) return held(baselines);

  let candidate: string;
  try {
    candidate = reconcileMarkdown({
      originalSource: baselines.originalSource.current,
      baseCanonical: baselines.baseCanonical.current,
      edited,
    });
  } catch {
    // Style preservation is the nicety; the text is not. Canonical output says the same thing.
    candidate = edited;
  }

  /*
   * The proof, and the only one. Re-reading the candidate has to produce exactly what the editor is
   * showing — which catches a hunk the fuzzy matcher put in the wrong place, and equally catches a
   * document that does not survive being written at all.
   *
   * That second case is not hypothetical. Ask for a quote block and leave it empty and the document
   * holds an empty blockquote; markdown writes that as a bare `>`, and a bare `>` reads back as
   * nothing. Without this check the block is gone on the next load — and worse, the mismatch would
   * make every future commit fall back to canonical, so the author's formatting would be spent on
   * a block they were still in the middle of making.
   */
  if (roundTrip(candidate) === edited) return advance(baselines, candidate, edited);

  /*
   * The candidate was the author's formatting and it did not survive. Canonical output is the other
   * thing worth trying, and it is a different question: not "did the patch land" but "can this
   * document be written down". When `candidate` already *is* `edited` those questions are the same
   * one, and it has been answered.
   */
  if (candidate !== edited && roundTrip(edited) === edited) {
    return advance(baselines, edited, edited);
  }

  /*
   * Neither reads back. Hold everything — bytes, baselines, the lot — and let the next keystroke
   * ask again. The author is mid-gesture, and a document that cannot be written yet is not a
   * document that should be written badly.
   */
  return held(baselines);
}

function held(baselines: ReconcileBaselines): MarkdownCommit {
  return { markdown: baselines.lastCommitted.current, changed: false };
}

function advance(
  baselines: ReconcileBaselines,
  reconciled: string,
  edited: string,
): MarkdownCommit {
  const changed = reconciled !== baselines.lastCommitted.current;
  baselines.originalSource.current = reconciled;
  // `reconciled` and `edited` are the same document — that is what was just proved — so `edited` is
  // already the canonical form of the new source.
  baselines.baseCanonical.current = edited;
  baselines.lastCommitted.current = reconciled;
  return { markdown: reconciled, changed };
}
