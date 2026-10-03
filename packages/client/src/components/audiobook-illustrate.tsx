import { useMemo } from "react";
import { formatRunningTime, illustrationTotal, pacePhrase, priceLabel, type IllustrationRow, type PictureWho } from "@arke-studio/contracts";
import { dismissIllustration, illustrateChapter, skipIllustrationRow, sendIllustrationWithout, stopIllustration, acceptIllustration, useIllustrationRuns, type IllustrationRun } from "../lib/store.js";
import { Button, cx } from "./ui.js";

/**
 * Illustrate this chapter (design turn 191b, 191d, SPEC-047 R-101, R-102): where the pictures go
 * and what each shows, dashed on the blocks until accepted and listed in a card with its time, a
 * short title and who is in it — the way `Direct this chapter` is read (184). Each row can be
 * skipped; a row with a character who has no picture is held, `Needs a reference`. Accept is the
 * price of what is left, confirmed once; the pictures are then made one at a time and filed on
 * their blocks as they land, counted in the card, and Stop keeps what is made.
 */

/** The state a chapter's head and blocks need of the proposal. */
export function useIllustration(worldId: string, productionId: string, chapter: { id: string; file: string }) {
  const run = useIllustrationRuns()[`${worldId}/${productionId}/${chapter.id}`];
  // What the blocks draw dashed: each proposed row, until it is accepted and made — or skipped.
  const proposed = useMemo(() => {
    const marks = new Map<string, { title: string }>();
    if (run?.proposal === undefined || (run.state !== "proposed" && run.state !== "making")) return marks;
    const made = new Set(run.progress?.made ?? []);
    for (const row of run.proposal.rows) {
      // While they are made, a row held for a missing reference or skipped is not on its way.
      const held = run.state === "making" && (row.needs?.length ?? 0) > 0 && !run.without.includes(row.block);
      if (!made.has(row.block) && !run.skipped.includes(row.block) && !held) marks.set(row.block, { title: row.title });
    }
    return marks;
  }, [run]);
  return {
    run,
    proposed,
    busy: run?.state === "reading" || run?.state === "making",
    press: () => illustrateChapter(worldId, productionId, chapter.file),
    accept: () => acceptIllustration(worldId, productionId, chapter.id, chapter.file),
    stop: () => stopIllustration(worldId, productionId, chapter.file),
    discard: () => dismissIllustration(worldId, productionId, chapter.id, chapter.file),
    skip: (block: string) => skipIllustrationRow(worldId, productionId, chapter.id, block),
    without: (block: string) => sendIllustrationWithout(worldId, productionId, chapter.id, block),
  };
}

/** The margin's dashed chip (191b): a picture proposed for the block, by its short title, until it is accepted. */
export function ProposedChip({ title }: { title: string }) {
  return (
    <span className="fy-ab__picchip fy-ab__picchip--prop" data-testid="illustration-chip">
      <i aria-hidden="true" />
      {title}
    </span>
  );
}

const clock = (seconds: number, estimated: boolean) => `${estimated ? "~" : ""}${formatRunningTime(seconds)}`;
/** `Maren, Odile`, and `Sereth · no reference` for the ones with a sheet and no picture (191b). */
const whoLine = (row: Pick<IllustrationRow, "who" | "needs">): string => {
  const lacking = row.needs ?? [];
  const have = row.who.filter((entry) => !lacking.includes(entry.name)).map((entry) => entry.name);
  return [...(have.length > 0 ? [have.join(", ")] : []), ...(lacking.length > 0 ? [`${lacking.join(", ")} · no reference`] : [])].join(" · ");
};

/** Spent so far, as a price a person reads: `$0.11`, no tilde — it is no estimate. */
const spent = (microUsd: number) => priceLabel(microUsd).replace("~", "");

