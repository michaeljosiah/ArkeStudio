import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  bookParts,
  burnedCues,
  CARD_TITLE_SHARE,
  captionFontPx,
  clockTime,
  cueAt,
  defaultVideoSubtitles,
  roughTime,
  segmentAt,
  titleCardSeconds,
  segmentFades,
  BOOK_OPENING_SEC,
  videoEstimate,
  videoPlaceLine,
  videoSegments,
  type AudiobookListening,
  type AudiobookVideoFile,
  type AudiobookVideoOptions,
  type AudiobookVideoProgress,
  type AudiobookVideoState,
  type ListeningChapter,
  type VideoShape,
  type VideoSegment,
} from "@arke-studio/contracts";
import { downloadMedia } from "../lib/download.js";
import { mediaUrl } from "../lib/media.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { cancelExport, openExportsFolder, readAudiobookVideo, setAudiobookPictureFocus, subscribeAudiobookVideoState, useWorld } from "../lib/store.js";
import { EditorDialog } from "./editor-dialog.js";

/**
 * The audiobook as a video (design turn 197): its options on the Export sheet (197a), the
 * preview with the vertical crop's focus (197b), the finished files (197e), Activity's row while
 * it renders and once it has (197d, 197f), and the phone's sheet (197f). The render itself is the
 * coordinator's; everything drawn here reads the same plan it renders from, so a frame of the
 * preview is a frame of the file.
 */

export const SHAPES: ReadonlyArray<readonly [VideoShape, string, string]> = [
  ["1920x1080", "1920 × 1080", "1080p"],
  ["1280x720", "1280 × 720", "720p"],
  ["1080x1920", "1080 × 1920 · vertical", "Vertical"],
];
export const SUBTITLES: ReadonlyArray<readonly [AudiobookVideoOptions["subtitles"], string]> = [
  ["sidecar", "Sidecar"],
  ["burn-in", "Burned in"],
  ["burn-in+sidecar", "Both"],
  ["none", "None"],
];
const burnsIn = (options: AudiobookVideoOptions) => options.subtitles === "burn-in" || options.subtitles === "burn-in+sidecar";

export const megabytes = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

export function Check() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}
export function Folder() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M3 7h6l2 2h10v10H3z" />
    </svg>
  );
}

export function Seg<T extends string>({ value, options, onChange, disabled = false, label }: { value: T | null; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void; disabled?: boolean; label: string }) {
  return (
    <span className="fy-abv-seg" role="radiogroup" aria-label={label}>
      {options.map(([key, text]) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} className={value === key ? "on" : ""} disabled={disabled} onClick={() => onChange(key)}>
          {text}
        </button>
      ))}
    </span>
  );
}

export function Toggle({ on, onChange, children }: { on: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" className="fy-abv-chk" role="checkbox" aria-checked={on} onClick={() => onChange(!on)}>
      <span className={on ? "fy-abv-box on" : "fy-abv-box"}>{on && <Check />}</span>
      {children}
    </button>
  );
}

/** The chapters a video takes: read whole, as the player package does. */
export const wholeChapters = (plan: AudiobookListening) => plan.chapters.filter((chapter) => chapter.state === "read" && chapter.blocks.length > 0);

/** What the sheet is told before Render, asked again whenever the options change. */
export function useVideoState(worldId: string, productionId: string, options: AudiobookVideoOptions, connected: boolean, again: number): AudiobookVideoState | null {
  const asked = useRef<string | null>(null);
  const [state, setState] = useState<AudiobookVideoState | null>(null);
  useEffect(
    () =>
      subscribeAudiobookVideoState((answer) => {
        if (answer.requestId === asked.current && answer.state !== null) setState(answer.state);
      }),
    [],
  );
  const key = JSON.stringify(options);
  useEffect(() => {
    if (connected) asked.current = readAudiobookVideo(worldId, productionId, options);
  }, [worldId, productionId, key, connected, again]);
  return state;
}

