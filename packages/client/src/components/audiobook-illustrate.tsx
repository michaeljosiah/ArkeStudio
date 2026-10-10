import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatRunningTime, frameWord, illustrationRowGoes, illustrationTotal, pacePhrase, priceLabel, type IllustrationRow, type PictureWho } from "@arke-studio/contracts";
import { dismissIllustration, illustrateChapter, skipIllustrationRow, sendIllustrationWithout, stopIllustration, acceptIllustration, useIllustrationRuns, type IllustrationRun } from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { PageSheet } from "./page-sheet.js";
import { Button, cx } from "./ui.js";

/**
 * Illustrate this chapter (design turn 191b, 191d, 193h, 193j, SPEC-047 R-101, R-102): where the
 * pictures go and what each shows, dashed on the blocks until accepted. The proposal is read in a
 * sheet over the main area (193): a grid of cards, each with its time, the block's words, a short
 * title and who is in it; Skip and Put back on each, a held row amber with Make a look, one
 * Accept with the total. Closing the sheet keeps the proposal. The dock keeps a line of status and
 * nothing else: it was 250 wide and the rows wrapped a word to a line. Accept is the price of what
 * is left, confirmed once; the pictures are then made one at a time and filed on their blocks as
 * they land, counted in the status, and Stop keeps what is made.
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
      // While they are made, a row held — for a missing reference, or refused last time — or skipped is not on its way.
      const held = run.state === "making" && !illustrationRowGoes(row, new Set(), new Set(run.without));
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

/**
 * Whether the sheet is open (193h): it opens when a proposal arrives in this window and again
 * when a run that was made one at a time hands back what is left, and `Close` puts it away while
 * the proposal stays held — dashed on the blocks and one press from the dock's status. A proposal
 * already held when the window opens stays put away until it is asked for.
 */
export function useIllustrationSheet(run: IllustrationRun | undefined): { open: boolean; show: () => void; hide: () => void } {
  const key = run?.state === "proposed" && run.proposal !== undefined ? `${run.proposal.proposalId}:${run.progress?.state ?? ""}` : null;
  const seen = useRef(key);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (key !== seen.current) {
      seen.current = key;
      setOpen(key !== null);
    }
  }, [key]);
  return { open: open && key !== null, show: () => setOpen(true), hide: () => setOpen(false) };
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

/** Spent so far, as a price a person reads: `$0.11`, no tilde — it is no estimate. */
const spent = (microUsd: number) => priceLabel(microUsd).replace("~", "");

/**
 * What the dock says of the run (193): one line, and the press that line needs. The proposal itself
 * is the sheet's; a closed sheet is one `Review` away.
 */
export function IllustrationStatus({ run, onReview, onStop, onDiscard }: { run: IllustrationRun; onReview: () => void; onStop: () => void; onDiscard: () => void }) {
  const proposal = run.proposal;
  const line = (state: string, text: string, press: ReactNode, extra?: ReactNode) => (
    <section className="fy-ab__card fy-illst" data-testid="illustration-status" data-state={state}>
      <p className="fy-mono fy-illst__line" data-testid={state === "making" ? "illustration-progress" : "illustration-line"}>
        <b>Illustrate</b>
        <span>{text}</span>
      </p>
      {press}
      {extra}
    </section>
  );
  if (run.state === "reading") return line("reading", "reading…", null);
  if (run.state === "failed" || run.state === "unavailable" || proposal === undefined) {
    return line(run.state, run.reason ?? (run.state === "done" ? "illustrated" : "stopped"), <Button variant="ghost" onClick={onDiscard}>Discard</Button>);
  }
  const progress = run.progress;
  if (run.state === "making" && progress !== undefined) {
    return line(
      "making",
      `making pictures · ${progress.made.length} of ${progress.total} · ${proposal.model.plan ? priceLabel(0, proposal.model.plan) : `${spent(progress.spentMicroUsd)} of ${priceLabel(progress.confirmedMicroUsd)}`}`,
      <Button variant="secondary" onClick={onStop} data-testid="illustration-stop">Stop</Button>,
      <div className="fy-ill__bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.made.length}>
        <i style={{ width: `${progress.total === 0 ? 0 : Math.round((progress.made.length / progress.total) * 100)}%` }} />
      </div>,
    );
  }
  if (run.state === "done" || run.state === "stopped") {
    return line(run.state, `${run.state === "stopped" ? "stopped" : "✓ illustrated"} · ${progress?.made.length ?? 0} picture${progress?.made.length === 1 ? "" : "s"}`, <Button variant="primary" onClick={onDiscard}>Done</Button>);
  }
  const total = illustrationTotal(proposal.rows, new Set(run.skipped), new Set(run.without));
  return line(
    "proposed",
    `${proposal.rows.length} picture${proposal.rows.length === 1 ? "" : "s"} · ${priceLabel(total.microUsd, proposal.model.plan)}`,
    <Button variant="ghost" onClick={onReview} data-testid="illustration-review">Review</Button>,
  );
}

