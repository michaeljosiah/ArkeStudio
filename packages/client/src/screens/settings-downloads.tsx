import { useNavigate } from "react-router";
import {
  componentIsSettled,
  transferProgress,
  type SetupComponent,
  type TransferProgress,
} from "@arke-studio/contracts";
import { Button, cx } from "../components/ui.js";
import { setupCancel, setupRemove, setupRepair, setupRetry, setupSkip, useSetup } from "../lib/store.js";
import { RuntimeHead, RuntimeSection, RuntimeStatus, sizeMb } from "./settings-parts.js";

/**
 * Settings · Downloads (SPEC-033 §1.13). One surface for everything being fetched, whichever
 * capability or engine started it.
 *
 * Every category used to invent downloading for itself, and nothing showed all of them at once.
 * Video weights make that expensive: a fetch worth tens of gigabytes deserves a place it can be
 * watched, retried and abandoned that is not the screen you happened to start it from.
 *
 * **Downloads owns progress** (R-82). A capability row renders the same projection —
 * `transferProgress` — rather than computing its own, because two independently derived figures
 * for one transfer is precisely the duplication `statedElsewhere` existed to paper over, and R-6
 * deleted that mechanism, so nothing is left to resolve a disagreement between them.
 *
 * Reachable from Providers, unconditionally, and owned by it no more than it was owned by
 * the two screens Providers absorbed (SPEC-034 R-25, amending SPEC-033 R-84).
 */

/** In flight, or waiting its turn, or stopped mid-way — everything with an outstanding transfer. */
function isMoving(component: SetupComponent): boolean {
  return component.state === "downloading" || component.state === "installing" || component.state === "queued";
}

/** Needs a hand: it failed, or the disk refused it. */
function needsAttention(component: SetupComponent): boolean {
  return component.state === "failed" || component.state === "blocked";
}

function ProgressRow({ component, progress }: { component: SetupComponent; progress: TransferProgress }) {
  return (
    <div className="fy-set__row fy-set__row--stack" data-testid="download-row">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="fy-set__name fy-set__name--wide">
          <div className="fy-set__title">{component.displayName}</div>
          <div className="fy-set__caps">
            {component.purpose} · {sizeMb(component.sizeMb)}
          </div>
        </div>
        <RuntimeStatus tone={needsAttention(component) ? "warn" : componentIsSettled(component.state) ? "ok" : "idle"}>
          {progress.active
            ? `${progress.percent}%${progress.mbPerSecond === null ? "" : ` · ${progress.mbPerSecond} MB/s`}`
            : (component.leftovers?.length ?? 0) > 0 && !componentIsSettled(component.state)
              ? `${component.leftovers!.length} file${component.leftovers!.length === 1 ? "" : "s"}`
              : component.state}
        </RuntimeStatus>
        {/* Only what is still waiting can be taken out of the queue. A transfer already
            streaming cannot be stopped one component at a time — the run holds one abort — so a
            per-row Stop would be a word the code does not honour. Stop all is the one that acts. */}
        {component.state === "queued" && (
          <button type="button" className="fy-set__link" onClick={() => setupSkip(component.id)}>
            Skip
          </button>
        )}
        {needsAttention(component) &&
          (component.repairRequired === true ? (
            <button type="button" className="fy-set__link" onClick={() => setupRepair(component.id)}>
              Repair
            </button>
          ) : (
            <button type="button" className="fy-set__link" onClick={() => setupRetry(component.id)}>
              Retry
            </button>
          ))}
        {componentIsSettled(component.state) && component.removable === true && (
          <button type="button" className="fy-set__link" onClick={() => setupRemove(component.id)}>
            Remove
          </button>
        )}
        {/* Reclaim is Remove, tried again on what would not go the first time — the same
            best-effort deletion, which is why a survivor stays actionable rather than becoming
            a line of text about a file nobody can now do anything about (R-45, R-85). */}
        {(component.leftovers?.length ?? 0) > 0 && !componentIsSettled(component.state) && (
          <button type="button" className="fy-set__link" onClick={() => setupRemove(component.id)}>
            Reclaim
          </button>
        )}
      </div>
      {progress.active && (
        <div className="fy-set__bar">
          <div className="fy-set__barfill" style={{ width: `${progress.percent}%` }} />
        </div>
      )}
      {component.detail !== undefined && (
        <div className="fy-set__why">
          <span className={cx("fy-set__dot", needsAttention(component) && "fy-set__dot--warn")} />
          <span>{component.detail}</span>
        </div>
      )}
      {/* What a cancelled or failed install left behind, named with its path and its size, and
          still reclaimable. `Nothing remains` is a promise no implementation can keep on a
          platform where a scanner holds a file open — and one every implementation would make. */}
      {component.leftovers?.map((leftover) => (
        <div key={leftover.path} className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>
            {leftover.path} · {sizeMb(leftover.sizeMb)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SettingsDownloadsScreen() {
  const setup = useSetup();
  const navigate = useNavigate();
  const components = setup?.components ?? [];
  // Four sections, and a component is in exactly one of them: a row that appears twice is a
  // transfer somebody has to reconcile by eye, which is the whole thing this screen removes.
  const moving = components.filter(isMoving);
  const attention = components.filter(needsAttention);
  const leftovers = components.filter(
    (c) => (c.leftovers?.length ?? 0) > 0 && !needsAttention(c) && !isMoving(c) && !componentIsSettled(c.state),
  );
  const installed = components.filter((c) => componentIsSettled(c.state));
  const remaining = moving.reduce((sum, c) => sum + Math.max(0, c.sizeMb - transferProgress(c).doneMb), 0);

  return (
    <div data-screen="settings-downloads" className="fy-set">
      <RuntimeHead
        title="Downloads"
        caps={setup?.diskFreeMb == null ? "" : `${sizeMb(setup.diskFreeMb)} FREE`}
        tone={attention.length > 0 ? "warn" : moving.length > 0 ? "idle" : "ok"}
        state={moving.length === 0 ? "nothing in flight" : `${moving.length} · ${sizeMb(remaining)} to go`}
      />
      {moving.length > 0 && (
        <>
          <RuntimeSection label="IN FLIGHT">
            <button type="button" className="fy-set__link" onClick={() => setupCancel()}>
              Stop all
            </button>
          </RuntimeSection>
          {moving.map((c) => (
            <ProgressRow key={c.id} component={c} progress={transferProgress(c)} />
          ))}
        </>
      )}
      {attention.length > 0 && (
        <>
          <RuntimeSection label="NEEDS ATTENTION" />
          {attention.map((c) => (
            <ProgressRow key={c.id} component={c} progress={transferProgress(c)} />
          ))}
        </>
      )}
      {leftovers.length > 0 && (
        <>
          <RuntimeSection label="LEFT BEHIND" />
          {leftovers.map((c) => (
            <ProgressRow key={c.id} component={c} progress={transferProgress(c)} />
          ))}
        </>
      )}
      <RuntimeSection label="ON THIS MACHINE">
        <span className="fy-rt__count">{installed.length}</span>
      </RuntimeSection>
      {installed.map((c) => (
        <ProgressRow key={c.id} component={c} progress={transferProgress(c)} />
      ))}
      {/* Reached from Providers and owned by it no more than it was owned by the two screens
          Providers absorbed (SPEC-034 R-25). One way back, because there is now one place to
          go. */}
      <div className="fy-set__actions">
        <Button variant="secondary" onClick={() => navigate("/settings/providers")}>
          Providers
        </Button>
      </div>
    </div>
  );
}
