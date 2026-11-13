import { Extension } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Linked names (SPEC-056 R-15, R-16): the world's characters and places recognised in the prose
 * and drawn underlined, as a decoration only.
 *
 * Nothing is written into the document. The round-trip proof runs over `markdownExtensions()`,
 * which never includes this, so a chapter's bytes are the same with names linked or not; the
 * underline is paint over text the author typed, and the card it opens is the screen's.
 */

export interface LinkedName {
  id: string;
  kind: "character" | "place";
  /** What the sheet is called in the prose: its name and short name, each matched on its own. */
  names: string[];
  /** The book's speaker colour (SPEC-047 R-33), or null for the neutral underline. */
  colour: number | null;
}

export interface NameHit {
  from: number;
  to: number;
  /** Every sheet the matched text names; two sheets can share a short name (R-17). */
  ids: string[];
}

export interface NameMatcher {
  find: (text: string) => NameHit[];
  byId: Map<string, LinkedName>;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BEFORE = "(?<![\\p{L}\\p{N}_])";
const AFTER = "(?![\\p{L}\\p{N}_])";

/**
 * One matcher over every name, longest first so `Maren Kest` wins over `Maren` (R-15). A name
 * starting with a capital matches case-sensitively — `Rook` the man, not `rook` the bird — and
 * any other name matches in any case, in a second expression, because a regex's flags are its
 * whole.
 */
export function nameMatcher(names: readonly LinkedName[]): NameMatcher | null {
  const byText = new Map<string, Set<string>>();
  const byFolded = new Map<string, Set<string>>();
  for (const sheet of names) {
    for (const raw of sheet.names) {
      const name = raw.trim();
      // A single letter would underline every `I` and `A`.
      if (name.length < 2) continue;
      // `The Vigil` is `the Vigil` mid-sentence: the article is the one capital prose drops.
      const spellings = /^The\s/.test(name) ? [name, `t${name.slice(1)}`] : [name];
      for (const spelling of spellings) {
        const capital = /^\p{Lu}/u.test(spelling) || spelling !== name;
        const table = capital ? byText : byFolded;
        const key = capital ? spelling : spelling.toLowerCase();
        if (!table.has(key)) table.set(key, new Set());
        table.get(key)!.add(sheet.id);
      }
    }
  }
  if (byText.size === 0 && byFolded.size === 0) return null;
  const build = (keys: Iterable<string>, flags: string) => {
    const list = [...keys].sort((a, b) => b.length - a.length).map(escape);
    return list.length === 0 ? null : new RegExp(`${BEFORE}(?:${list.join("|")})${AFTER}`, flags);
  };
  const exact = build(byText.keys(), "gu");
  const folded = build(byFolded.keys(), "giu");
  const find = (text: string): NameHit[] => {
    const hits: NameHit[] = [];
    for (const [pattern, table, fold] of [[exact, byText, false], [folded, byFolded, true]] as const) {
      if (pattern === null) continue;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
        const ids = table.get(fold ? match[0].toLowerCase() : match[0]);
        if (ids !== undefined) hits.push({ from: match.index, to: match.index + match[0].length, ids: [...ids] });
      }
    }
    // The two expressions can overlap (`Maren` and `maren kest`): the longer, then the earlier, wins.
    // The same span found by both (`Ade` and `ade`) names every sheet either found (codex on PR 1800).
    hits.sort((a, b) => a.from - b.from || b.to - b.from - (a.to - a.from));
    const kept: NameHit[] = [];
    for (const hit of hits) {
      const last = kept[kept.length - 1];
      if (last !== undefined && hit.from === last.from && hit.to === last.to) {
        last.ids = [...new Set([...last.ids, ...hit.ids])];
        continue;
      }
      if (last !== undefined && hit.from < last.to) continue;
      kept.push(hit);
    }
    return kept;
  };
  return { find, byId: new Map(names.map((sheet) => [sheet.id, sheet])) };
}

export const linkedNamesKey = new PluginKey<DecorationSet>("linkedNames");

function decorate(matcher: NameMatcher, block: ProseNode, offset: number): Decoration[] {
  const out: Decoration[] = [];
  // Text runs, not the block's text: a mark boundary or an inline node splits a name, and a name
  // across a bold run is rare enough to leave plain rather than to map positions for.
  block.descendants((node, pos) => {
    // Code nested anywhere (a fence inside a list) is code, not people.
    if (node.type.spec.code) return false;
    if (!node.isText || node.text === undefined) return true;
    if (node.marks.some((mark) => mark.type.name === "code" || mark.type.name === "link")) return false;
    for (const hit of matcher.find(node.text)) {
      const sheets = hit.ids.map((id) => matcher.byId.get(id)).filter((sheet) => sheet !== undefined);
      const first = sheets[0];
      if (first === undefined) continue;
      const character = sheets.some((sheet) => sheet.kind === "character");
      const colour = sheets.length === 1 && first.colour !== null ? first.colour : null;
      out.push(
        Decoration.inline(offset + pos + hit.from, offset + pos + hit.to, {
          class: `fy-ln fy-ln--${character ? "character" : "place"} fy-voice--${colour ?? "none"}`,
          "data-names": hit.ids.join(" "),
        }),
      );
    }
    return false;
  });
  return out;
}

function decorateAll(matcher: NameMatcher | null, doc: ProseNode): DecorationSet {
  if (matcher === null) return DecorationSet.empty;
  const all: Decoration[] = [];
  doc.forEach((block, offset) => {
    // A code block's words are code, not people.
    if (block.type.spec.code) return;
    all.push(...decorate(matcher, block, offset + 1));
  });
  return DecorationSet.create(doc, all);
}

/**
 * Only the top-level blocks a change touched are read again (R-20): a keystroke re-scans its own
 * paragraph, so a 10,000-word chapter types as fast as a short one.
 */
function touchedBlocks(tr: Transaction): [number, number][] {
  const ranges: [number, number][] = [];
  tr.mapping.maps.forEach((map, index) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const rest = tr.mapping.slice(index + 1);
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)]);
    });
  });
  return ranges;
}

export function linkedNamesPlugin(getMatcher: () => NameMatcher | null): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: linkedNamesKey,
    state: {
      init: (_config, state) => decorateAll(getMatcher(), state.doc),
      apply(tr, old) {
        // The names changed (a sheet arrived, one was renamed): read the whole chapter again.
        if (tr.getMeta(linkedNamesKey) === "refresh") return decorateAll(getMatcher(), tr.doc);
        if (!tr.docChanged) return old;
        const matcher = getMatcher();
        if (matcher === null) return DecorationSet.empty;
        let set = old.map(tr.mapping, tr.doc);
        const seen = new Set<number>();
        for (const [from, to] of touchedBlocks(tr)) {
          // One position wider each side, so a deletion at a block's edge still reads that block.
          tr.doc.nodesBetween(Math.max(0, from - 1), Math.min(tr.doc.content.size, to + 1), (block, pos) => {
            if (seen.has(pos)) return false;
            seen.add(pos);
            const end = pos + block.nodeSize;
            set = set.remove(set.find(pos, end));
            if (!block.type.spec.code) set = set.add(tr.doc, decorate(matcher, block, pos + 1));
            return false;
          });
        }
        return set;
      },
    },
    props: {
      decorations(state) {
        return linkedNamesKey.getState(state);
      },
    },
  });
}

export const LinkedNames = Extension.create<{ getMatcher: () => NameMatcher | null }>({
  name: "linkedNames",
  addOptions() {
    return { getMatcher: () => null };
  },
  addProseMirrorPlugins() {
    return [linkedNamesPlugin(this.options.getMatcher)];
  },
});
