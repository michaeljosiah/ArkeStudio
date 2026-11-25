import { BEFORE_SHOT_NAMES, beforeShotCount, type BeforeShotCheck } from "@arke-studio/contracts";
import { usePopover } from "./menu.js";
import { Button } from "./ui.js";

/**
 * A shot's checks before it is made (design turns 287 and 288b): the count beside the press it
 * holds, drawn as the take's own count is, and the list it opens. A row to fix has its way past:
 * Fix asks Arke for the change, and a board to make with its shots has its own press. The list
 * labels and gives its figure; it explains nothing.
 */
export function BeforeShotChecks({ items, onFix, onBoard, onAnyway }: {
  items: readonly BeforeShotCheck[];
  /** Ask Arke to fix one item; absent where there is no Arke to ask. */
  onFix?: ((item: BeforeShotCheck) => void) | undefined;
  /** Make the shot with its board, as one clip. */
  onBoard?: (() => void) | undefined;
  /** Go on to the press although hard items are still to fix. */
  onAnyway: () => void;
}) {
  const { open, setOpen, press, panel } = usePopover();
  if (items.length === 0) return null;
  const count = beforeShotCount(items);
  return (
    <span className="fy-takechecks fy-shotchecks">
      <button ref={press} type="button" className={`fy-takechip fy-takechecks__count${open ? " fy-takechip--on" : ""}`} aria-expanded={open}
        onClick={() => setOpen((was) => !was)}>
        <span className={`fy-dot fy-dot--${count.passed === count.of ? "ok" : "warn"}`} />
        {`Checks · ${count.passed} of ${count.of}`}
      </button>
      {open && (
        <div ref={panel} className="fy-takechecks__panel fy-shotchecks__panel" role="group" aria-label="Before the shot">
          <div className="fy-takechecks__head">Before the shot</div>
          <div className="fy-takechecks__list">
            {items.map((item) => (
              <div key={item.id} className="fy-takechecks__row" data-result={item.result}>
                <span className={`fy-dot fy-dot--${item.result === "pass" ? "ok" : "warn"}`} />
                <span className="fy-takechecks__label">{BEFORE_SHOT_NAMES[item.id]}</span>
                <span className="fy-takechecks__result">{item.says}</span>
                {item.result === "fix" && item.id === "board" && onBoard
                  ? <Button variant="outline" size="sm" onClick={() => { setOpen(false); onBoard(); }}>Make the board</Button>
                  : item.result === "fix" && item.id !== "board" && onFix
                    ? <Button variant="outline" size="sm" onClick={() => { setOpen(false); onFix(item); }}>Fix</Button>
                    : null}
              </div>
            ))}
          </div>
          {count.hardToFix > 0 && (
            <div className="fy-takechecks__foot">
              <Button variant="outline" size="sm" onClick={() => { setOpen(false); onAnyway(); }}>Open anyway</Button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