/** Size and time before Render (rule 9), the files it makes and what the press says. */
export function videoQuote(state: AudiobookVideoState | null, options: AudiobookVideoOptions) {
  if (state === null) return null;
  const chapters = state.chapters;
  const parts = bookParts(chapters);
  const videoSec = chapters.reduce((sum, chapter) => sum + chapter.seconds, 0) + (options.files === "book" ? parts.length * BOOK_OPENING_SEC : 0);
  const toRender = chapters.filter((chapter) => !chapter.rendered);
  const renderSec = toRender.reduce((sum, chapter) => sum + chapter.seconds, 0);
  const estimate = videoEstimate({ shape: options.shape, slowPush: options.slowPush, videoSec, renderSec, rates: state.rates });
  const files = options.files === "book" ? parts.length : chapters.length;
  const tilde = estimate.measured ? "" : "~";
  const price = `${options.files === "book" && files > 1 ? `${files} files · ` : ""}${tilde}${megabytes(estimate.bytes)} · ${renderSec > 0 ? `${tilde}${roughTime(estimate.seconds)}` : "already rendered"}`;
  const rendered = chapters.length - toRender.length;
  const meta = `${clockTime(videoSec)} of video · ${rendered > 0 ? `${rendered} rendered · ` : ""}${toRender.length} to render`;
  const count = toRender.length > 0 ? toRender.length : chapters.length;
  const press = options.files === "book" ? (parts.length > 1 ? `Render ${parts.length} parts` : "Render 1 file") : `Render ${count} chapter${count === 1 ? "" : "s"}`;
  const split = options.files === "book" ? (parts.length > 1 ? `${parts.length} parts · ${parts.map((part) => roughTime(part.seconds)).join(", ")}` : "1 file") : `${files} file${files === 1 ? "" : "s"}`;
  return { price, meta, press, split, empty: chapters.length === 0 };
}

/** The Video options (197a): Files, Shape, Pictures, Subtitles, Openings, Chapters, Audio. */
export function VideoOptionRows({ options, setOptions, plan, split, onShape }: { options: AudiobookVideoOptions; setOptions: (next: AudiobookVideoOptions) => void; plan: AudiobookListening | null; split: string; onShape: (shape: VideoShape) => void }) {
  const whole = plan === null ? [] : wholeChapters(plan);
  const pictures = new Set(whole.flatMap((chapter) => chapter.pictures.map((picture) => picture.file))).size;
  const burned = burnsIn(options);
  return (
    <>
      <div className="fy-abv-opt">
        <b>Files</b>
        <Seg label="Files" value={options.files} options={[["chapter", "One a chapter"], ["book", "One for the book"]] as const} onChange={(files) => setOptions({ ...options, files })} />
        <span className="grow" />
        <i>{split}</i>
      </div>
      <div className="fy-abv-opt">
        <b>Shape</b>
        <Seg label="Shape" value={options.shape} options={SHAPES.map(([key, text]) => [key, text] as const)} onChange={onShape} />
      </div>
      <div className="fy-abv-opt">
        <b>Pictures</b>
        <Toggle on={options.slowPush} onChange={(slowPush) => setOptions({ ...options, slowPush })}>
          Slow push
        </Toggle>
        <span className="grow" />
        <i>
          {pictures} picture{pictures === 1 ? "" : "s"}
          {plan?.cover !== null && plan !== null ? " · cover before the first" : ""}
        </i>
      </div>
      <div className="fy-abv-opt">
        <b>Subtitles</b>
        <Seg label="Subtitles" value={options.subtitles} options={SUBTITLES} onChange={(subtitles) => setOptions({ ...options, subtitles })} />
        <span className="grow" />
        <Seg label="Position" value={options.captionPosition} options={[["bottom", "Bottom"], ["middle", "Middle"]] as const} disabled={!burned} onChange={(captionPosition) => setOptions({ ...options, captionPosition })} />
        <Seg label="Size" value={options.captionSize} options={[["s", "S"], ["m", "M"], ["l", "L"]] as const} disabled={!burned} onChange={(captionSize) => setOptions({ ...options, captionSize })} />
      </div>
      <div className="fy-abv-opt">
        <b>Openings</b>
        <Toggle on={options.titleCards} onChange={(titleCards) => setOptions({ ...options, titleCards })}>
          Chapter title cards
        </Toggle>
        <span className="grow" />
        <i>chapter markers in the file</i>
      </div>
      <div className="fy-abv-opt">
        <b>Chapters</b>
        <span>
          {whole.length} of {plan?.chapters.length ?? 0} · read whole
        </span>
        <span className="grow" />
        <i>{whole.map((chapter) => chapter.title).join(", ")}</i>
      </div>
      <div className="fy-abv-opt">
        <b>Audio</b>
        <span>The chapter mix, as Timing sets it</span>
        <span className="grow" />
        <i>−18 LUFS · AAC 128 kbps · 48 kHz</i>
      </div>
    </>
  );
}

