import { CUT_CHECK_NAMES, cutChecksCount, type CutCheck } from "@arke-studio/contracts";
import { usePopover } from "./menu.js";
import { Button } from "./ui.js";

/**
 * A cut's checks (design turns 287 and 288d): the count beside Export film, drawn as the take's
 * and the shot's counts are, and the list it opens under it. A row to fix can show the clip it is
 * about. Nothing here holds Export: the list is what a person would otherwise find by watching,
 * and a film may be exported with something still to fix. It labels and gives its figure; it
 * explains nothing, and a cut with nothing to read has no count at all.
 */
export function CutChecks({ items, onShow }: {
  items: readonly CutCheck[];
  /** Bring the playhead to a clip a fix is about. */
  onShow?: ((clipId: string) => void) | undefined;
}) {
  const { open, setOpen, press, panel } = usePopover();
  if (items.length === 0) return null;
  const count = cutChecksCount(items);
  return (
    <span className="fy-takechecks fy-cutchecks">
      <button ref={press} type="button" className={`fy-takechip fy-takechecks__count${open ? " fy-takechip--on" : ""}`} aria-expanded={open}
        onClick={() => setOpen((was) => !was)}>
        <span className={`fy-dot fy-dot--${count.toFix === 0 ? "ok" : "warn"}`} />
        {`Checks · ${count.passed} of ${count.of}`}
      </button>
      {open && (
        <div ref={panel} className="fy-takechecks__panel fy-cutchecks__panel" role="group" aria-label="On the cut">
          <div className="fy-takechecks__head">On the cut</div>
          <div className="fy-takechecks__list">
            {items.map((item) => {
              const first = item.result === "fix" ? item.clipIds?.[0] : undefined;
              return (
                <div key={item.id} className="fy-takechecks__row" data-result={item.result}>
                  <span className={`fy-dot fy-dot--${item.result === "pass" ? "ok" : "warn"}`} />
                  <span className="fy-takechecks__label">{CUT_CHECK_NAMES[item.id]}</span>
                  <span className="fy-takechecks__result">{item.says}</span>
                  {first !== undefined && onShow
                    ? <Button variant="outline" size="sm" onClick={() => { setOpen(false); onShow(first); }}>Show</Button>
                    : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </span>
  );
}
