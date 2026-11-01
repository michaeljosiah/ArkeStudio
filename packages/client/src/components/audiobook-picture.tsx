import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  audiobookTextHash,
  bookPictureShapes,
  formatRunningTime,
  tallFromEarlier,
  kitLookLibrary,
  pictureBench,
  pictureDetailSkins,
  pictureLookChanged,
  pictureMood,
  pictureSpans,
  pictureKeyParts,
  placedKey,
  sentenceHashes,
  sentencesOf,
  productionStyleFor,
  worldImageReferences,
  type AudiobookPicture,
  type AudiobookPictureSource,
  type ChapterAudiobook,
  type PictureSuggestion,
  type ProductionBundle,
  type WorldBundle,
  type WorldImageReference,
} from "@arke-studio/contracts";
import { usableModels } from "./dispatch-bar.js";
import { setupForMode, type ModeSetup } from "../lib/composer-mode.js";
import { mediaUrl } from "../lib/media.js";
import { subscribeCommandFailures, sendBenchAddReference, sendBenchCompose, sendBenchNewSession, setAudiobookPicture, useBench, useStore } from "../lib/store.js";
import type { BlockRow } from "../screens/chapter-audiobook.js";
import { Button, Textarea, cx } from "./ui.js";
import { usePictureSuggestion, type PictureSuggestionState } from "./audiobook-suggest.js";
import { PictureCard, PicturePress } from "./audiobook-picture-card.js";
import { chosenFrom, madePicture } from "./audiobook-made-picture.js";
import { AudiobookMotionControl } from "./audiobook-motion.js";

/**
 * Pictures that follow the words (design turn 186c, SPEC-047 R-69): in a chapter's Audiobook
 * view a block's panel gains Picture — one the world holds, chosen from its art, the cast's and
 * places' pictures or its scenes' frames and takes, or one generated for the book through the
 * Bench, priced and confirmed there as any image is. A chip in the block's margin shows the
 * picture and when it starts, and flags a hold under twenty seconds rather than refusing it; the
 * chooser says how long it holds.
 */

export type PictureTab = "world" | "cast" | "scenes" | "generated";
export const PICTURE_TABS: ReadonlyArray<{ tab: PictureTab; label: string }> = [
  { tab: "world", label: "World" },
  { tab: "cast", label: "Cast" },
  { tab: "scenes", label: "Scenes" },
  { tab: "generated", label: "Generate" },
];

/** Which tab a picture the world holds is offered on: one made on the Bench is the book's Generate, the rest by its group. */
export function pictureTab(reference: Pick<WorldImageReference, "file" | "group">, world: Pick<WorldBundle, "artifacts">): PictureTab {
  if (reference.file.startsWith("artifacts/")) {
    const artifact = world.artifacts.find((candidate) => `artifacts/${candidate.file}` === reference.file);
    if (artifact?.generation?.source === "bench") return "generated";
  }
  if (reference.group === "Cast" || reference.group === "Places") return "cast";
  if (reference.group === "Takes and stills") return "scenes";
  return "world";
}

/** The pictures on offer, by tab, newest generated first. */
export function picturesByTab(world: WorldBundle): Record<PictureTab, WorldImageReference[]> {
  const out: Record<PictureTab, WorldImageReference[]> = { world: [], cast: [], scenes: [], generated: [] };
  for (const reference of worldImageReferences(world)) out[pictureTab(reference, world)].push(reference);
  const created = (file: string) => world.artifacts.find((artifact) => `artifacts/${artifact.file}` === file)?.created ?? "";
  out.generated.sort((a, b) => (created(a.file) < created(b.file) ? 1 : -1));
  return out;
}

export interface PictureSpan {
  /** Its picture key as the block now names it: the block's own, or a mark's (design turn 237). */
  key: string;
  file: string;
  /** The block it is set on, where it is kept (a picture that followed its words keeps its old key). */
  index: number;
  /** The sentence of its block it starts at: 0 for the block's own, more for a mark (design turn 237). */
  sentence: number;
  at: number;
  /** How long it holds, to the next picture however soon (design turn 237, R-207). */
  seconds: number;
  /** The block the next picture is on, or null to the chapter's end. */
  until: number | null;
  /** Its start leans on a block before it timed at the reading rate, not measured: said with a `~`. */
  estimated: boolean;
  /** The picture as the record keeps it: its stamp and the shot it was made from. */
  entry: AudiobookPicture;
}

/**
 * Where each picture stands on the chapter's clock, by the block it shows on: a made take's
 * measured length, else the block's words at the reading rate — estimated, and said so.
 */
