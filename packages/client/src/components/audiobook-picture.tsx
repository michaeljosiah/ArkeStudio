import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  audiobookTextHash,
  formatRunningTime,
  pictureSpans,
  productionStyleFor,
  worldImageReferences,
  type AudiobookPictureSource,
  type ChapterAudiobook,
  type ProductionBundle,
  type WorldBundle,
  type WorldImageReference,
} from "@arke-studio/contracts";
import { usableModels } from "./dispatch-bar.js";
import { setupForMode } from "../lib/composer-mode.js";
import { mediaUrl } from "../lib/media.js";
import { sendBenchCompose, sendBenchNewSession, setAudiobookPicture, useBench, useStore } from "../lib/store.js";
import type { BlockRow } from "../screens/chapter-audiobook.js";
import { Button, Textarea, cx } from "./ui.js";

/**
 * Pictures that follow the words (design turn 186c, SPEC-047 R-60): in a chapter's Audiobook
 * view a block's panel gains Picture — one the world holds, chosen from its art, the cast's and
 * places' pictures or its scenes' frames and takes, or one generated for the book through the
 * Bench, priced and confirmed there as any image is. A chip in the block's margin shows the
 * picture and when it starts; the panel says how long it holds and flags a hold under twenty
 * seconds rather than refusing it.
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
  file: string;
  /** The block it is set on, where it is kept (a picture that followed its words keeps its old key). */
  index: number;
  at: number;
  seconds: number;
  short: boolean;
  /** The block the next picture is on, or null to the chapter's end. */
  until: number | null;
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
      return { key: row.block.key, text: row.block.text, seconds };
    });
    const { spans, lost, estimated } = pictureSpans(blocks, record?.pictures, (file) => listed.has(file));
    const byKey = new Map<string, PictureSpan>();
    for (const span of spans) byKey.set(rows[span.index]!.block.key, { file: span.picture.file, index: span.index, at: span.at, seconds: span.seconds, short: span.short, until: span.until });
    const first = spans[0];
    return { byKey, lost, estimated, count: spans.length, coverAtStart: first === undefined || first.at > 0 };
  }, [world, rows, record]);
}

const clock = (seconds: number) => formatRunningTime(seconds);
const span = (seconds: number) => {
  const whole = Math.round(seconds);
  return whole >= 60 ? `${Math.floor(whole / 60)} m ${whole % 60} s` : `${whole} s`;
};

/** The margin's chip (186c): the picture, and when it starts. */
export function PictureChip({ slug, picture, estimated }: { slug: string; picture: PictureSpan; estimated: boolean }) {
  return (
    <span className={cx("fy-ab__picchip", picture.short && "fy-ab__picchip--short")} data-testid="audiobook-picture-chip" title={picture.short ? "under 20 s" : undefined}>
      <img src={mediaUrl(slug, picture.file)} alt="" />
      {estimated ? "~" : ""}
      {clock(picture.at)}
    </span>
  );
}

/** The brief a generated picture starts from: the block's words, then the book's look (R-60). */
export function pictureBrief(words: string, production: Pick<ProductionBundle, "meta"> | null, world: Pick<WorldBundle, "artDirection"> | null): string {
  const look = productionStyleFor(production?.meta, world?.artDirection.description);
  return [`A picture for an audiobook, showing this moment: ${words.replace(/\s+/g, " ").trim()}`, ...(look !== undefined ? [`The look: ${look}`] : [])].join("\n\n");
}

