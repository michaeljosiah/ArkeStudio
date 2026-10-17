import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * The page's margins (SPEC-056 R-14, D-5): a speaker's face beside a spoken paragraph, and a
 * passage picture beside its passage. Widgets over the live editor only — never in the document,
 * never in the round-trip proof — each placed at the block its paragraph's opening words begin,
 * the paragraph counted as the cast and the audiobook count them. The CSS decides where they sit:
 * out in the margin where the page has room, inside the column where it does not.
 */

export interface MarginItem {
  /** The paragraph, counted from zero as the cast and the audiobook count them. */
  paragraph: number;
  /**
   * The paragraph's opening words, which find its block in the document: a paragraph as the prose
   * counts it can be several blocks (a heading run straight into its text), so its place among the
   * document's blocks is not its number (codex on PR 1803).
   */
  anchor: string;
  kind: "face" | "picture";
  src: string | null;
  /** A face's first name, shown on the first paragraph of a run of one speaker's. */
  label?: string;
  /** The whole name or the picture's alt, for assistive technology and the tooltip. */
  title: string;
}

export const marginsKey = new PluginKey<readonly MarginItem[]>("margins");

/** Letters and digits only, lowercased: what Markdown's marks and the editor's text agree on. */
export function anchorText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 32);
}

function render(items: readonly MarginItem[]): HTMLElement {
  const item = items[0]!;
  const root = document.createElement("span");
  root.className = `fy-margin fy-margin--${item.kind}`;
  root.contentEditable = "false";
  root.title = item.title;
  if (item.kind === "picture") {
    // Every picture a paragraph's blocks carry, one under another (codex on PR 1803).
    for (const picture of items) {
      if (picture.src === null) continue;
      const image = document.createElement("img");
      image.src = picture.src;
      image.alt = picture.title;
      image.loading = "lazy";
      image.draggable = false;
      root.append(image);
    }
  } else if (item.src !== null) {
    const image = document.createElement("img");
    image.src = item.src;
    image.alt = "";
    image.loading = "lazy";
    image.draggable = false;
    root.append(image);
  } else {
    const initial = document.createElement("span");
    initial.className = "fy-margin__initial";
    initial.textContent = item.title.slice(0, 1);
    root.append(initial);
  }
  if (item.label !== undefined) {
    const label = document.createElement("b");
    label.textContent = item.label;
    root.append(label);
  }
  if (item.kind === "face") root.setAttribute("aria-hidden", "true");
  return root;
}

function decorations(state: EditorState): DecorationSet {
  const items = marginsKey.getState(state) ?? [];
  if (items.length === 0) return DecorationSet.empty;
  const blocks: { at: number; size: number; text: boolean; anchor: string }[] = [];
  state.doc.forEach((node, offset) => blocks.push({ at: offset, size: node.nodeSize, text: node.isTextblock, anchor: anchorText(node.textContent) }));
  // Each paragraph's block is found by its opening words, searching on from the last one found,
  // so the same words further down are never taken for an earlier paragraph.
  const groups = new Map<string, MarginItem[]>();
  for (const item of [...items].sort((a, b) => a.paragraph - b.paragraph)) {
    const key = `${item.kind}:${item.paragraph}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const out: Decoration[] = [];
  let from = 0;
  for (const group of groups.values()) {
    const item = group[0]!;
    const want = anchorText(item.anchor);
    if (want === "") continue;
    // A block's words may be only the start of its paragraph's (a heading run into its text), but
    // not so few that any paragraph opening with them would do.
    const index = blocks.findIndex((block, i) => i >= from && block.text && block.anchor !== ""
      && (block.anchor.startsWith(want) || (block.anchor.length >= 8 && want.startsWith(block.anchor))));
    // A list or a quote has no line of its own to sit beside; only a text block takes a mark.
    if (index === -1) continue;
    from = index;
    const block = blocks[index]!;
    // A face before the words, pictures after them: inside the column a picture follows its passage.
    const pos = item.kind === "face" ? block.at + 1 : block.at + block.size - 1;
    out.push(Decoration.widget(pos, () => render(group), {
      side: item.kind === "face" ? -1 : 1,
      key: `${item.kind}:${item.paragraph}:${group.map((each) => each.src ?? "").join("|")}:${item.label ?? ""}`,
      ignoreSelection: true,
    }));
  }
  return DecorationSet.create(state.doc, out);
}

export function marginsPlugin(): Plugin<readonly MarginItem[]> {
  return new Plugin<readonly MarginItem[]>({
    key: marginsKey,
    state: {
      init: () => [],
      apply: (tr, old) => (tr.getMeta(marginsKey) as readonly MarginItem[] | undefined) ?? old,
    },
    props: { decorations },
  });
}