/** Choosing a shape moves the subtitles to that shape's default until the author has chosen them (rule 5). */
export function withShape(options: AudiobookVideoOptions, shape: VideoShape, chosen: boolean): AudiobookVideoOptions {
  return { ...options, shape, ...(chosen ? {} : { subtitles: defaultVideoSubtitles(shape) }) };
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// A frame of the video (197b, 197c).

type Natural = Record<string, { width: number; height: number }>;

/** The ffmpeg crop, as the render takes it: a 9:16 column (or row) around the focus, kept inside. */
function cropBox(width: number, height: number, focus: { x: number; y: number }) {
  const cw = Math.min(width, (height * 9) / 16);
  const ch = Math.min(height, (width * 16) / 9);
  const x = Math.max(0, Math.min(width - cw, width * focus.x - cw / 2));
  const y = Math.max(0, Math.min(height - ch, height * focus.y - ch / 2));
  return { x, y, cw, ch };
}

function Frame({
  url,
  segment,
  width,
  height,
  vertical,
  caption,
  captionSize,
  position,
  natural,
  onNatural,
  burned,
}: {
  url: (file: string) => string;
  segment: VideoSegment | null;
  width: number;
  height: number;
  vertical: boolean;
  caption: string | null;
  captionSize: number;
  position: "bottom" | "middle";
  natural: Natural;
  onNatural: (file: string, size: { width: number; height: number }) => void;
  burned: boolean;
}) {
  const file = segment?.file ?? null;
  const known = file === null ? undefined : natural[file];
  let picture: ReactNode = null;
  if (segment !== null && file !== null) {
    const load = (event: { currentTarget: HTMLImageElement }) => onNatural(file, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
    if (segment.kind === "card" || segment.kind === "cover") picture = <img className="blur" src={url(file)} alt="" onLoad={load} />;
    else if (!vertical) picture = <img className="fit" src={url(file)} alt="" onLoad={load} />;
    else if (known === undefined) picture = <img className="fill" src={url(file)} alt="" onLoad={load} />;
    else {
      const box = cropBox(known.width, known.height, segment.focus ?? { x: 0.5, y: 0.5 });
      const scale = width / box.cw;
      picture = <img src={url(file)} alt="" onLoad={load} style={{ left: -box.x * scale, top: -box.y * scale, width: known.width * scale, height: known.height * scale }} />;
    }
  }
  return (
    <div className="fy-abv-vid" style={{ width, height }}>
      {picture}
      {segment?.kind === "card" && (
        <div className="card">
          <b style={{ fontSize: Math.round(Math.min(width, height) * CARD_TITLE_SHARE) }}>{segment.title}</b>
        </div>
      )}
      {burned && segment?.kind !== "card" && <div className="scr" />}
      {burned && caption !== null && (
        <div className="cap" style={{ fontSize: captionSize, whiteSpace: "pre-line", ...(position === "middle" ? { top: "50%", transform: "translateY(-50%)" } : { bottom: "9%" }) }}>
          {caption}
        </div>
      )}
    </div>
  );
}

/** The preview (197b): a frame at 16:9 and at 9:16 as they will render, and the vertical crop's focus. */
export function VideoPreview({ worldId, productionId, plan, options, onClose }: { worldId: string; productionId: string; plan: AudiobookListening; options: AudiobookVideoOptions; onClose: () => void }) {
  const world = useWorld();
  const slug = world?.meta.slug ?? "";
  const url = (file: string) => mediaUrl(slug, file);
  const whole = wholeChapters(plan);
  // The book's first chapter read whole: 197b previews one chapter and draws no way to another.
  const chapter: ListeningChapter | undefined = whole[0];
  /** Focus as dragged here, kept until the plan is read again with it. */
  const [moved, setMoved] = useState<Record<string, { x: number; y: number } | null>>({});
  const shown = useMemo(() => (chapter === undefined ? undefined : { ...chapter, pictures: chapter.pictures.map((picture) => (picture.key in moved ? { ...picture, ...(moved[picture.key] === null ? { focus: undefined } : { focus: moved[picture.key]! }) } : picture)) }), [chapter, moved]);
  const segments = useMemo(() => (shown === undefined ? [] : videoSegments(shown, plan.cover, options.titleCards)), [shown, plan.cover, options.titleCards]);
  const [at, setAt] = useState(() => chapter?.pictures[0]?.at ?? 0);
  const [playing, setPlaying] = useState(false);
  const [natural, setNatural] = useState<Natural>({});
  const onNatural = (file: string, size: { width: number; height: number }) => setNatural((held) => (held[file]?.width === size.width && held[file]?.height === size.height ? held : { ...held, [file]: size }));
  const audio = useRef<HTMLAudioElement | null>(null);
  const seconds = chapter?.seconds ?? 0;
  const after = shown === undefined ? 0 : options.titleCards ? titleCardSeconds(shown) + (segmentFades(segments)[1] ?? 0) : 0;
  const landscape: VideoShape = options.shape === "1080x1920" ? "1920x1080" : options.shape;
  const wide = shown === undefined ? [] : burnedCues(shown, landscape, options.captionSize, after);
  const tall = shown === undefined ? [] : burnedCues(shown, "1080x1920", options.captionSize, after);
  const segment = segmentAt(segments, at);
  const burned = burnsIn(options);
  // The picture whose focus the column sets: the one showing, else the chapter's first.
  const target = segment?.kind === "picture" ? segment : (segments.find((candidate) => candidate.kind === "picture") ?? null);
  const focus = target?.focus ?? { x: 0.5, y: 0.5 };

  // Play: the chapter's mix where the plan has one, else its takes one after another from here.
  useEffect(() => {
    const element = audio.current;
    if (element === null || chapter === undefined) return;
    if (!playing) {
      element.pause?.();
      return;
    }
    const startAt = (time: number) => {
      if (chapter.mix !== undefined) {
        element.src = url(chapter.mix.file);
        element.currentTime = time;
      } else {
        const block = chapter.blocks.find((candidate) => time >= candidate.at && time < candidate.at + candidate.seconds) ?? chapter.blocks.find((candidate) => candidate.at >= time);
        if (block === undefined) {
          setPlaying(false);
          return;
        }
        element.src = url(block.file);
        element.currentTime = Math.max(0, time - block.at);
        element.dataset["at"] = String(block.at);
      }
      void element.play?.()?.catch(() => setPlaying(false));
    };
    const tick = () => setAt(chapter.mix !== undefined ? element.currentTime : Number(element.dataset["at"] ?? 0) + element.currentTime);
    const ended = () => {
      if (chapter.mix !== undefined) return setPlaying(false);
      const next = chapter.blocks.find((candidate) => candidate.at > Number(element.dataset["at"] ?? 0));
      if (next === undefined) setPlaying(false);
      else startAt(next.at);
    };
    element.addEventListener("timeupdate", tick);
    element.addEventListener("ended", ended);
    startAt(at);
    return () => {
      element.removeEventListener("timeupdate", tick);
      element.removeEventListener("ended", ended);
      element.pause?.();
    };
  }, [playing]);

  const seek = (time: number) => {
    setPlaying(false);
    setAt(Math.max(0, Math.min(seconds - 0.01, time)));
  };
  const setFocus = (next: { x: number; y: number } | null) => {
    if (target?.key === undefined || chapter === undefined) return;
    setMoved((held) => ({ ...held, [target.key!]: next }));
    setAudiobookPictureFocus(worldId, productionId, chapter.chapterId, target.key, next);
  };
  // The focus column: the picture letterboxed in a 16:9 box, the crop and the focus drawn over it.
  const FW = 300;
  const FH = 169;
  const size = target?.file ? natural[target.file] : undefined;
  const fit = size === undefined ? { left: 0, top: 0, width: FW, height: FH } : (() => {
    const scale = Math.min(FW / size.width, FH / size.height);
    return { left: (FW - size.width * scale) / 2, top: (FH - size.height * scale) / 2, width: size.width * scale, height: size.height * scale };
  })();
  const dragging = useRef(false);
  const pointAt = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left - fit.left) / fit.width;
    const y = (event.clientY - rect.top - fit.top) / fit.height;
    return { x: Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000, y: Math.round(Math.min(1, Math.max(0, y)) * 1000) / 1000 };
  };
  const [dragFocus, setDragFocus] = useState<{ x: number; y: number } | null>(null);
  const drawn = dragFocus ?? focus;
  const drawnCrop = size === undefined ? null : cropBox(size.width, size.height, drawn);

  const shapeNote = options.shape === "1080x1920" ? "9:16 · 1080×1920" : `16:9 · ${options.shape.replace("x", "×")}`;
  const captionNote = burned ? `burned-in captions, ${options.captionPosition}, ${options.captionSize.toUpperCase()}` : options.subtitles === "sidecar" ? "sidecar captions" : "no captions";
  const thumbs: Array<{ file: string; at: number; label: string }> = [
    ...(plan.cover !== null ? [{ file: plan.cover, at: 0, label: "0:00 · cover" }] : []),
    ...(chapter?.pictures ?? []).map((picture) => ({ file: picture.file, at: picture.at, label: clockTime(picture.at) })),
  ];
  const current = segment?.kind === "picture" ? segment.file : plan.cover;

  return (
    <EditorDialog open onClose={onClose} width={1280} labelledBy="audiobook-video-preview" panelClassName="fy-abv-sheet fy-abv-preview">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }} data-testid="audiobook-video-preview">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h3 id="audiobook-video-preview">Preview · {chapter?.title ?? ""}</h3>
          <span className="fy-abv-note">
            {shapeNote} · {captionNote}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="fy-abv-btn" onClick={onClose}>
            Done
          </button>
        </div>
        <div style={{ display: "flex", gap: 28, alignItems: "flex-start" }}>
          <Frame url={url} segment={segment} width={720} height={405} vertical={false} caption={cueAt(wide, at)?.text ?? null} captionSize={captionFontPx(landscape, options.captionSize, 405)} position={options.captionPosition} natural={natural} onNatural={onNatural} burned={burned} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Frame url={url} segment={segment === null ? null : { ...segment, ...(segment.kind === "picture" ? { focus: drawn } : {}) }} width={228} height={405} vertical caption={cueAt(tall, at)?.text ?? null} captionSize={captionFontPx("1080x1920", options.captionSize, 405)} position={options.captionPosition} natural={natural} onNatural={onNatural} burned={burned} />
          </div>
          {target !== null && target.file !== null && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minWidth: 0 }}>
              <b style={{ font: "var(--type-label)", color: "var(--muted-foreground)" }}>9:16 · focus</b>
              <div
                className="fy-abv-vid fy-abv-drag"
                style={{ width: FW, height: FH }}
                data-testid="audiobook-video-focus"
                onPointerDown={(event) => {
                  dragging.current = true;
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  setDragFocus(pointAt(event));
                }}
                onPointerMove={(event) => {
                  if (dragging.current) setDragFocus(pointAt(event));
                }}
                onPointerUp={(event) => {
                  if (!dragging.current) return;
                  dragging.current = false;
                  const next = pointAt(event);
                  setDragFocus(null);
                  setFocus(next);
                }}
              >
                <img src={url(target.file)} alt="" onLoad={(event) => onNatural(target.file!, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} style={{ left: fit.left, top: fit.top, width: fit.width, height: fit.height }} />
                {drawnCrop !== null && size !== undefined && <div className="fy-abv-crop" style={{ left: fit.left + (drawnCrop.x / size.width) * fit.width, width: (drawnCrop.cw / size.width) * fit.width, top: fit.top + (drawnCrop.y / size.height) * fit.height, bottom: FH - fit.top - ((drawnCrop.y + drawnCrop.ch) / size.height) * fit.height }} />}
                <div className="fy-abv-focus" style={{ left: fit.left + drawn.x * fit.width, top: fit.top + drawn.y * fit.height }} />
              </div>
              <span className="fy-abv-note">drag to set · kept on the picture</span>
              <button type="button" className="fy-abv-btn" style={{ alignSelf: "flex-start" }} onClick={() => setFocus(null)}>
                Centre
              </button>
            </div>
          )}
        </div>
        <div className="fy-abv-scrub">
          <button type="button" className="fy-abv-btn" aria-label={playing ? "Pause" : "Play"} style={{ height: 28, width: 28, padding: 0, justifyContent: "center" }} onClick={() => setPlaying(!playing)}>
            {playing ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
              </svg>
            ) : (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M7 4.5v15l13-7.5z" />
              </svg>
            )}
          </button>
          <span>{clockTime(at)}</span>
          <span
            className="bar"
            role="slider"
            aria-label="Time"
            aria-valuemin={0}
            aria-valuemax={Math.round(seconds)}
            aria-valuenow={Math.round(at)}
            tabIndex={0}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              seek(((event.clientX - rect.left) / Math.max(1, rect.width)) * seconds);
            }}
          >
            <i style={{ width: `${seconds > 0 ? (at / seconds) * 100 : 0}%` }} />
            {thumbs.map((thumb) => (
              <u key={`${thumb.file}-${thumb.at}`} style={{ left: `${seconds > 0 ? (thumb.at / seconds) * 100 : 0}%` }} />
            ))}
          </span>
          <span>{clockTime(seconds)}</span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {thumbs.map((thumb) => (
            <button type="button" key={`${thumb.file}-${thumb.at}`} className={thumb.file === current && (thumb.at > 0 || segment?.kind !== "picture") ? "fy-abv-thumb on" : "fy-abv-thumb"} onClick={() => seek(thumb.at + 0.01)}>
              <div className="fy-abv-vid">
                <img className="fill" src={url(thumb.file)} alt="" />
              </div>
              <span className="fy-abv-note">{thumb.label}</span>
            </button>
          ))}
        </div>
        <audio ref={audio} preload="none" />
      </div>
    </EditorDialog>
  );
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// The finished files (197e).

