import type { Editor } from "@tiptap/core";
import {
  CodeMark,
  Divider,
  Heading,
  ListBullet,
  ListCheck,
  ListOrdered,
  Quote,
  TableMark,
  TextMark,
} from "../icons.js";
import { cx } from "../ui.js";
import { runSlashCommand, type SlashCommand, type SlashMenuState } from "./slash-commands.js";

/**
 * Art kept out of the catalogue so `slash-commands.ts` stays free of React and testable as plain
 * data. A row without a drawing falls back to the paragraph mark rather than to nothing.
 */
const ICONS: Record<string, typeof TextMark> = {
  paragraph: TextMark,
  "heading-1": Heading,
  "heading-2": Heading,
  "heading-3": Heading,
  "bullet-list": ListBullet,
  "ordered-list": ListOrdered,
  "task-list": ListCheck,
  blockquote: Quote,
  "code-block": CodeMark,
  table: TableMark,
  divider: Divider,
};

interface SlashMenuProps {
  editor: Editor;
  menu: SlashMenuState;
  commands: SlashCommand[];
  selected: number;
  onHover: (index: number) => void;
}

export function SlashMenu({ editor, menu, commands, selected, onHover }: SlashMenuProps) {
  let group: string | null = null;

  return (
    <div
      className="fy-slash"
      style={{ left: menu.left, top: menu.top }}
      role="listbox"
      aria-label="Blocks"
    >
      {commands.length === 0 ? (
        <div className="fy-slash__empty">No blocks match</div>
      ) : (
        commands.map((command, index) => {
          const heading = command.group !== group ? command.group : null;
          group = command.group;
          const Icon = ICONS[command.id] ?? TextMark;
          return (
            <div key={command.id}>
              {heading && <div className="fy-slash__group">{heading}</div>}
              <button
                type="button"
                role="option"
                aria-selected={index === selected}
                className={cx("fy-slash__row", index === selected && "is-active")}
                // Taking focus would collapse the selection the command is about to act on.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHover(index)}
                onClick={() => runSlashCommand(editor, menu, command)}
              >
                <span className="fy-slash__icon">
                  <Icon size={15} />
                </span>
                {command.label}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