export function useChapterPictures(world: WorldBundle | null, rows: readonly BlockRow[], record: ChapterAudiobook | null) {
  return useMemo(() => {
    const listed = new Set(world === null ? [] : worldImageReferences(world).map((reference) => reference.file));
    const blocks = rows.map((row) => {
      const take = record?.takes[row.block.key];
      const current = take !== undefined && row.artifact !== null && take.textHash === audiobookTextHash(row.block.text);
      const seconds = current ? (row.artifact?.mediaInfo?.durationSec ?? take.grouped?.durationSec ?? null) : null;
      // The take's word timing, when it is this take's: a picture set inside the take starts on its word (design turn 237, R-204).
      const timing = current ? record?.wordTiming?.[row.block.key] : undefined;
      const words = timing !== undefined && timing.artifactId === take?.artifactId && timing.textHash === take.textHash ? timing.words.map((word) => word.startSec) : undefined;
      return { key: row.block.key, text: row.block.text, seconds, ...(words !== undefined ? { words } : {}) };
    });
    const { spans, lost, estimated, startOf } = pictureSpans(blocks, record?.pictures, (file) => listed.has(file));
    // Every picture by its key as the blocks now name it: a block's own under the block's key, a
    // mark under its own (design turn 237); and each block's marks in reading order, for its words.
    const byKey = new Map<string, PictureSpan>();
    const marks = new Map<string, PictureSpan[]>();
    for (const span of spans) {
      const key = placedKey(blocks, span);
      const entry: PictureSpan = { key, file: span.picture.file, index: span.index, sentence: span.sentence, at: span.at, seconds: span.seconds, until: span.until, estimated: span.startEstimated, entry: span.picture };
      byKey.set(key, entry);
      if (span.sentence > 0) marks.set(rows[span.index]!.block.key, [...(marks.get(rows[span.index]!.block.key) ?? []), entry]);
    }
    const first = spans[0];
    return { byKey, marks, startOf, lost, estimated, count: spans.length, coverAtStart: first === undefined || first.at > 0 };
  }, [world, rows, record]);
}

const clock = (seconds: number) => formatRunningTime(seconds);

/**
 * When a picture starts, as the chip and the Picture tab say it (`10:22`, 194a): with a `~` only
 * when a block before it was timed at the reading rate rather than measured (186c's estimate).
 */
export function pictureStart(picture: Pick<PictureSpan, "at" | "estimated">): string {
  return `${picture.estimated ? "~" : ""}${clock(picture.at)}`;
}

/** The margin's chip (186c): the picture, and when it starts. */
export function PictureChip({ slug, picture, label }: { slug: string; picture: PictureSpan; label: string }) {
  return (
    <button type="button" aria-label={label} className="fy-ab__picchip" data-testid="audiobook-picture-chip">
      <img src={mediaUrl(slug, picture.file)} alt="" />
      {pictureStart(picture)}
    </button>
  );
}

/**
 * The brief a generated picture starts from: the block's words, then the chapter's light and mood
 * (R-69; design turn 193, rule 9) — the Mood line, never the art direction's free text, which
 * named clothes and dressed everyone in them.
 */
export function pictureBrief(words: string, production: Pick<ProductionBundle, "meta"> | null, world: Pick<WorldBundle, "artDirection"> | null, look?: ChapterAudiobook["look"] | null): string {
  const mood = pictureMood(look, productionStyleFor(production?.meta, world?.artDirection.description));
  return [`A picture for an audiobook, showing this moment: ${words.replace(/\s+/g, " ").trim()}`, ...(mood !== undefined ? [`Light and mood: ${mood}`] : [])].join("\n\n");
}

