import { Home } from "../icons.js";
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
          // No headings (R-18, 227c): speakers, then the other characters, then places under a rule.
          const rule = row.group === "Places" && group !== null && group !== "Places";
          group = row.group;
          return (
            <div key={`${row.group}:${row.id}`}>
              {rule && <hr className="fy-slash__rule" />}
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
                  {row.face ? <img src={row.face} alt="" /> : row.group === "Places" ? <Home size={15} /> : row.name.slice(0, 1)}
                </span>
                <span className="fy-mention__who">
                  {row.name}
                  {row.sub !== undefined && row.sub !== "" && <small>{row.sub}</small>}
                </span>
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
