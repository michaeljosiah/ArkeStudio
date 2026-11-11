import { useEffect, useRef, useState, type ReactNode } from "react";
import { clockTime, productionShape, ulid, type AudiobookListening, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import { usePhone } from "../lib/media-query.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { exportArkePlayer, exportGuideAlone, listWebPackages, openAudiobookListening, subscribeArkePlayerExported, subscribeAudiobookListening, subscribeGuideAloneExported, subscribeWebPackages, useAudiobookRecords, useConnection, type GuideAloneExported } from "../lib/store.js";
import { ComicBookRows, comicReady, comicSummary } from "../screens/comic-pages.js";
import { bookChapters, editionDay, exportGuideCounts, guideAloneEstimate, madeStamp, useArkePlayerExport } from "./arke-player-export.js";
import { ArkePlayerMade, type ArkePlayerPackage } from "./arke-player-made.js";
import { megabytes, wholeChapters } from "./audiobook-video.js";
import { CircleAlert } from "./icons.js";
import { PageSheet } from "./page-sheet.js";

/**
 * Arke Player (design turn 276 rule 8, SPEC-058 R-1, SPEC-064 R-50): the sheet that makes a book's
 * or a graphic novel's package, opened from Publish's Arke Player card. Its rows are each kind's
 * rows as they shipped inside Export audiobook and the comic's Export, which no longer offer it;
 * once made, the one block every kind shows (R-103). An album's and a story's packages are made
 * from their own sheets, which read what their screens hold; a world's guide alone from the Guide
 * page (GuideAloneSheet below).
 */
export function ArkePlayerExportSheet({ world, production, onClose, goToPage }: { world: WorldBundle; production: ProductionBundle; onClose: () => void; goToPage: (page: string) => void }) {
  return productionShape(production.meta).hasPages
    ? <ComicPlayer world={world} production={production} onClose={onClose} goToPage={goToPage} />
    : <BookPlayer world={world} production={production} onClose={onClose} />;
}

/** The sheet's chrome, the same for every kind: what it is under the title, and once made, when. */
function Frame({ name, line, made, foot, onClose, children }: { name: string; line: string | null; made: string | null; foot: ReactNode; onClose: () => void; children: ReactNode }) {
  const phone = usePhone();
  return (
    <PageSheet open onClose={onClose} title="Arke Player" subtitle={made === null ? name : `${name} · ${made}`} preserveReturnFocus footer={foot} className={phone ? "fy-abv-modal fy-abv-modal--phone" : "fy-abv-modal"}>
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
    <Frame name={production.meta.title} line={line} made={arke.sub} foot={arke.foot} onClose={onClose}>
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
    <Frame name={production.meta.title} line={comicSummary(production)} made={made === null ? null : `made ${madeStamp(made.at)}`} foot={foot} onClose={onClose}>
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

/**
 * A world's guide alone (SPEC-059 R-10, design turn 276g), from the Guide page's Export: the world
 * and what its Guide makes public, as public counts, made as the export script makes it. It is listed
 * nowhere but its made block, and belongs to no production, so it has no Submit.
 */
export function GuideAloneSheet({ world, onClose }: { world: WorldBundle; onClose: () => void }) {
  const worldId = world.meta.worldId;
  const connection = useConnection();
  const phone = usePhone();
  const remote = isRemoteSession();
  const [making, setMaking] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; result: Extract<GuideAloneExported["result"], { ok: true }>; at: Date } | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);
  useEffect(() => subscribeGuideAloneExported((answer) => {
    if (answer.exportId !== making) return;
    setMaking(null);
    if (answer.result.ok) setMade({ id: answer.exportId, result: answer.result, at: new Date() });
    else setBlockers(answer.result.blockers);
  }), [making]);
  // A reconnect can lose the one answer, and a guide alone is listed nowhere to find it by (codex on
  // PR 2988): the desktop says which exports it is still making, as for a story (codex on PR 2205),
  // and one no longer among them ended while this window was away.
  const listing = useRef<string | null>(null);
  useEffect(() => {
    if (connection === "open" && making !== null) listing.current = listWebPackages(worldId);
  }, [connection, worldId]);
  useEffect(() => subscribeWebPackages((answer) => {
    if (answer.requestId !== listing.current || making === null || answer.running === undefined || answer.running.includes(making)) return;
    setMaking(null);
    setBlockers(["the export ended while this window was away · make it again"]);
  }), [making]);
  const make = () => {
    const id = `ap_${ulid()}`;
    setMade(null);
    setBlockers([]);
    if (exportGuideAlone(worldId, id) !== null) setMaking(id);
  };
  const counts = exportGuideCounts(world);
  const estimate = guideAloneEstimate(counts, world.keyArt !== undefined && world.keyArt !== null);
  const kept = counts.lore.of - counts.lore.public;
  const opt = (label: string, middle: ReactNode, tail?: string) => (
    <div className="fy-abv-opt"><b>{label}</b>{middle}<span className="grow" />{tail !== undefined && !phone && <i>{tail}</i>}</div>
  );
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const foot = (
    <div className="fy-abv-foot">
      <span className="grow" />
      {made !== null ? <button type="button" className="fy-abv-btn pri" onClick={onClose}>Done</button> : (
        <>
          <button type="button" className="fy-abv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="fy-abv-btn pri" style={phone ? { flex: 1 } : undefined} disabled={making !== null || connection !== "open" || estimate.entries === 0} onClick={make} data-testid="guide-alone-start">Make package</button>
        </>
      )}
    </div>
  );
  return (
    <Frame name={`${world.meta.name} · guide alone`} line={null} made={made === null ? null : `made ${madeStamp(made.at)}`} foot={foot} onClose={onClose}>
      {made === null ? (
        <>
          <div className="fy-abv-opts" data-testid="guide-alone-rows">
            {!phone && opt("World", <span>{world.meta.name}</span>, "key art · logline")}
            {opt("Characters", <span>{counts.characters.public} public</span>, counts.after > 0 ? `${counts.after} after a chapter` : undefined)}
            {opt("Places", <span>{counts.places.public} public</span>)}
            {opt("Lore", <span>{counts.lore.public} public</span>, kept > 0 ? `${kept} kept back` : undefined)}
            {opt("Teasers", <span>{counts.teasers.chosen}</span>)}
            {!phone && opt("Edition", <span className="fy-abv-field">{editionDay()}</span>)}
          </div>
          <div className="fy-abv-est" data-testid="guide-alone-estimate">
            <b>{estimate.entries === 0 ? "nothing in the Guide is public" : `~${megabytes(estimate.bytes)} · ~${estimate.seconds} s ${remote ? "on the desktop" : "on this machine"}`}</b>
            {!phone && estimate.entries > 0 && <span className="m">{[plural(counts.characters.public, "character"), plural(counts.places.public, "place"), `${counts.lore.public} lore`, plural(counts.teasers.chosen, "teaser")].join(" · ")}</span>}
          </div>
        </>
      ) : (
        <ArkePlayerMade worldId={worldId} worldSlug={world.meta.slug} exportId={made.id} made={made.result} picture={world.keyArt ?? null}
          holds={[plural(made.result.characters, "character"), plural(made.result.places, "place"), `${made.result.lore} lore`].join(" · ")}
          title={world.meta.name} remote={remote} phone={phone} onMakeAgain={make} testId="guide-alone-done" />
      )}
      {making !== null && <div className="fy-abv-note" data-testid="guide-alone-making">Making package</div>}
      {blockers.map((blocker) => <div key={blocker} className="fy-abv-warn">{blocker}</div>)}
    </Frame>
  );
}