export function BlockPicturePanel({ worldId, production, chapterFile, chapterOrder, row, rows, pictures }: {
  worldId: string;
  production: ProductionBundle;
  chapterFile: string;
  chapterOrder: number;
  row: BlockRow;
  rows: readonly BlockRow[];
  pictures: ReturnType<typeof useChapterPictures>;
}) {
  const store = useStore();
  const world = store.state?.world ?? null;
  const connection = store.connection;
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PictureTab>("world");
  const [brief, setBrief] = useState<string | null>(null);
  useEffect(() => {
    setOpen(false);
    setBrief(null);
  }, [row.block.key]);
  const index = rows.indexOf(row);
  const here = pictures.byKey.get(row.block.key) ?? null;
  const offered = useMemo(() => (world === null ? null : picturesByTab(world)), [world]);
  const blockName = row.block.key === "title" ? "title" : `block ${index + 1}`;
  const until = here === null ? null : here.until === null ? "end of chapter" : `until block ${here.until + 1}`;
  const choose = (file: string) => {
    const source: AudiobookPictureSource = tab;
    setAudiobookPicture(worldId, production.meta.id, chapterFile, row.block.key, { file, source });
  };

  // Generate (R-60): a new Bench session in image mode with the brief written in, then the Bench —
  // which prices and confirms the picture as any image, and files it as an artifact kept there.
  const bench = useBench();
  const pending = useRef<{ before: string | null; brief: string } | null>(null);
  useEffect(() => {
    const asked = pending.current;
    const session = bench?.session;
    if (asked === null || session === undefined || session.id === asked.before || bench?.worldId !== worldId) return;
    pending.current = null;
    const setup = setupForMode("image", undefined, usableModels(store.state, "image"));
    sendBenchCompose(worldId, session.id, { mode: "image", provider: setup.provider, model: setup.model, params: setup.params, brief: asked.brief });
    void navigate(`/w/${worldId}/artifacts/bench/${session.id}`);
  }, [bench, worldId, navigate, store.state]);
  const generate = () => {
    pending.current = { before: bench?.session.id ?? null, brief: brief ?? pictureBrief(row.block.text, production, world) };
    sendBenchNewSession(worldId);
  };

  const shownCaption = here === null
    ? null
    : `shows ${pictures.estimated ? "~" : ""}${clock(here.at)}–${clock(here.at + here.seconds)} · ${span(here.seconds)}${here.short ? " · under 20 s" : ""}`;
  const pad = String(chapterOrder).padStart(2, "0");
  return (
    <section className="fy-bible__panel fy-ab__picture" data-testid="audiobook-picture">
      <h2 className="fy-ab__blocktitle">Picture · {blockName}</h2>
      {shownCaption !== null && <p className={cx("fy-mono fy-ab__card-line", here?.short && "fy-ch__who-where--warn")}>{shownCaption}</p>}
      {!open ? (
        <div className="fy-ab__control">
          {here !== null && world !== null && <img className="fy-ab__picnow" src={mediaUrl(world.meta.slug, here.file)} alt="" />}
          <span className="fy-ch__panelpush" />
          {here !== null && (
            <Button variant="ghost" disabled={connection !== "open"} onClick={() => setAudiobookPicture(worldId, production.meta.id, chapterFile, row.block.key, null)}>
              Remove
            </Button>
          )}
          <Button variant="secondary" disabled={connection !== "open"} onClick={() => setOpen(true)} data-testid="audiobook-picture-open">
            Picture
          </Button>
        </div>
      ) : (
        <>
          <nav className="fy-seg fy-ab__seg" aria-label="Picture from">
            {PICTURE_TABS.map((item) => (
              <button key={item.tab} type="button" className={cx("fy-seg__item", tab === item.tab && "fy-seg__item--active")} aria-pressed={tab === item.tab} onClick={() => setTab(item.tab)}>
                {item.label}
              </button>
            ))}
          </nav>
          {tab === "generated" && (
            <div className="fy-ab__picgen">
              <Textarea aria-label="Brief" rows={4} value={brief ?? pictureBrief(row.block.text, production, world)} onChange={(event) => setBrief(event.target.value)} />
              <Button variant="primary" disabled={connection !== "open"} onClick={generate} data-testid="audiobook-picture-generate">
                Generate
              </Button>
            </div>
          )}
          <div className="fy-ab__pick" role="listbox" aria-label="Pictures">
            {(offered?.[tab] ?? []).map((reference) => (
              <button
                key={reference.file}
                type="button"
                role="option"
                aria-selected={here?.file === reference.file}
                className={cx("fy-ab__pickitem", here?.file === reference.file && "fy-ab__pickitem--on")}
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
          <div className="fy-ab__control">
            {here !== null && (
              <Button variant="ghost" disabled={connection !== "open"} onClick={() => setAudiobookPicture(worldId, production.meta.id, chapterFile, row.block.key, null)}>
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