function Row({ row, estimated, skipped, without, reason, onSkip, onWithout, onMake, disabled }: {
  row: IllustrationRow;
  estimated: boolean;
  skipped: boolean;
  without: boolean;
  reason: string | undefined;
  onSkip: () => void;
  onWithout: () => void;
  onMake: (who: PictureWho) => void;
  disabled: boolean;
}) {
  const needs = (row.needs?.length ?? 0) > 0 && !without;
  const missing = row.who.find((entry) => entry.kind === "character" && entry.sheet !== undefined && entry.reference === null);
  return (
    <div className={cx("fy-ill__row", skipped && "fy-ill__row--off")} data-testid="illustration-row" data-block={row.block} data-state={skipped ? "skipped" : needs ? "held" : "ready"}>
      <i className="fy-ill__ph" aria-hidden="true" />
      <span className="fy-ill__t">
        <b>{row.title}</b>
        <span>{whoLine(row)}</span>
        {reason !== undefined && <span className="fy-mono fy-ch__who-where--warn" data-testid="illustration-row-reason">{reason}</span>}
      </span>
      <span className="fy-mono fy-ill__at">{clock(row.at, estimated)}</span>
      {needs ? (
        <span className="fy-ill__acts">
          <Button variant="ghost" disabled={disabled || missing === undefined} onClick={() => missing !== undefined && onMake(missing)} data-testid="illustration-needs">
            Needs a reference
          </Button>
          <Button variant="ghost" disabled={disabled} onClick={onWithout} data-testid="illustration-without">
            Without
          </Button>
        </span>
      ) : (
        <Button variant="ghost" disabled={disabled} onClick={onSkip} data-testid="illustration-skip">
          {skipped ? "Put back" : "Skip"}
        </Button>
      )}
    </div>
  );
}

