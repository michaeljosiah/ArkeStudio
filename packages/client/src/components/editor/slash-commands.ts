import type { Editor } from "@tiptap/core";

/**
 * The `/` menu — the one gesture that makes a document feel like blocks rather than a text area.
 *
 * The trigger is read straight off the selection on every update rather than run through a
 * suggestion plugin, because the whole behaviour is one regex against the text before the cursor
 * and a popover placed at it. Everything here that can be tested without a document is a plain
 * function taking strings, which is most of it.
 */

export type SlashGroup = "Structure" | "Lists" | "Blocks";

export interface SlashCommand {
  id: string;
  label: string;
  /** Extra words the query may match. The label is always searched; these are the synonyms. */
  aliases: string[];
  group: SlashGroup;
  run: (editor: Editor) => void;
}

export interface SlashTrigger {
  /** What has been typed after the slash, lowercased by the filter rather than here. */
  query: string;
  /** Document positions of the `/` and of the cursor, so committing can delete exactly the trigger. */
  from: number;
  to: number;
}

export interface SlashMenuState extends SlashTrigger {
  /** Offsets from the editor shell, which is the popover's positioned ancestor. */
  left: number;
  top: number;
}

/*
 * Deliberately no Image row. The extension is registered so an image already in a bible survives
 * being edited, but a bible has no folder of its own to put a new one in, and a slash command that
 * inserts a broken relative path is worse than no slash command.
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "paragraph",
    label: "Text",
    aliases: ["paragraph", "plain", "body"],
    group: "Structure",
    run: (editor) => void editor.chain().focus().setParagraph().run(),
  },
  {
    id: "heading-1",
    label: "Heading 1",
    aliases: ["h1", "title"],
    group: "Structure",
    run: (editor) => void editor.chain().focus().setNode("heading", { level: 1 }).run(),
  },
  {
    // The bible's own outline is built from `## ` headings, so this is the row that matters most
    // here: it is the one that puts a section in the panel beside the editor.
    id: "heading-2",
    label: "Heading 2",
    aliases: ["h2", "section"],
    group: "Structure",
    run: (editor) => void editor.chain().focus().setNode("heading", { level: 2 }).run(),
  },
  {
    id: "heading-3",
    label: "Heading 3",
    aliases: ["h3", "subsection"],
    group: "Structure",
    run: (editor) => void editor.chain().focus().setNode("heading", { level: 3 }).run(),
  },
  {
    id: "bullet-list",
    label: "Bulleted list",
    aliases: ["ul", "bullet", "list"],
    group: "Lists",
    run: (editor) => void editor.chain().focus().toggleBulletList().run(),
  },
  {
    id: "ordered-list",
    label: "Numbered list",
    aliases: ["ol", "numbered", "list"],
    group: "Lists",
    run: (editor) => void editor.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "task-list",
    label: "Check list",
    aliases: ["todo", "task", "checkbox"],
    group: "Lists",
    run: (editor) => void editor.chain().focus().toggleTaskList().run(),
  },
  {
    id: "blockquote",
    label: "Quote",
    aliases: ["blockquote", "citation"],
    group: "Blocks",
    run: (editor) => void editor.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "code-block",
    label: "Code",
    aliases: ["code", "fence", "snippet"],
    group: "Blocks",
    run: (editor) => void editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: "table",
    label: "Table",
    aliases: ["grid", "rows", "columns"],
    group: "Blocks",
    run: (editor) =>
      void editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: "divider",
    label: "Divider",
    aliases: ["hr", "rule", "separator", "break"],
    group: "Blocks",
    run: (editor) => void editor.chain().focus().setHorizontalRule().run(),
  },
];

/**
 * A pasted paragraph beginning with a slash would otherwise be treated as a query and matched
 * against every row. Nothing anybody types to pick a block is longer than this.
 */
export const SLASH_QUERY_MAX_LENGTH = 60;

/**
 * The trigger: a slash at the start of the block, and only word characters after it.
 *
 * Anchored to the block start (allowing leading whitespace) so a slash inside a sentence — a date,
 * a path, "and/or" — never opens the menu. The query stops at the first character that could not be
 * part of a label, which is what closes the menu when someone types a real slash-separated word.
 */
const SLASH_TRIGGER = /^\s*\/([\w-]*)$/;

export function matchSlashTrigger(blockTextBeforeCursor: string): string | null {
  const match = SLASH_TRIGGER.exec(blockTextBeforeCursor);
  if (!match) return null;
  const query = match[1] ?? "";
  return query.length > SLASH_QUERY_MAX_LENGTH ? null : query;
}

export function filterSlashCommands(
  commands: readonly SlashCommand[],
  rawQuery: string,
): SlashCommand[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [...commands];
  return commands.filter((command) =>
    [command.label, ...command.aliases].join(" ").toLowerCase().includes(query),
  );
}

/** Wrap the index so arrowing past either end lands on the other, with no rows to land on handled. */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/**
 * Delete the typed trigger, then run the block command.
 *
 * One chain rather than two so the whole thing is a single undo step — otherwise undoing a block
 * insertion leaves the bare `/heading` text behind, which reads as the app half-listening.
 */
export function runSlashCommand(
  editor: Editor,
  trigger: SlashTrigger,
  command: SlashCommand,
): void {
  editor.chain().focus().deleteRange({ from: trigger.from, to: trigger.to }).run();
  command.run(editor);
}

/**
 * Read the trigger out of the live selection, or null when the menu should be closed.
 *
 * Every path that is not a trigger returns null rather than leaving the previous state alone, so an
 * open menu closes the moment the cursor leaves it — clicking away, selecting a range, or typing
 * the character that breaks the match.
 */
export function readSlashMenuState(editor: Editor, shell: HTMLElement | null): SlashMenuState | null {
  if (!shell || !editor.isEditable || editor.view.composing) return null;

  const { selection } = editor.state;
  if (!selection.empty) return null;

  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;
  // Inside a code block a slash is code, not a command.
  if ($from.parent.type.spec.code) return null;

  const before = $from.parent.textBetween(0, $from.parentOffset, "\0", "\0");
  const query = matchSlashTrigger(before);
  if (query === null) return null;

  const slashOffset = before.lastIndexOf("/");
  const from = selection.from - ($from.parentOffset - slashOffset);
  const caret = editor.view.coordsAtPos(selection.from);
  const bounds = shell.getBoundingClientRect();

  return {
    query,
    from,
    to: selection.from,
    left: caret.left - bounds.left,
    top: caret.bottom - bounds.top + 6,
  };
}
