import { currentTakeChecks, takeChecksCount, takeIsCheckable, TAKE_CHECK_NAMES, type ProductionBundle, type Take } from "@arke-studio/contracts";
import { useEffect, useState } from "react";
import { checkTake, subscribeCommandFailures } from "../lib/store.js";
import { usePopover } from "./menu.js";
import { Button } from "./ui.js";

/**
 * A take's checks (design turns 287 and 288c): the count beside its verdicts, drawn as the shot
 * chips are, and the list it opens over the take. A take with none, or with checks of other media,
 * has Check. The list labels and gives its figure; it explains nothing.
 */
export function TakeChecks({ worldId, production, take }: { worldId: string; production: ProductionBundle; take: Take }) {
  const record = currentTakeChecks(production.takeChecks, take);
  // The toolbar's popover: open on the count, closed by Escape or a press outside both.
  const { open, setOpen, press, panel } = usePopover();
  const [checking, setChecking] = useState(false);
  // A new record ends the wait, and so does this command's refusal (which the toaster says).
  useEffect(() => setChecking(false), [record?.ts]);
  useEffect(() => subscribeCommandFailures((failure) => { if (failure.command === "check-take") setChecking(false); }), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setOpen(false); setChecking(false); }, [take.id]);
  if (!takeIsCheckable(take)) return null;
  const check = () => setChecking(checkTake(worldId, production.meta.id, take.id));
  if (!record) {
    return <Button variant="ghost" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check"}</Button>;
  }
  const count = takeChecksCount(record);
  return (
    <span className="fy-takechecks">
      <button ref={press} type="button" className={`fy-takechip fy-takechecks__count${open ? " fy-takechip--on" : ""}`} aria-expanded={open}
        onClick={() => setOpen((was) => !was)}>
        <span className={`fy-dot fy-dot--${count.passed === count.of ? "ok" : "warn"}`} />
        {`Checks · ${count.passed} of ${count.of}`}
      </button>
      {open && (
        <div ref={panel} className="fy-takechecks__panel" role="group" aria-label="After the take">
          <div className="fy-takechecks__head">After the take</div>
          <div className={`fy-takechecks__list${record.items.length > 3 ? " fy-takechecks__list--two" : ""}`}>
            {record.items.map((item) => (
              <div key={item.id} className="fy-takechecks__row" data-result={item.result}>
                <span className={`fy-dot fy-dot--${item.result === "pass" ? "ok" : "warn"}`} />
                <span className="fy-takechecks__label">{TAKE_CHECK_NAMES[item.id]}</span>
                <span className="fy-takechecks__result">{item.says}</span>
              </div>
            ))}
          </div>
          <div className="fy-takechecks__foot">
            <Button variant="outline" size="sm" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check again"}</Button>
          </div>
        </div>
      )}
    </span>
  );
}
