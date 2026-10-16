import { Extension } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

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
        const { $head } = state.selection;
        if ($head.depth === 0) return DecorationSet.empty;
        const from = $head.before(1);
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

/** Every case-insensitive occurrence of the query in the document's text runs. */
export function findMatches(doc: ProseNode, query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const out: FindMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || node.text === undefined) return true;
    const hay = node.text.toLowerCase();
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
      out.push({ from: pos + at, to: pos + at + needle.length });
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

export const WritingAids = Extension.create({
  name: "writingAids",
  addProseMirrorPlugins() {
    return [caretBlockPlugin(), findPlugin()];
  },
});
