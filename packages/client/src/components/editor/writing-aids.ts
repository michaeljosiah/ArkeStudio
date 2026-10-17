import { Extension } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { marginsPlugin } from "./margins.js";

/**
 * The writing room's aids (SPEC-056 R-7, R-12): the paragraph holding the caret, marked so Focus
 * can dim the rest, and Find's matches. Both are decorations over the live editor only — like
 * linked names, they are never in the round-trip proof's set and never touch the Markdown.
 */

/** The top-level block the caret is in, as `fy-rme__here`; Focus's CSS reads it, nothing else does. */
export const caretBlockKey = new PluginKey("caretBlock");

export function caretBlockPlugin(): Plugin {
  return new Plugin({
    key: caretBlockKey,
    props: {
      decorations(state) {
        // The text block holding the caret, not its top-level container: in a list or a quote
        // only the caret's own paragraph comes to full strength (codex on PR 1801).
        const { $head } = state.selection;
        if ($head.depth === 0 || !$head.parent.isTextblock) return DecorationSet.empty;
        const from = $head.before($head.depth);
        const node = state.doc.nodeAt(from);
        if (node === null) return DecorationSet.empty;
        return DecorationSet.create(state.doc, [Decoration.node(from, from + node.nodeSize, { class: "fy-rme__here" })]);
      },
    },
  });
}

export interface FindState {
  query: string;
  /** Which match is current, counted from zero; wraps. */
  index: number;
}

export interface FindMatch {
  from: number;
  to: number;
}

type FindPluginState = { find: FindState | null; matches: FindMatch[] };

export const findKey = new PluginKey<FindPluginState>("find");

/**
 * Every case-insensitive occurrence of the query, read a text block at a time so a phrase across
 * a bold or a link (`the **bell** rang`) is found as the reader sees it (codex on PR 1801). Each
 * inline node is one run of the block's text, mapped back to its document position; a leaf that
 * is not text (a break, an image) stands as one character nothing typed can match.
 */
export function findMatches(doc: ProseNode, query: string, caseSensitive = false): FindMatch[] {
  const needle = caseSensitive ? query.trim() : query.trim().toLowerCase();
  if (needle === "") return [];
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    const runs: { at: number; pos: number }[] = [];
    node.forEach((child, offset) => {
      runs.push({ at: text.length, pos: pos + 1 + offset });
      text += child.isText ? (child.text ?? "") : "\uFFFC";
    });
    const toPos = (index: number) => {
      let run = runs[0]!;
      for (const candidate of runs) if (candidate.at <= index) run = candidate;
      return run.pos + (index - run.at);
    };
    const hay = caseSensitive ? text : text.toLowerCase();
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
      out.push({ from: toPos(at), to: toPos(at + needle.length) });
    }
    return false;
  });
  return out;
}

export function findPlugin(): Plugin<FindPluginState> {
  return new Plugin<FindPluginState>({
    key: findKey,
    state: {
      init: (): FindPluginState => ({ find: null, matches: [] }),
      apply(tr, old): FindPluginState {
        const meta = tr.getMeta(findKey) as FindState | null | undefined;
        const find = meta === undefined ? old.find : meta;
        if (find === null) return { find: null, matches: [] };
        if (meta === undefined && !tr.docChanged) return old;
        return { find, matches: findMatches(tr.doc, find.query) };
      },
    },
    props: {
      decorations(state: EditorState) {
        const own = findKey.getState(state);
        if (own === undefined || own.find === null || own.matches.length === 0) return DecorationSet.empty;
        const here = currentMatch(own.find, own.matches.length);
        return DecorationSet.create(
          state.doc,
          own.matches.map((match, i) => Decoration.inline(match.from, match.to, { class: i === here ? "fy-find fy-find--here" : "fy-find" })),
        );
      },
    },
  });
}

/** The current match's index for a count, wrapped either way. */
export function currentMatch(find: FindState, count: number): number {
  if (count === 0) return -1;
  return ((find.index % count) + count) % count;
}

/*
 * A review's notes, marked in the prose (SPEC-056 R-29): each quote a neutral highlight numbered
 * for its note, the open one in warning. Found by the quote's words in the text the editor shows,
 * the same appearance the body's offset named, so a repeated phrase marks the right one.
 */
export interface ReviewMark {
  n: number;
  text: string;
  nth: number;
}
type ReviewMarksState = { marks: readonly ReviewMark[]; current: number | null };
export const reviewMarksKey = new PluginKey<ReviewMarksState>("reviewMarks");

export function reviewMarksPlugin(): Plugin<ReviewMarksState> {
  return new Plugin<ReviewMarksState>({
    key: reviewMarksKey,
    state: {
      init: (): ReviewMarksState => ({ marks: [], current: null }),
      apply: (tr, old): ReviewMarksState => (tr.getMeta(reviewMarksKey) as ReviewMarksState | undefined) ?? old,
    },
    props: {
      decorations(state: EditorState) {
        const own = reviewMarksKey.getState(state);
        if (own === undefined || own.marks.length === 0) return DecorationSet.empty;
        const out: Decoration[] = [];
        for (const mark of own.marks) {
          const match = findMatches(state.doc, mark.text, true)[mark.nth];
          if (match === undefined) continue;
          out.push(Decoration.inline(match.from, match.to, {
            class: mark.n === own.current ? "fy-review-quote fy-review-quote--here" : "fy-review-quote",
            "data-note": String(mark.n),
          }));
        }
        return DecorationSet.create(state.doc, out);
      },
    },
  });
}

export const WritingAids = Extension.create({
  name: "writingAids",
  addProseMirrorPlugins() {
    return [caretBlockPlugin(), findPlugin(), marginsPlugin(), reviewMarksPlugin()];
  },
});