/** The card (191b, 191d): the proposal as it is read, then the pictures as they are made. */
export function IllustrationCard({ run, onAccept, onDiscard, onStop, onSkip, onWithout, onMakeReference, onLook, offline }: {
  run: IllustrationRun;
  onAccept: () => void;
  onDiscard: () => void;
  onStop: () => void;
  onSkip: (block: string) => void;
  onWithout: (block: string) => void;
  onMakeReference: (who: PictureWho) => void;
  onLook: () => void;
  offline: boolean;
}) {
  const proposal = run.proposal;
  if (run.state === "reading") {
    return (
      <section className="fy-ab__card fy-ill" data-testid="illustration-card" data-state="reading">
        <h3 className="fy-ab__card-title">Illustrate this chapter</h3>
        <p className="fy-mono fy-ab__card-line">reading…</p>
      </section>
    );
  }
  if (run.state === "failed" || run.state === "unavailable" || proposal === undefined) {
    return (
      <section className="fy-ab__card fy-ill" data-testid="illustration-card" data-state={run.state}>
        <h3 className="fy-ab__card-title">Illustrate this chapter</h3>
        <p className="fy-mono fy-ch__who-where--warn">{run.reason ?? (run.state === "done" ? "illustrated" : "stopped")}</p>
        <div className="fy-ab__control">
          <Button variant="ghost" onClick={onDiscard}>
            Discard
          </Button>
        </div>
      </section>
    );
  }
  const progress = run.progress;
  const total = illustrationTotal(proposal.rows, new Set(run.skipped), new Set(run.without));
  if (run.state === "making" && progress !== undefined) {
    const madeRows = proposal.rows.filter((row) => progress.made.includes(row.block));
    const current = progress.current === undefined ? undefined : proposal.rows.find((row) => row.block === progress.current);
    const next = current ?? proposal.rows.find((row) => !progress.made.includes(row.block) && !progress.failed.some((entry) => entry.block === row.block) && !run.skipped.includes(row.block) && ((row.needs?.length ?? 0) === 0 || run.without.includes(row.block)));
    return (
      <section className="fy-ab__card fy-ill" data-testid="illustration-card" data-state="making">
        <h3 className="fy-ab__card-title">Illustrate this chapter</h3>
        <p className="fy-mono fy-ab__card-line" data-testid="illustration-progress">
          making pictures · {progress.made.length} of {progress.total} · {spent(progress.spentMicroUsd)} of {priceLabel(progress.confirmedMicroUsd)}
        </p>
        <div className="fy-ill__bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.made.length}>
          <i style={{ width: `${progress.total === 0 ? 0 : Math.round((progress.made.length / progress.total) * 100)}%` }} />
        </div>
        {madeRows.length > 0 && (
          <div className="fy-ill__line" data-testid="illustration-made">
            <b>Made</b>
            <span>{madeRows.map((row) => row.title).join(" · ")}</span>
          </div>
        )}
        {next !== undefined && (
          <div className="fy-ill__line" data-testid="illustration-next">
            <b>Next</b>
            <span>{next.title}</span>
          </div>
        )}
        <div className="fy-ab__control">
          <span className="fy-ch__panelpush" />
          <Button variant="secondary" onClick={onStop} data-testid="illustration-stop">
            Stop
          </Button>
        </div>
      </section>
    );
  }
  if (run.state === "done" || run.state === "stopped") {
    return (
      <section className="fy-ab__card fy-ill" data-testid="illustration-card" data-state={run.state}>
        <h3 className="fy-ab__card-title">Illustrate this chapter</h3>
        <p className="fy-mono fy-ab__card-line">
          {run.state === "stopped" ? "stopped" : "✓ illustrated"} · {progress?.made.length ?? 0} picture{progress?.made.length === 1 ? "" : "s"}
        </p>
        <div className="fy-ab__control">
          <span className="fy-ch__panelpush" />
          <Button variant="primary" onClick={onDiscard}>
            Done
          </Button>
        </div>
      </section>
    );
  }
  const reasons = new Map((progress?.failed ?? []).map((entry) => [entry.block, entry.reason]));
  const per = proposal.rows.length === 0 ? proposal.seconds : proposal.seconds / (proposal.rows.length + proposal.standing);
  const headline = [
    `proposed · ${proposal.rows.length} picture${proposal.rows.length === 1 ? "" : "s"}`,
    pacePhrase(per),
    priceLabel(total.microUsd),
    ...(total.held > 0 ? [`${total.held} need${total.held === 1 ? "s" : ""} a reference`] : []),
  ].join(" · ");
  const ended = progress !== undefined && progress.state !== "making" ? progress : undefined;
  return (
    <section className="fy-ab__card fy-ill" data-testid="illustration-card" data-state="proposed">
      <h3 className="fy-ab__card-title">Illustrate this chapter</h3>
      <p className="fy-mono fy-ab__card-line" data-testid="illustration-headline">
        {headline}
      </p>
      {ended !== undefined && (
        <p className="fy-mono fy-ab__card-line" data-testid="illustration-ended">
          {ended.state === "stopped" ? "stopped" : "made"} · {ended.made.length} of {ended.total}
          {ended.failed.length > 0 ? ` · ${ended.failed.length} held` : ""}
        </p>
      )}
      <div className="fy-ill__rows">
        {proposal.rows.map((row) => (
          <Row
            key={row.block}
            row={row}
            estimated={proposal.estimated}
            skipped={run.skipped.includes(row.block)}
            without={run.without.includes(row.block)}
            reason={reasons.get(row.block)}
            onSkip={() => onSkip(row.block)}
            onWithout={() => onWithout(row.block)}
            onMake={onMakeReference}
            disabled={offline}
          />
        ))}
      </div>
      {run.reason !== undefined && <p className="fy-mono fy-ch__who-where--warn" data-testid="illustration-refused">{run.reason}</p>}
      <div className="fy-ab__control">
        <Button variant="primary" disabled={offline || total.count === 0} onClick={onAccept} data-testid="illustration-accept">
          Accept · {priceLabel(total.microUsd)}
        </Button>
        <Button variant="ghost" onClick={onDiscard} data-testid="illustration-discard">
          Discard
        </Button>
        <span className="fy-ch__panelpush" />
        <Button variant="ghost" onClick={onLook} data-testid="illustration-look">
          Read chapter, cast, look
        </Button>
      </div>
    </section>
  );
}
