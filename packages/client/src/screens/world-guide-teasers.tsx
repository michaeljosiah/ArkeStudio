import { useEffect, useRef, useState } from "react";
import {
  guideChapterOf,
  guideLiving,
  listeningPictureKey,
  listeningPictureNamed,
  MAX_GUIDE_TEASERS,
  MAX_TEASER_CLIP_MS,
  musicClock,
  sameGuideTeaser,
  type AudiobookListening,
  type GuideProductionChapters,
  type GuideRecord,
  type GuideRecordEntry,
  type GuideRecordMoment,
  type GuideRecordSong,
  type GuideRecordTeaser,
  type ListeningChapter,
  type Sheet,
  type WorldBundle,
} from "@arke-studio/contracts";
import { characterPortraitPath, locationPortraitPath, Portrait } from "../components/portrait.js";
import { Button, IconButton, cx } from "../components/ui.js";
import { PlaySolid, Plus, X } from "../components/icons.js";
import { mediaUrl } from "../lib/media.js";
import { openAudiobookListening, setGuideTeasers, subscribeAudiobookListening, useStore } from "../lib/store.js";
import { clampExcerpt, musicChoiceOf, SongExcerpt, trackWhat, worldMusic, type WorldAlbum } from "./world-guide-music.js";

/**
 * A world's teasers (design turn 236a – 236c, SPEC-059 R-24 – R-27): up to six things from the
 * world, in the author's order, that Arke Player shows to anyone before the world is installed. A
 * character or place must be public from the start; a picture is any picture made for the world's
 * productions; a clip is a moment of a chapter read whole, its picture and narration; a song is a
 * window of at most 30 seconds on a track of the world's music (238g, R-36). Kept as choices: a
 * teaser that stops qualifying stays here, marked, and is left out of the package.
 */

type Tab = "characters" | "places" | "pictures" | "clips" | "songs";
const TABS: Array<[Tab, string]> = [["characters", "Characters"], ["places", "Places"], ["pictures", "Pictures"], ["clips", "Clips"], ["songs", "Songs"]];

/** A card as the Guide and the picker draw it: one shape whatever it holds (236 rule 12). */
interface Card {
  /** A square cover is drawn whole over its own blur, so the card keeps its 16:9 (238g). */
  picture: { kind: "sheet"; path: string; label: string } | { kind: "file"; file: string } | { kind: "cover"; file: string } | null;
  name: string;
  what: string;
  clip: boolean;
  /** Why it cannot be a teaser now, in one clause: `After Chapter 9`, `Not public`. */
  mark?: string;
}

/** A moment a picture or clip teaser can be: a picture in a chapter, a block's own or a mark's. */
interface Moment {
  production: string;
  chapter: string;
  title: string;
  number: number;
  /** Its block's key in the plan, which a block's own picture and its marks share. */
  key: string;
  markKey?: string;
  /** What a choice stores (design turn 237, R-202): the picture's own key, a block's or a mark's `block@sentence`. */
  block: string;
  file: string;
  /** How long its clip would be: its hold, at most 30 seconds (R-25). */
  seconds: number;
  whole: boolean;
}

const readWhole = (chapter: ListeningChapter) => chapter.state === "read" && (chapter.blocks.length > 0 || (chapter.audioStudio !== undefined && chapter.mix !== undefined));
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

function momentsOf(plan: AudiobookListening, productions: readonly GuideProductionChapters[]): Moment[] {
  const numbered = productions.find((production) => production.id === plan.productionId);
  return plan.chapters.flatMap((chapter) => {
    const number = numbered?.chapters.find((candidate) => candidate.id === chapter.chapterId)?.number ?? chapter.order;
    const title = chapter.title.trim() === "" ? `Chapter ${number}` : chapter.title.trim();
    return chapter.pictures.map((picture) => ({
      production: plan.productionId,
      chapter: chapter.chapterId,
      title,
      number,
      key: picture.key,
      ...(picture.markKey !== undefined ? { markKey: picture.markKey } : {}),
      block: listeningPictureKey(picture),
      file: picture.file,
      seconds: Math.min(MAX_TEASER_CLIP_MS / 1000, picture.seconds),
      whole: readWhole(chapter),
    }));
  });
}

/**
 * Each production's listening plan while `wanted`: where its pictures and clips are. A request
 * whose answer a dropped connection lost is asked again once it is back (codex on PR 2173).
 */
