import { cx } from "../ui.js";
import type { Mention, MentionMenuState } from "./mentions.js";

/** The `@` menu (design turn 227c): the slash menu's popover, with a face where a sheet has one. */
export function MentionMenu({ menu, rows, selected, onHover, onPick }: {
  menu: MentionMenuState;
  rows: Mention[];
  selected: number;
  onHover: (index: number) => void;
  onPick: (mention: Mention) => void;
}) {
  let group: string | null = null;
  return (
    <div className="fy-slash fy-mention" style={{ left: menu.left, top: menu.top }} role="listbox" aria-label="Names">
      {rows.length === 0 ? (
        <div className="fy-slash__empty">No names match</div>
      ) : (
        rows.map((row, index) => {
          // Places sit under a rule, not a heading of their own (R-18).
          const rule = row.group === "Places" && group !== null && group !== "Places";
          const heading = row.group !== group && row.group !== "Places" ? row.group : null;
          group = row.group;
          return (
            <div key={`${row.group}:${row.id}`}>
              {rule && <hr className="fy-slash__rule" />}
              {heading && <div className="fy-slash__group">{heading}</div>}
              <button
                type="button"
                role="option"
                aria-selected={index === selected}
                className={cx("fy-slash__row", index === selected && "is-active")}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHover(index)}
                onClick={() => onPick(row)}
              >
                <span className={cx("fy-mention__face", row.group === "Places" && "fy-mention__face--place")} aria-hidden="true">
                  {row.face ? <img src={row.face} alt="" /> : row.name.slice(0, 1)}
                </span>
                {row.name}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