const shapeLabel = (shape: VideoShape) => shape.replace("x", "×");

export function VideoFiles({ worldId, dir, files, onOpen }: { worldId: string; dir: string; files: AudiobookVideoFile[]; onOpen?: (file: AudiobookVideoFile) => void }) {
  const world = useWorld();
  const remote = isRemoteSession() || typeof window === "undefined" || window.arke?.openDataFolder === undefined;
  const folder = dir.slice("exports/".length);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      {files.map((file) => (
        <div key={file.name} className="fy-abv-file" data-testid="audiobook-video-file">
          {file.picture !== null && world !== null ? <img src={mediaUrl(world.meta.slug, file.picture)} alt="" /> : <span className="ph" />}
          <div>
            <div>{file.name}</div>
            <div className="m">
              {[clockTime(file.seconds), shapeLabel(file.shape), megabytes(file.bytes), ...(file.sidecars.length > 0 ? [file.sidecars.join(" ")] : [])].join(" · ")}
            </div>
          </div>
          <div className="fy-abv-acts">
            {remote ? (
              <button
                type="button"
                className="fy-abv-btn"
                onClick={async () => {
                  setProblem(null);
                  const result = await downloadMedia(world?.meta.slug, `${dir}/${file.name}`, file.name, "video");
                  if (!result.ok && !result.cancelled) setProblem(result.reason);
                }}
              >
                Download
              </button>
            ) : (
              <>
                <button type="button" className="fy-abv-btn" onClick={() => (onOpen ? onOpen(file) : openExportsFolder(worldId, folder, file.name))}>
                  Open
                </button>
                <button
                  type="button"
                  className="fy-abv-btn"
                  onClick={() => {
                    const reveal = window.arke?.revealMedia;
                    if (reveal !== undefined && world !== null) void reveal(world.meta.slug, `${dir}/${file.name}`);
                    else openExportsFolder(worldId, folder);
                  }}
                >
                  <Folder />
                  Show in folder
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      {problem !== null && <div className="fy-abv-warn">{problem}</div>}
    </>
  );
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// Activity (197d, 197f).

/** A video rendering, as one Activity row: the book, a percent, Cancel; the bar; where it is. */
export function VideoRunningRow({ exportId, worldId, video, percent, phone }: { exportId: string; worldId: string | null; video: AudiobookVideoProgress; percent: number; phone: boolean }) {
  const remote = isRemoteSession();
  const left = video.leftSec !== null ? ` · ~${roughTime(video.leftSec)} left` : "";
  return (
    <div className="fy-abv-row" data-testid="audiobook-video-running">
      <div className="t">
        <b>{phone ? `Video · ${Math.round(percent)}%` : `Video · ${video.title}`}</b>
        {!phone && <span className="m">{Math.round(percent)}%</span>}
        {worldId !== null && (
          <button type="button" className="fy-abv-btn" onClick={() => cancelExport(worldId, exportId)}>
            Cancel
          </button>
        )}
      </div>
      <div className="fy-abv-prog">
        <i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
      </div>
      <span className="m">{phone ? `Chapter ${Math.max(1, video.chapter)} of ${video.of}${left}${remote ? " · on the desktop" : ""}` : videoPlaceLine(video)}</span>
    </div>
  );
}

/** A finished video in Activity (197f): its shape and size, and the file to open or download. */
export function VideoDoneRow({ worldId, dir, file }: { worldId: string; dir: string; file: AudiobookVideoFile }) {
  const world = useWorld();
  const remote = isRemoteSession() || typeof window === "undefined" || window.arke?.openDataFolder === undefined;
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="fy-abv-row" data-testid="audiobook-video-done">
      <div className="t">
        <b>Video · {file.shape.replace("x", " × ")}</b>
        <span className="m">done · {megabytes(file.bytes)}</span>
      </div>
      <div className="fy-abv-acts">
        {remote ? (
          <button
            type="button"
            className="fy-abv-btn"
            onClick={async () => {
              setProblem(null);
              const result = await downloadMedia(world?.meta.slug, `${dir}/${file.name}`, file.name, "video");
              if (!result.ok && !result.cancelled) setProblem(result.reason);
            }}
          >
            Download
          </button>
        ) : (
          <>
            <button type="button" className="fy-abv-btn" onClick={() => openExportsFolder(worldId, dir.slice("exports/".length), file.name)}>
              Open
            </button>
            <button type="button" className="fy-abv-btn" onClick={() => openExportsFolder(worldId, dir.slice("exports/".length))}>
              <Folder />
              Show in folder
            </button>
          </>
        )}
      </div>
      <span className="m">
        {remote ? "kept on the desktop · " : ""}
        {dir}/
      </span>
      {problem !== null && <span className="fy-abv-warn">{problem}</span>}
    </div>
  );
}
