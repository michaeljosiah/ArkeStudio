import { useEffect, useRef, useState } from "react";
import {
  guideChapterOf,
  guideLiving,
  MAX_GUIDE_TEASERS,
  MAX_TEASER_CLIP_MS,
  sameGuideTeaser,
  type AudiobookListening,
  type GuideProductionChapters,
  type GuideRecord,
  type GuideRecordEntry,
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

/**
 * A world's teasers (design turn 236a – 236c, SPEC-059 R-24 – R-27): up to six things from the
 * world, in the author's order, that Arke Player shows to anyone before the world is installed. A
 * character or place must be public from the start; a picture is any picture made for the world's
 * productions; a clip is a moment of a chapter read whole, its picture and narration. Kept as
 * choices: a teaser that stops qualifying stays here, marked, and is left out of the package.
 */

type Tab = "characters" | "places" | "pictures" | "clips";
const TABS: Array<[Tab, string]> = [["characters", "Characters"], ["places", "Places"], ["pictures", "Pictures"], ["clips", "Clips"]];

/** A card as the Guide and the picker draw it: one shape whatever it holds (236 rule 12). */
interface Card {
  picture: { kind: "sheet"; path: string; label: string } | { kind: "file"; file: string } | null;
  name: string;
  what: string;
  clip: boolean;
  /** Why it cannot be a teaser now, in one clause: `After Chapter 9`, `Not public`. */
  mark?: string;
}

/** A moment a picture or clip teaser can be: a block's picture in a chapter. */
interface Moment {
  production: string;
  chapter: string;
  title: string;
  number: number;
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
    return chapter.pictures.map((picture) => ({ production: plan.productionId, chapter: chapter.chapterId, title, number, block: picture.key, file: picture.file, seconds: Math.min(MAX_TEASER_CLIP_MS / 1000, picture.seconds), whole: readWhole(chapter) }));
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
  const momentCard = (teaser: Extract<GuideRecordTeaser, { block: string }>): Card => {
    const moment = moments.find((candidate) => candidate.production === teaser.production && candidate.chapter === teaser.chapter && candidate.block === teaser.block);
    const clip = teaser.kind === "clip";
    if (moment === undefined) return { picture: null, name: plans.has(teaser.production) ? "Moment removed" : "…", what: clip ? "Clip" : "Picture", clip, ...(plans.has(teaser.production) ? { mark: "Moment removed" } : {}) };
    const mark = clip && !moment.whole ? "Not read whole" : undefined;
    return { picture: { kind: "file", file: moment.file }, name: moment.title, what: clip ? `Clip · ${clock(moment.seconds)} · Chapter ${moment.number}` : `Picture · Chapter ${moment.number}`, clip, ...(mark !== undefined ? { mark } : {}) };
  };
  const cardOf = (teaser: GuideRecordTeaser) => ("sheet" in teaser ? sheetCard(teaser) : momentCard(teaser));
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
              key={`${teaser.kind}:${"sheet" in teaser ? teaser.sheet : `${teaser.production}/${teaser.chapter}/${teaser.block}`}`}
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
          loading={storyIds.some((id) => !plans.has(id))}
          cardOf={cardOf}
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
      {card.clip && <span className="play"><PlaySolid size={14} /></span>}
      {n !== undefined && <span className="n">{n}</span>}
    </span>
  );
}

function TeaserPicker({
  world,
  teasers,
  moments,
  loading,
  cardOf,
  onAdd,
  onClose,
}: {
  world: WorldBundle;
  teasers: readonly GuideRecordTeaser[];
  moments: readonly Moment[];
  loading: boolean;
  cardOf: (teaser: GuideRecordTeaser) => Card;
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
  const options: GuideRecordTeaser[] =
    tab === "characters"
      ? sheets("character").map((sheet) => ({ kind: "character", sheet: sheet.id }))
      : tab === "places"
        ? [...sheets("location").map((sheet) => ({ kind: "location" as const, sheet: sheet.id })), ...sheets("faction").map((sheet) => ({ kind: "faction" as const, sheet: sheet.id }))]
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
            const at = teasers.findIndex((teaser) => sameGuideTeaser(teaser, option));
            const card = cardOf(option);
            // Already a teaser, or not one it can be: said in one clause, never offered and refused (R-25).
            const clause = at !== -1 ? `Teaser ${at + 1}` : card.mark;
            const on = picked !== null && sameGuideTeaser(picked, option);
            return (
              <button
                key={`${option.kind}:${"sheet" in option ? option.sheet : `${option.production}/${option.chapter}/${option.block}`}`}
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
        <div className="fy-guide-pick__foot">
          <span className="fy-guide-grow" />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={picked === null || teasers.length >= MAX_GUIDE_TEASERS} onClick={() => picked !== null && onAdd(picked)} data-testid="guide-teaser-confirm">Add</Button>
        </div>
      </div>
    </div>
  );
}
