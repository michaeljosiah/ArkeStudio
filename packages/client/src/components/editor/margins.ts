import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * The page's margins (SPEC-056 R-14, D-5): a speaker's face beside a spoken paragraph, and a
 * passage picture beside its passage. Widgets over the live editor only — never in the document,
 * never in the round-trip proof — keyed by the paragraph's place among the document's top-level
 * blocks, which is how the cast and the audiobook count paragraphs. The CSS decides where they sit:
 * out in the margin where the page has room, inside the column where it does not.
 */

export interface MarginItem {
  /** The paragraph, counted from zero among the top-level blocks. */
  paragraph: number;
  kind: "face" | "picture";
  src: string | null;
  /** A face's first name, shown on the first paragraph of a run of one speaker's. */
  label?: string;
  /** The whole name or the picture's alt, for assistive technology and the tooltip. */
  title: string;
}

export const marginsKey = new PluginKey<readonly MarginItem[]>("margins");

function render(item: MarginItem): HTMLElement {
  const root = document.createElement("span");
  root.className = `fy-margin fy-margin--${item.kind}`;
  root.contentEditable = "false";
  root.title = item.title;
  if (item.src !== null) {
    const image = document.createElement("img");
    image.src = item.src;
    image.alt = item.kind === "picture" ? item.title : "";
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
  const blocks: { at: number; size: number; text: boolean }[] = [];
  state.doc.forEach((node, offset) => blocks.push({ at: offset, size: node.nodeSize, text: node.isTextblock }));
  const out: Decoration[] = [];
  for (const item of items) {
    const block = blocks[item.paragraph];
    // A list or a quote has no line of its own to sit beside; only a text block takes a mark.
    if (block === undefined || !block.text) continue;
    // A face before the words, a picture after them: inside the column a picture follows its passage.
    const pos = item.kind === "face" ? block.at + 1 : block.at + block.size - 1;
    out.push(Decoration.widget(pos, () => render(item), {
      side: item.kind === "face" ? -1 : 1,
      key: `${item.kind}:${item.paragraph}:${item.src ?? ""}:${item.label ?? ""}`,
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