export function BlockPicturePanel({ worldId, production, chapterFile, chapterOrder, row, rows, pictures, record = null, pictureKey }: {
  worldId: string;
  production: ProductionBundle;
  chapterFile: string;
  chapterOrder: number;
  row: BlockRow;
  rows: readonly BlockRow[];
  pictures: ReturnType<typeof useChapterPictures>;
  /** The chapter's record, for its look (design turn 191c): the sheet opens from here. */
  record?: ChapterAudiobook | null;
  /**
   * The picture this tab is for (design turn 237c): a mark's key inside the block, or the block's
   * own when absent. A mark with no picture yet is one `+ Picture` placed: the tab makes or chooses it.
   */
  pictureKey?: string;
}) {
  const key = pictureKey ?? row.block.key;
  // Its words (R-205): from its sentence to the next picture in the block, which its brief starts from.
  const words = useMemo(() => {
    const sentences = sentencesOf(row.block.text);
    const parts = pictureKeyParts(key);
    const from = parts.sentence === undefined ? 0 : Math.max(0, sentenceHashes(row.block.text).indexOf(parts.sentence));
    const next = Math.min(sentences.length, ...(pictures.marks.get(row.block.key) ?? []).map((mark) => mark.sentence).filter((sentence) => sentence > from));
    return from === 0 && next === sentences.length ? row.block.text : sentences.slice(from, next).join(" ");
  }, [key, row.block.key, row.block.text, pictures.marks]);
  const suggestion = usePictureSuggestion(worldId, production.meta.id, chapterFile, key);
  const store = useStore();
  const world = store.state?.world ?? null;
  const connection = store.connection;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pickingTall, setPickingTall] = useState(false);
  const [tab, setTab] = useState<PictureTab>("world");
  const [brief, setBrief] = useState<string | null>(null);
  useEffect(() => {
    setOpen(false);
    setBrief(null);
  }, [key]);
  const index = rows.indexOf(row);
  const here = pictures.byKey.get(key) ?? null;
  const offered = useMemo(() => (world === null ? null : picturesByTab(world)), [world]);
  const blockName = row.block.key === "title" ? "title" : `block ${index + 1}`;
  const until = here === null ? null : here.until === null ? "end of chapter" : `until block ${here.until + 1}`;
  const choose = (file: string) => {
    const source: AudiobookPictureSource = tab;
    if (pickingTall && here === null) return;
    setAudiobookPicture(worldId, production.meta.id, chapterFile, key, { file, source, ...(pickingTall ? { tallFrom: here!.file } : {}) });
  };

  // Generate (R-69): a new Bench session in image mode with the brief written in, then the Bench —
  // which prices and confirms the picture as any image, and files it as an artifact kept there.
  const bench = useBench();
  const pending = useRef<{ before: string | null; brief: string; refs?: readonly string[]; setup?: ModeSetup; restored?: true } | null>(null);
  useEffect(() => subscribeCommandFailures(event => {
    if (event.command === "bench-new-session" && pending.current?.restored) pending.current = null;
  }), []);
  useEffect(() => {
    const asked = pending.current;
    const session = bench?.session;
    if (asked === null || session === undefined || session.id === asked.before || bench?.worldId !== worldId) return;
    pending.current = null;
    if (asked.restored) { void navigate(`/w/${worldId}/artifacts/bench/${session.id}`); return; }
    // Editing a plan-backed picture must not silently switch it to a paid Bench default.
    // Keep an unavailable original model too: the Bench requires a usable choice before dispatch.
    const setup = asked.setup ?? setupForMode("image", undefined, usableModels(store.state, "image"));
    sendBenchCompose(worldId, session.id, { mode: "image", provider: setup.provider, model: setup.model, params: setup.params, brief: asked.brief });
    // Edit prompt (191a): the pictures that were to ride go in as the Bench takes them, one batch, in the order the brief cites them.
    if (asked.refs !== undefined) sendBenchAddReference(worldId, session.id, asked.refs.map((path) => ({ pick: { source: "world-file" as const, path } })));
    void navigate(`/w/${worldId}/artifacts/bench/${session.id}`);
  }, [bench, worldId, navigate, store.state]);
  const generate = () => {
    pending.current = { before: bench?.session.id ?? null, brief: brief ?? pictureBrief(words, production, world, record?.look) };
    sendBenchNewSession(worldId);
  };

  // Edit prompt (R-99): the same prompt in the Bench, each carried reference attached there as `Image n`.
  const editInBench = (picked: PictureSuggestion, prompt: string) => {
    if (picked.reuse !== undefined) {
      pending.current = { before: bench?.session.id ?? null, brief: prompt, restored: true };
      sendBenchNewSession(worldId, { source: picked.reuse, prompt });
      return;
    }
    const carried = picked.who.filter((who) => who.carried && who.reference !== null);
    const cited = carried.map((who, order) => ({ name: who.name, kind: who.kind, token: `Image ${order + 1}` }));
    // Whose hand a detail shows, with the skin their sheet gives: a person's key is their sheet's id.
    const sheets = world?.sheets ?? [];
    const detailed = pictureDetailSkins(picked.shot?.details ?? [], sheets.map((sheet) => ({ key: sheet.id, name: sheet.name, sheet: sheet.id })), sheets);
    pending.current = { before: bench?.session.id ?? null, brief: pictureBench(prompt, cited, pictureMood(record?.look, productionStyleFor(production.meta, world?.artDirection.description)), detailed), refs: carried.map((who) => who.reference!),
      setup: { provider: picked.model.provider, model: picked.model.id, params: { kind: "image", count: 1, ...(picked.aspect !== undefined ? { aspect: picked.aspect } : {}) } } };
    sendBenchNewSession(worldId);
  };
  // A picture Arke made keeps the look it was made under: marked when that has since changed (R-98).
  // A look it was made with alone is judged by that look's own line (R-115, R-146), read from the kits.
  const lookChanged = pictureLookChanged(here?.entry.look, record?.look, kitLookLibrary(world?.referenceKits ?? [], record?.look), here?.entry.lookReview);

  const pad = String(chapterOrder).padStart(2, "0");
  const remove = () => setAudiobookPicture(worldId, production.meta.id, chapterFile, key, null);
  // A picture Arke made reads back as the card it was made from (194a, 194g): the prompt, model and
  // what rode from the Bench's sidecar, who was in it from its stamp, the shot where it was kept.
  const manifest = store.state?.app.manifest?.models;
  const made = useMemo(
    () => (here === null || world === null ? null : madePicture(world, manifest, here.entry, record?.look, key)),
    [here, world, manifest, record?.look, key],
  );
  // The card in hand: a suggestion being drafted or made stands over the picture's own.
  const card: PictureSuggestionState = suggestion.ask === null && made !== null ? { ...suggestion, ask: { state: "suggested", suggestion: made } } : suggestion;
  const choosePicture = connection === "open" ? () => { setPickingTall(false); setOpen(true); } : undefined;
  const chooseTall = connection === "open" && here !== null ? () => { setPickingTall(true); setOpen(true); } : undefined;
  const motionControl = here !== null && world !== null ? <AudiobookMotionControl key={key} worldId={worldId} productionId={production.meta.id} chapterFile={chapterFile} block={key} picture={here.entry} slug={world.meta.slug} label={blockName} chapterLabel={`Chapter ${chapterOrder}`} holdLabel={until ?? undefined} /> : undefined;
  // The Picture tab (design turn 194, rule 12; 194a, 194g): 193's card — the picture beside Frame,
  // Rides and the model, In frame, Not in frame, the prompt, the checks; Remove, Edit prompt and
  // Make again at the foot. When it shows and how long it holds are the chip's and the tab's, not
  // the card's: 194 draws neither here. A picture Arke did not make shows what is known of it —
  // the picture and where it came from — and, with none, the slot and Suggest picture, a press
  // away on every block. The master draws no Choose: the picture (or the empty slot) is the press
  // that picks another from the world.
  return (
    <section className="fy-ab__picture" data-testid="audiobook-picture" aria-label={`Picture · ${blockName}`}>
      {lookChanged && <p className="fy-mono fy-ab__card-line fy-ch__who-where--warn" data-testid="picture-look-changed">look changed</p>}
      {!open && world !== null && card.ask !== null ? (
        <PictureCard
          world={world}
          worldId={worldId}
          state={card}
          onEdit={editInBench}
          offline={connection !== "open"}
          picture={here === null ? null : mediaUrl(world.meta.slug, here.file)}
          shapes={bookPictureShapes(production.audiobook)}
          tall={here?.entry.tall === undefined ? null : { url: mediaUrl(world.meta.slug, here.entry.tall.file), earlier: tallFromEarlier(here.entry) }}
          mediaActions={motionControl}
          {...(here !== null ? { onRemove: remove } : {})}
          {...(choosePicture !== undefined ? { onChoose: choosePicture } : {})}
          {...(chooseTall !== undefined ? { onChooseTall: chooseTall } : {})}
          chapter={{ productionId: production.meta.id, chapterFile, order: chapterOrder, look: record?.look ?? null, ...(record?.ownLooks?.[key] !== undefined ? { own: record.ownLooks[key] } : {}) }}
        />
      ) : !open ? (
        <>
          <div className="fy-pcard__top">
            {here !== null && world !== null ? (
              <PicturePress onChoose={choosePicture}>
                <img className="fy-pcard__img fy-ab__picnow" src={mediaUrl(world.meta.slug, here.file)} alt="" data-testid="picture-card-picture" />
              </PicturePress>
            ) : (
              <button type="button" className="fy-pcard__slot fy-pcard__slot--pick" disabled={choosePicture === undefined} onClick={choosePicture} data-testid="audiobook-picture-open">
                <span className="fy-mono">Choose</span>
              </button>
            )}
            <div className="fy-pcard__facts">
              {here !== null && world !== null ? (
                <>
                  {/* A picture whose card cannot be drawn (its model gone from the manifest) still says the frame its stamp kept. */}
                  {here.entry.shot !== undefined && here.entry.shot.frame !== "" && (
                    <div className="fy-pcard__fact">
                      <span className="fy-mono">Frame</span>
                      <b data-testid="picture-card-frame">{here.entry.shot.frame}</b>
                    </div>
                  )}
                  <div className="fy-pcard__fact">
                    <span className="fy-mono">Rides</span>
                    <b data-testid="picture-card-rides">{chosenFrom(world, here.file)}</b>
                  </div>
                </>
              ) : (
                <div className="fy-pcard__fact">
                  <span className="fy-mono">Chapter {pad}</span>
                  <b>
                    {pictures.count} picture{pictures.count === 1 ? "" : "s"}
                    {pictures.lost.length > 0 ? ` · ${pictures.lost.length} lost` : ""}
                  </b>
                </div>
              )}
            </div>
          </div>
          {/* A mark's own words, its sentence to the next picture (design turn 237c): what its brief starts from. */}
          {pictureKeyParts(key).sentence !== undefined && (
            <div className="fy-pcard__sec" data-testid="picture-mark-words">
              <span className="fy-pcard__h">Words</span>
              <p className="fy-ab__markwords">{words}</p>
            </div>
          )}
          {motionControl}
          <div className="fy-abp__foot">
            {here !== null && (
              <Button variant="outline" disabled={connection !== "open"} onClick={remove} data-testid="audiobook-picture-remove">
                Remove
              </Button>
            )}
            <span className="fy-ch__panelpush" />
            <Button variant="primary" disabled={connection !== "open"} onClick={suggestion.suggest} data-testid="suggest-picture">
              Suggest picture
            </Button>
          </div>
        </>
      ) : (
        <>
          {pickingTall && <div className="fy-mono fy-ab__card-line">Choose Tall picture</div>}
          <nav className="fy-seg fy-ab__seg" aria-label="Picture from">
            {PICTURE_TABS.map((item) => (
              <button key={item.tab} type="button" className={cx("fy-seg__item", tab === item.tab && "fy-seg__item--active")} aria-pressed={tab === item.tab} onClick={() => setTab(item.tab)}>
                {item.label}
              </button>
            ))}
          </nav>
          {tab === "generated" && !pickingTall && (
            <div className="fy-ab__picgen">
              <Textarea aria-label="Brief" rows={4} value={brief ?? pictureBrief(words, production, world, record?.look)} onChange={(event) => setBrief(event.target.value)} />
              <Button variant="primary" disabled={connection !== "open"} onClick={generate} data-testid="audiobook-picture-generate">
                Generate
              </Button>
            </div>
          )}
          <div className="fy-ab__pick" role="listbox" aria-label={pickingTall ? "Tall pictures" : "Pictures"}>
            {(offered?.[tab] ?? []).map((reference) => (
              <button
                key={reference.file}
                type="button"
                role="option"
                aria-selected={(pickingTall ? here?.entry.tall?.file : here?.file) === reference.file}
                className={cx("fy-ab__pickitem", (pickingTall ? here?.entry.tall?.file : here?.file) === reference.file && "fy-ab__pickitem--on")}
                title={reference.name}
                aria-label={reference.name}
                disabled={connection !== "open"}
                onClick={() => choose(reference.file)}
              >
                {world !== null && <img src={mediaUrl(world.meta.slug, reference.file)} alt="" />}
              </button>
            ))}
            {(offered?.[tab] ?? []).length === 0 && <span className="fy-mono fy-ab__card-line">none</span>}
          </div>
          <div className="fy-ab__reads">
            <div className="fy-ab__read">
              <b>Chapter {pad}</b>
              <span>
                {pictures.count} picture{pictures.count === 1 ? "" : "s"}
                {pictures.coverAtStart ? " · cover at the start" : ""}
                {pictures.lost.length > 0 ? ` · ${pictures.lost.length} lost` : ""}
              </span>
            </div>
            {until !== null && (
              <div className="fy-ab__read">
                <b>Holds</b>
                <span>{until}</span>
              </div>
            )}
          </div>
          <div className="fy-abp__foot">
            {here !== null && !pickingTall && (
              <Button variant="outline" disabled={connection !== "open"} onClick={remove}>
                Remove
              </Button>
            )}
            <span className="fy-ch__panelpush" />
            <Button variant="primary" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