/** One person in a card: their picture beside the name, a dashed square where they have none. */
function Face({ who, slug }: { who: PictureWho; slug: string }) {
  return who.reference === null ? <i className="fy-ills__fig fy-ills__fig--none" aria-hidden="true" /> : <img className={cx("fy-ills__fig", !who.carried && "fy-ills__fig--over")} src={mediaUrl(slug, who.reference)} alt="" />;
}

function Card({ row, estimated, words, skipped, without, reason, slug, disabled, onSkip, onWithout, onMakeLook }: {
  row: IllustrationRow;
  estimated: boolean;
  words: string | undefined;
  skipped: boolean;
  without: boolean;
  reason: string | undefined;
  slug: string;
  disabled: boolean;
  onSkip: () => void;
  onWithout: () => void;
  onMakeLook: (who: PictureWho) => void;
}) {
  const held = (row.needs?.length ?? 0) > 0 && !without;
  // A picture a run could not make (2026-10-04): held with its reason, made again only on Try again.
  const refused = !held && row.refused !== undefined && !without;
  const said = row.refused ?? reason;
  const people = row.who.filter((entry) => entry.kind === "character");
  const lacking = people.find((entry) => entry.sheet !== undefined && entry.reference === null);
  const time = clock(row.at, estimated);
  // The frame word in the slot's corner (193h, rule 11): what the brief said the picture is.
  const frame = row.shot === undefined ? null : (frameWord(row.shot.frame) ?? (row.shot.frame === "" ? null : row.shot.frame));
  return (
    <article className={cx("fy-ills__card", skipped && "fy-ills__card--off", (held || refused) && !skipped && "fy-ills__card--held")} data-testid="illustration-row" data-block={row.block} data-state={skipped ? "skipped" : held ? "held" : refused ? "refused" : "ready"}>
      <div className="fy-ills__th">
        {frame !== null && <span className="fy-mono fy-ills__frame" data-testid="illustration-frame" title={row.shot?.frame}>{frame}</span>}
        <span className="fy-mono fy-ills__tm">{time}</span>
        <p className="fy-ills__words">{words ?? row.title}</p>
        <span className="fy-ills__figs" aria-hidden="true">{people.map((entry) => <Face key={entry.key} who={entry} slug={slug} />)}</span>
      </div>
      <div className="fy-ills__hd">
        <span className="fy-ills__t">
          <b>{row.title}</b>
          <span className="fy-mono fy-ills__meta">{frame !== null ? `${frame} · ${time}` : time}</span>
        </span>
        {held && !skipped ? (
          <Button variant="ghost" disabled={disabled || lacking === undefined} onClick={() => lacking !== undefined && onMakeLook(lacking)} data-testid="illustration-needs">
            Make a look
          </Button>
        ) : (
          <Button variant="ghost" disabled={disabled} onClick={onSkip} data-testid="illustration-skip">
            {skipped ? "Put back" : "Skip"}
          </Button>
        )}
      </div>
      <div className="fy-ills__wh">
        {people.map((entry) => (
          <span className="fy-ills__who" key={entry.key} data-testid="illustration-who">
            <Face who={entry} slug={slug} />
            {entry.name}
            {entry.reference === null && <span className="fy-ills__note">{without ? "sent without" : entry.sheet === undefined ? "identity not linked · check the character" : "no look"}</span>}
          </span>
        ))}
        {people.length === 0 && <span className="fy-ills__note">{row.who.length > 0 ? "place only" : "no reference rides"}</span>}
        {held && !skipped && (
          <Button variant="ghost" disabled={disabled} onClick={onWithout} data-testid="illustration-without">
            Without
          </Button>
        )}
      </div>
      {said !== undefined && (
        <div className="fy-ills__wh">
          <p className="fy-mono fy-ch__who-where--warn" data-testid="illustration-row-reason">{said}</p>
          {row.refused !== undefined && !skipped && (
            <Button variant="ghost" disabled={disabled} onClick={onWithout} data-testid="illustration-retry">
              {without ? "Hold" : "Try again"}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * The proposal as a sheet over the main area (193h, 193j): a grid of cards, four across where the
 * room allows, two between 600 and 1099 and one list on a phone with Accept held at the foot.
 * `onMakeLook` is the held row's one action; the default sends a person to the character's page,
 * where the picture a look is made from lives.
 */
export function IllustrationSheet({ run, chapterOrder, slug, wordsOf, onAccept, onDiscard, onSkip, onWithout, onMakeLook, onAgain, onClose, onLook, offline }: {
  run: IllustrationRun;
  chapterOrder: number;
  slug: string;
  wordsOf: (block: string) => string | undefined;
  onAccept: () => void;
  onDiscard: () => void;
  onSkip: (block: string) => void;
  onWithout: (block: string) => void;
  onMakeLook: (who: PictureWho) => void;
  onAgain: () => void;
  onClose: () => void;
  onLook: () => void;
  offline: boolean;
}) {
  const proposal = run.proposal;
  if (proposal === undefined) return null;
  const skipped = new Set(run.skipped);
  const total = illustrationTotal(proposal.rows, skipped, new Set(run.without));
  const reasons = new Map((run.progress?.failed ?? []).map((entry) => [entry.block, entry.reason]));
  const per = proposal.rows.length === 0 ? proposal.seconds : proposal.seconds / (proposal.rows.length + proposal.standing);
  const count = `${proposal.rows.length} picture${proposal.rows.length === 1 ? "" : "s"}`;
  const headline = [
    count,
    pacePhrase(per),
    `${total.count} to make`,
    ...(skipped.size > 0 ? [`${skipped.size} skipped`] : []),
    ...(total.held > 0 ? [`${total.held} need${total.held === 1 ? "s" : ""} a look`] : []),
    ...(total.refused > 0 ? [`${total.refused} refused`] : []),
  ].join(" · ");
  const ended = run.progress !== undefined && run.progress.state !== "making" ? run.progress : undefined;
  return (
    <PageSheet preserveReturnFocus open title={`Illustrate · Chapter ${chapterOrder}`} onClose={onClose} className="fy-ills-modal" headless>
      <div className="fy-ills" data-testid="illustration-sheet">
        <section className="fy-ills__sheet" data-state="proposed">
          <header className="fy-ills__head">
            <h3 id="fy-ills-title" tabIndex={-1}>Illustrate · Chapter {chapterOrder}</h3>
            <span className="fy-mono fy-ills__sum" data-testid="illustration-headline">{headline}</span>
            <span className="fy-mono fy-ills__short">{total.count} · {priceLabel(total.microUsd, proposal.model.plan)}</span>
            <span className="fy-ills__push" />
            <Button variant="secondary" className="fy-ills__again" disabled={offline} onClick={onAgain} data-testid="illustration-again">Illustrate again</Button>
            <Button variant="secondary" onClick={onClose} data-testid="illustration-close">Close</Button>
          </header>
          {ended !== undefined && (
            <p className="fy-mono fy-ab__card-line" data-testid="illustration-ended">
              {ended.state === "stopped" ? "stopped" : "made"} · {ended.made.length} of {ended.total}
              {ended.failed.length > 0 ? ` · ${ended.failed.length} held` : ""}
            </p>
          )}
          <div className="fy-ills__grid">
            {proposal.rows.map((row) => (
              <Card
                key={row.block}
                row={row}
                estimated={proposal.estimated}
                words={wordsOf(row.block)}
                skipped={skipped.has(row.block)}
                without={run.without.includes(row.block)}
                reason={reasons.get(row.block)}
                slug={slug}
                disabled={offline}
                onSkip={() => onSkip(row.block)}
                onWithout={() => onWithout(row.block)}
                onMakeLook={onMakeLook}
              />
            ))}
          </div>
          {run.reason !== undefined && <p className="fy-mono fy-ch__who-where--warn" data-testid="illustration-refused">{run.reason}</p>}
          <footer className="fy-ills__foot">
            <Button variant="ghost" className="fy-ills__read" onClick={onLook} data-testid="illustration-look">Read: chapter, cast, looks, art direction</Button>
            <span className="fy-ills__push" />
            <Button variant="ghost" onClick={onDiscard} data-testid="illustration-discard">Discard</Button>
            <Button variant="primary" disabled={offline || total.count === 0} onClick={onAccept} data-testid="illustration-accept">
              Accept · {priceLabel(total.microUsd, proposal.model.plan)}
            </Button>
          </footer>
        </section>
      </div>
    </PageSheet>
  );
}
