import { useEffect, useRef, useState, type ReactNode } from "react";
import { clockTime, productionShape, ulid, type AudiobookListening, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { usePhone } from "../lib/media-query.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { exportArkePlayer, openAudiobookListening, subscribeArkePlayerExported, subscribeAudiobookListening, useAudiobookRecords, useConnection } from "../lib/store.js";
import { ComicBookRows, comicReady, comicSummary } from "../screens/comic-pages.js";
import { bookChapters, madeStamp, useArkePlayerExport } from "./arke-player-export.js";
import { ArkePlayerMade, type ArkePlayerPackage } from "./arke-player-made.js";
import { wholeChapters } from "./audiobook-video.js";
import { CircleAlert } from "./icons.js";
import { PageSheet } from "./page-sheet.js";

/**
 * Arke Player (design turn 276 rule 7, SPEC-058 R-1, SPEC-064 R-50): the sheet that makes a book's
 * or a graphic novel's package, opened from Publish's Arke Player card. Its rows are each kind's
 * rows as they shipped inside Export audiobook and the comic's Export, which no longer offer it;
 * once made, the one block every kind shows (R-103). An album's and a story's packages are made
 * from their own sheets, which read what their screens hold.
 */
export function ArkePlayerExportSheet({ world, production, onClose, goToPage }: { world: WorldBundle; production: ProductionBundle; onClose: () => void; goToPage: (page: string) => void }) {
  return productionShape(production.meta).hasPages
    ? <ComicPlayer world={world} production={production} onClose={onClose} goToPage={goToPage} />
    : <BookPlayer world={world} production={production} onClose={onClose} />;
}

/** The sheet's chrome, the same for either kind: what it is under the title, and once made, when. */
function Frame({ production, line, made, foot, onClose, children }: { production: ProductionBundle; line: string | null; made: string | null; foot: ReactNode; onClose: () => void; children: ReactNode }) {
  const phone = usePhone();
  return (
    <PageSheet open onClose={onClose} title="Arke Player" subtitle={made === null ? production.meta.title : `${production.meta.title} · ${made}`} preserveReturnFocus footer={foot} className={phone ? "fy-abv-modal fy-abv-modal--phone" : "fy-abv-modal"}>
      <div className={phone ? "fy-abv-psheet" : "fy-abv-sheet"} data-testid="arke-player-sheet">
        {!phone && made === null && line !== null && <div className="fy-abv-sub">{line}</div>}
        {children}
      </div>
    </PageSheet>
  );
}

/** A book's package (turn 233), counted from the listening plan the audiobook's player plays. */
function BookPlayer({ world, production, onClose }: { world: WorldBundle; production: ProductionBundle; onClose: () => void }) {
  const worldId = world.meta.worldId;
  const connection = useConnection();
  const phone = usePhone();
  const asked = useRef<string | null>(null);
  const [plan, setPlan] = useState<AudiobookListening | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => subscribeAudiobookListening((answer) => {
    if (answer.requestId !== asked.current) return;
    setPlan(answer.listening);
    setRefused(answer.refused ?? null);
  }), []);
  // Asked as the sheet opens, and again after a reconnect, which may have lost the answer.
  useEffect(() => {
    if (connection === "open") asked.current = openAudiobookListening(worldId, production.meta.id);
  }, [connection, worldId, production.meta.id]);
  // And a moment after a chapter or its reading moves, as Export audiobook does: a plan is sent only
  // when asked, so narration finished behind the sheet would otherwise leave its counts and its New
  // chapters stale (codex on PR 2984).
  const records = useAudiobookRecords();
  const prefix = `${worldId}/${production.meta.id}/`;
  const stamp = JSON.stringify([
    production.chapters.map((chapter) => [chapter.id, chapter.version, chapter.status, chapter.retired ?? false, chapter.bodyHash, chapter.audiobook]),
    Object.entries(records).filter(([key]) => key.startsWith(prefix)).map(([key, record]) => [key, record.seq]),
  ]);
  useEffect(() => {
    if (connection !== "open") return;
    const timer = setTimeout(() => { asked.current = openAudiobookListening(worldId, production.meta.id); }, 1200);
    return () => clearTimeout(timer);
  }, [connection, worldId, production.meta.id, stamp]);
  const arke = useArkePlayerExport({ worldId, worldSlug: world.meta.slug, keyArt: world.keyArt ?? null, production, plan, worldName: world.meta.name, committed: bookChapters(production), remote: isRemoteSession(), phone, onClose });
  const whole = plan === null ? [] : wholeChapters(plan);
  const line = plan === null ? "…" : `${whole.length} of ${plan.chapters.length} chapter${plan.chapters.length === 1 ? "" : "s"} read · ${clockTime(whole.reduce((sum, chapter) => sum + chapter.seconds, 0))}`;
  return (
    <Frame production={production} line={line} made={arke.sub} foot={arke.foot} onClose={onClose}>
      {refused !== null && <div className="fy-abv-warn" role="status">{refused}</div>}
      {arke.rows !== null && <div className="fy-abv-opts">{arke.rows}</div>}
      {arke.lines}
    </Frame>
  );
}

/** A graphic novel's package (SPEC-064 R-50): the accepted pages alone, once every page is cleared. */
function ComicPlayer({ world, production, onClose, goToPage }: { world: WorldBundle; production: ProductionBundle; onClose: () => void; goToPage: (page: string) => void }) {
  const worldId = world.meta.worldId;
  const connection = useConnection();
  const phone = usePhone();
  const [making, setMaking] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; package: ArkePlayerPackage; at: Date } | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  useEffect(() => subscribeArkePlayerExported((answer) => {
    if (answer.exportId !== making) return;
    setMaking(null);
    if (answer.result.ok) setMade({ id: answer.exportId, package: answer.result, at: new Date() });
    else setBlockers(answer.result.blockers);
  }), [making]);
  const make = () => {
    const id = `ap_${ulid()}`;
    setMade(null);
    setBlockers([]);
    if (exportArkePlayer(worldId, production.meta.id, id, { book: false, motion: false }) !== null) setMaking(id);
  };
  const foot = (
    <div className="fy-abv-foot">
      <span className="grow" />
      {made !== null ? <button type="button" className="fy-abv-btn pri" onClick={onClose}>Done</button> : (
        <>
          <button type="button" className="fy-abv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="fy-abv-btn pri" style={phone ? { flex: 1 } : undefined} disabled={making !== null || connection !== "open" || !comicReady(production)} onClick={make} data-testid="arke-player-start">Make package</button>
        </>
      )}
    </div>
  );
  return (
    <Frame production={production} line={comicSummary(production)} made={made === null ? null : `made ${madeStamp(made.at)}`} foot={foot} onClose={onClose}>
      {made === null ? <ComicBookRows production={production} goTo={goToPage} /> : (
        <ArkePlayerMade worldId={worldId} worldSlug={world.meta.slug} productionId={production.meta.id} exportId={made.id} made={made.package} picture={world.keyArt ?? null}
          holds={`${made.package.chapters} chapter${made.package.chapters === 1 ? "" : "s"} · ${made.package.pictures} page${made.package.pictures === 1 ? "" : "s"}`}
          title={production.meta.title} remote={isRemoteSession()} phone={phone} onMakeAgain={make} testId="comic-player-done" />
      )}
      {making !== null && <div className="fy-abv-note" data-testid="arke-player-making">Making package · follow it in Activity</div>}
      {blockers.map((blocker) => <div key={blocker} className="fy-comic-block"><CircleAlert size={15} /><span className="c">{blocker}</span></div>)}
    </Frame>
  );
}