function usePlans(worldId: string, productionIds: readonly string[], wanted: boolean): ReadonlyMap<string, AudiobookListening> {
  const connection = useStore().connection;
  const [plans, setPlans] = useState<ReadonlyMap<string, AudiobookListening>>(new Map());
  const asked = useRef(new Map<string, string>());
  // The productions asked on this connection whose answer may still come; a drop forgets them.
  const waiting = useRef(new Set<string>());
  useEffect(() => {
    if (connection !== "open") waiting.current.clear();
  }, [connection]);
  useEffect(() => subscribeAudiobookListening((answer) => {
    const production = asked.current.get(answer.requestId);
    if (production === undefined || answer.listening === null) return;
    waiting.current.delete(production);
    setPlans((was) => new Map(was).set(production, answer.listening!));
  }), []);
  const key = productionIds.join("\n");
  useEffect(() => {
    if (!wanted || connection !== "open") return;
    for (const production of productionIds) {
      if (plans.has(production) || waiting.current.has(production)) continue;
      const requestId = openAudiobookListening(worldId, production);
      if (requestId === null) continue;
      asked.current.set(requestId, production);
      waiting.current.add(production);
    }
  }, [worldId, key, wanted, connection, plans]);
  return plans;
}

const teaserKey = (teaser: GuideRecordTeaser) =>
  `${teaser.kind}:${"sheet" in teaser ? teaser.sheet : teaser.kind === "song" ? `${teaser.production}/${teaser.track}` : `${teaser.production}/${teaser.chapter}/${teaser.block}`}`;

const sheetKind = (teaser: GuideRecordTeaser) => (teaser.kind === "character" ? "characters" : teaser.kind === "location" ? "locations" : "factions") as "characters" | "locations" | "factions";
const SHEET_TYPE = { characters: "character", locations: "location", factions: "faction" } as const;

/** Why a sheet cannot be a teaser now (R-25): it is not public, or it waits for a chapter. */
function sheetMark(entry: GuideRecordEntry | undefined, productions: readonly GuideProductionChapters[]): string | undefined {
  if (entry?.public !== true) return "Not public";
  if (entry.after === undefined) return undefined;
  const chapter = guideChapterOf(productions, entry.after);
  return chapter !== null ? `After Chapter ${chapter.number}` : "Chapter removed";
}

