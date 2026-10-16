import type { Editor } from "@tiptap/core";

/**
 * `@` inserts a name (SPEC-056 R-18): a menu at the caret of this chapter's speakers, the
 * world's other characters, then places. What goes into the prose is the plain name — never a
 * link syntax — so the chapter reads the same in any editor; the underline is linked names'.
 */

export type MentionGroup = "In this chapter" | "Characters" | "Places";

export interface Mention {
  id: string;
  /** Shown in the menu: the full name. */
  name: string;
  /** Written into the prose: the short name where the sheet has one. */
  insert: string;
  group: MentionGroup;
  face?: string | null;
}

export interface MentionTrigger {
  query: string;
  /** Positions of the `@` and the caret, so inserting replaces exactly what was typed. */
  from: number;
  to: number;
}

export interface MentionMenuState extends MentionTrigger {
  left: number;
  top: number;
}

/** Long enough for a full name with a space in it; past this the `@` was not a mention. */
export const MENTION_QUERY_MAX_LENGTH = 30;

/*
 * The `@` starts a word — at the block's start, or after a space or an opening mark — so an email
 * address or `me@home` never opens it. The query may hold a space, for `Maren Ke…`.
 */
const MENTION_TRIGGER = /(?:^|[\s([{"'‘“—–])@([\p{L}\p{N}'’. -]*)$/u;

export function matchMentionTrigger(blockTextBeforeCursor: string): string | null {
  const match = MENTION_TRIGGER.exec(blockTextBeforeCursor);
  if (!match) return null;
  const query = match[1] ?? "";
  if (query.length > MENTION_QUERY_MAX_LENGTH || /\s\s/.test(query) || /^\s/.test(query)) return null;
  return query;
}

const GROUP_ORDER: MentionGroup[] = ["In this chapter", "Characters", "Places"];

/** Rows whose name or inserted name has a word starting with the query, in the group order R-18 sets. */
export function filterMentions(mentions: readonly Mention[], rawQuery: string): Mention[] {
  const query = rawQuery.trim().toLowerCase();
  const rows = query === ""
    ? [...mentions]
    : mentions.filter((row) => {
        const words = `${row.name} ${row.insert}`.toLowerCase();
        return words.startsWith(query) || words.includes(` ${query}`);
      });
  return rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

/** Replace `@query` with the name and a space, as one undo step. */
export function insertMention(editor: Editor, trigger: MentionTrigger, mention: Mention): void {
  editor
    .chain()
    .focus()
    // A text node, not a string: a string is parsed as markup, and a name is only ever words.
    .insertContentAt({ from: trigger.from, to: trigger.to }, { type: "text", text: `${mention.insert} ` })
    .run();
}

export function readMentionState(editor: Editor, shell: HTMLElement | null): MentionMenuState | null {
  if (!shell || !editor.isEditable || editor.view.composing) return null;
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, "\0", "\0");
  const query = matchMentionTrigger(before);
  if (query === null) return null;
  const at = before.length - query.length - 1;
  const from = selection.from - ($from.parentOffset - at);
  const caret = editor.view.coordsAtPos(from);
  const bounds = shell.getBoundingClientRect();
  return { query, from, to: selection.from, left: caret.left - bounds.left, top: caret.bottom - bounds.top + 6 };
}
