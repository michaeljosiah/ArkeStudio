import type { AnyExtension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/**
 * The one extension set.
 *
 * Every parse and every serialisation in the editor must run through exactly this list — the live
 * document, the round-trip proof in `reconcile.ts`, and the rich-mode gate alike. If the proof used
 * a different set from the editor it would be proving the wrong thing: a construct the mounted
 * editor drops would survive the proof, and the fallback that exists to catch it would never fire.
 *
 * What is in here is therefore a statement about what the bible may contain. Anything a registered
 * extension cannot hold is parsed as literal text, which for raw HTML means it comes back
 * entity-escaped — so those shapes are refused by the gate rather than added to this list.
 */
export function markdownExtensions({ placeholder }: { placeholder?: string } = {}): AnyExtension[] {
  const extensions: AnyExtension[] = [
    StarterKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image,
    // Column resizing writes pixel widths into the document, which have no markdown to be written
    // to; the table serialises as GFM pipes and the widths would be silently lost every save.
    TableKit.configure({ table: { resizable: false } }),
    Markdown.configure({ markedOptions: { gfm: true } }),
  ];

  // Decoration only — it draws grey text into an empty node and changes nothing about the document,
  // so the headless serialiser leaves it out rather than paying for it.
  if (placeholder !== undefined) {
    extensions.push(Placeholder.configure({ placeholder }));
  }

  return extensions;
}