export function GuideTeasers({ world, worldId, record, productions }: { world: WorldBundle; worldId: string; record: GuideRecord; productions: readonly GuideProductionChapters[] }) {
  const [pending, setPending] = useState<GuideRecordTeaser[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);
  const kept = record.teasers;
  useEffect(() => setPending(null), [kept]);
  const teasers = pending ?? kept ?? [];
  const storyIds = world.productions.filter((production) => production.chapters.length > 0).map((production) => production.meta.id);
  const plans = usePlans(worldId, storyIds, picking || teasers.some((teaser) => teaser.kind === "picture" || teaser.kind === "clip"));
  const moments = [...plans.values()].flatMap((plan) => momentsOf(plan, productions));
  const save = (next: GuideRecordTeaser[]) => {
    setPending(next);
    setGuideTeasers(worldId, { teasers: next });
  };

  const sheetCard = (teaser: Extract<GuideRecordTeaser, { sheet: string }>): Card => {
    const kind = sheetKind(teaser);
    const sheet = world.sheets.find((candidate) => candidate.type === SHEET_TYPE[kind] && candidate.id === teaser.sheet);
    const path = kind === "locations" ? locationPortraitPath(world, teaser.sheet) : characterPortraitPath(world, teaser.sheet);
    const mark = sheet === undefined || sheet.retired === true ? "Not in the world" : sheetMark(record[kind][teaser.sheet], productions);
    return { picture: { kind: "sheet", path, label: sheet?.name ?? teaser.sheet }, name: sheet?.name ?? teaser.sheet, what: kind === "characters" ? "Character" : "Place", clip: false, ...(mark !== undefined ? { mark } : {}) };
  };
  // A choice finds its moment as the package does: by the picture's own key, a bare block key from
  // before marks named themselves by its block's first picture.
  const momentOf = (teaser: GuideRecordMoment) => listeningPictureNamed(moments.filter((candidate) => candidate.production === teaser.production && candidate.chapter === teaser.chapter), teaser.block);
  // A choice is taken by any teaser that finds the same moment, however it was stored.
  const sameTeaser = (a: GuideRecordTeaser, b: GuideRecordTeaser) => sameGuideTeaser(a, b) || (a.kind === b.kind && "block" in a && "block" in b && momentOf(a) !== undefined && momentOf(a) === momentOf(b));
  const momentCard = (teaser: GuideRecordMoment): Card => {
    const moment = momentOf(teaser);
    const clip = teaser.kind === "clip";
    if (moment === undefined) return { picture: null, name: plans.has(teaser.production) ? "Moment removed" : "…", what: clip ? "Clip" : "Picture", clip, ...(plans.has(teaser.production) ? { mark: "Moment removed" } : {}) };
    const mark = clip && !moment.whole ? "Not read whole" : undefined;
    return { picture: { kind: "file", file: moment.file }, name: moment.title, what: clip ? `Clip · ${clock(moment.seconds)} · Chapter ${moment.number}` : `Picture · Chapter ${moment.number}`, clip, ...(mark !== undefined ? { mark } : {}) };
  };
  // A song shows its album's cover, or the key art where it has none, as the package does (R-37);
  // in the picker it says which track it is, on the page how long its excerpt is.
  const albums = worldMusic(world);
  const songCard = (teaser: GuideRecordSong, picking: boolean): Card => {
    const choice = musicChoiceOf(albums, teaser);
    if (choice === undefined) return { picture: null, name: "Track removed", what: "Song", clip: true, mark: "Track removed" };
    const picture: Card["picture"] = choice.cover !== undefined ? { kind: "cover", file: `artifacts/${choice.cover.file}` } : world.keyArt ? { kind: "file", file: world.keyArt } : null;
    return { picture, name: choice.track.title, what: picking ? trackWhat(choice) : `Song · ${clock(teaser.duration / 1000)}`, clip: true };
  };
  const cardOf = (teaser: GuideRecordTeaser, picking = false) => ("sheet" in teaser ? sheetCard(teaser) : teaser.kind === "song" ? songCard(teaser, picking) : momentCard(teaser));
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...teasers];
    const [taken] = next.splice(from, 1);
    next.splice(to, 0, taken!);
    save(next);
  };

  return (
    <section className="fy-guide-group fy-guide-teasers" aria-label="Teasers">
      <div className="fy-guide-gh"><span>Teasers</span><span className="fy-guide-grow" /><span className="fy-guide-mono">{teasers.length} of {MAX_GUIDE_TEASERS}</span></div>
      <div className="fy-guide-tzs" data-testid="guide-teasers">
        {teasers.map((teaser, index) => {
          const card = cardOf(teaser);
          return (
            <div
              key={teaserKey(teaser)}
              className={cx("fy-guide-tz", card.mark !== undefined && "no", dragged === index && "drag")}
              draggable
              onDragStart={(event) => {
                setDragged(index);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDragged(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged !== null) move(dragged, index);
                setDragged(null);
              }}
              data-testid={`guide-teaser-${index + 1}`}
            >
              <TeaserPicture world={world} card={card} n={index + 1} />
              <b>{card.name}</b>
              <span className="m">{card.mark ?? card.what}</span>
              <IconButton className="fy-guide-tz__x" label={`Remove ${card.name}`} onClick={() => save(teasers.filter((_, at) => at !== index))}><X size={13} /></IconButton>
            </div>
          );
        })}
        {Array.from({ length: Math.max(0, MAX_GUIDE_TEASERS - teasers.length) }, (_, index) => (
          <button key={`add-${index}`} type="button" className="fy-guide-tz fy-guide-tz--add" onClick={() => setPicking(true)} data-testid={index === 0 ? "guide-teaser-add" : undefined}>
            <span className="im"><Plus size={14} />Add</span>
          </button>
        ))}
      </div>
      {picking && (
        <TeaserPicker
          world={world}
          teasers={teasers}
          moments={moments}
          albums={albums}
          loading={storyIds.some((id) => !plans.has(id))}
          cardOf={cardOf}
          sameTeaser={sameTeaser}
          onAdd={(teaser) => {
            save([...teasers, teaser]);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}

/** A sheet with no picture yet shows its initials, as the Guide's rows do (234a). */
const initialsOf = (name: string) => name.split(/\s+/).filter((word) => /^[A-Za-z]/.test(word) && !/^(the|of|a)$/i.test(word)).slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || name.slice(0, 1).toUpperCase();

function TeaserPicture({ world, card, n }: { world: WorldBundle; card: Card; n?: number }) {
  const [shown, setShown] = useState(true);
  return (
    <span className="im">
      {card.picture?.kind === "sheet" && shown && <Portrait worldSlug={world.meta.slug} path={card.picture.path} label={card.picture.label} radius={0} loading="lazy" onAvailabilityChange={setShown} />}
      {card.picture?.kind === "sheet" && !shown && <span className="fy-guide-ini">{initialsOf(card.picture.label)}</span>}
      {card.picture?.kind === "file" && <img src={mediaUrl(world.meta.slug, card.picture.file)} alt="" loading="lazy" />}
      {card.picture?.kind === "cover" && <img className="bl" src={mediaUrl(world.meta.slug, card.picture.file)} alt="" loading="lazy" />}
      {card.picture?.kind === "cover" && <img className="sq" src={mediaUrl(world.meta.slug, card.picture.file)} alt="" loading="lazy" />}
      {card.clip && <span className="play"><PlaySolid size={14} /></span>}
      {n !== undefined && <span className="n">{n}</span>}
    </span>
  );
}

function TeaserPicker({
  world,
  teasers,
  moments,
  albums,
  loading,
  cardOf,
  sameTeaser,
  onAdd,
  onClose,
}: {
  world: WorldBundle;
  teasers: readonly GuideRecordTeaser[];
  moments: readonly Moment[];
  albums: readonly WorldAlbum[];
  loading: boolean;
  cardOf: (teaser: GuideRecordTeaser, picking?: boolean) => Card;
  sameTeaser: (a: GuideRecordTeaser, b: GuideRecordTeaser) => boolean;
  onAdd: (teaser: GuideRecordTeaser) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("characters");
  const [picked, setPicked] = useState<GuideRecordTeaser | null>(null);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const sheets = (type: Sheet["type"]) => guideLiving(world.sheets.filter((sheet) => sheet.type === type));
  const song = picked?.kind === "song" ? musicChoiceOf(albums, picked) : undefined;
  const options: GuideRecordTeaser[] =
    tab === "characters"
      ? sheets("character").map((sheet) => ({ kind: "character", sheet: sheet.id }))
      : tab === "places"
        ? [...sheets("location").map((sheet) => ({ kind: "location" as const, sheet: sheet.id })), ...sheets("faction").map((sheet) => ({ kind: "faction" as const, sheet: sheet.id }))]
        : tab === "songs"
          ? albums.flatMap((album) => album.tracks).map((choice) => ({ kind: "song" as const, production: choice.production.meta.id, track: choice.track.id, start: 0, duration: clampExcerpt(choice.lengthMs, 0, MAX_TEASER_CLIP_MS).duration }))
          : moments.filter((moment) => tab === "pictures" || moment.whole).map((moment) => ({ kind: tab === "pictures" ? ("picture" as const) : ("clip" as const), production: moment.production, chapter: moment.chapter, block: moment.block }));

  return (
    <div className="fy-guide-dim fy-guide-dim--center" onClick={onClose}>
      <div className="fy-guide-pick" role="dialog" aria-label="Add teaser" onClick={(event) => event.stopPropagation()}>
        <h3>Add teaser · {world.meta.name}</h3>
        <div className="fy-guide-mono">{teasers.length} of {MAX_GUIDE_TEASERS}</div>
        <div className="fy-guide-pick__tabs" role="tablist">
          {TABS.map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} className={cx(tab === value && "on")} onClick={() => { setTab(value); setPicked(null); }}>
              {label}
            </button>
          ))}
        </div>
        <div className="fy-guide-pick__grid" data-testid="guide-teaser-options">
          {options.length === 0 && <span className="fy-guide-muted">{loading && (tab === "pictures" || tab === "clips") ? "…" : "None"}</span>}
          {options.map((option) => {
            const at = teasers.findIndex((teaser) => sameTeaser(teaser, option));
            const card = cardOf(option, true);
            // Already a teaser, or not one it can be: said in one clause, never offered and refused (R-25).
            const clause = at !== -1 ? `Teaser ${at + 1}` : card.mark;
            const on = picked !== null && sameGuideTeaser(picked, option);
            return (
              <button
                key={teaserKey(option)}
                type="button"
                className={cx("fy-guide-tz", clause !== undefined && "no", on && "on")}
                disabled={clause !== undefined}
                aria-pressed={on}
                onClick={() => setPicked(option)}
              >
                <TeaserPicture world={world} card={card} />
                <b>{card.name}</b>
                <span className="m">{clause ?? card.what}</span>
              </button>
            );
          })}
        </div>
        {song !== undefined && picked?.kind === "song" && (
          <SongExcerpt world={world} choice={song} start={picked.start} duration={picked.duration} onChange={(start, duration) => setPicked({ ...picked, start, duration })} />
        )}
        <div className="fy-guide-pick__foot">
          {song !== undefined && picked?.kind === "song" && <span className="fy-guide-muted">{song.track.title} · {musicClock(picked.start)}–{musicClock(picked.start + picked.duration)}</span>}
          <span className="fy-guide-grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={picked === null || teasers.length >= MAX_GUIDE_TEASERS} onClick={() => picked !== null && onAdd(picked)} data-testid="guide-teaser-confirm">Add</Button>
        </div>
      </div>
    </div>
  );
}
