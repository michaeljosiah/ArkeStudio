import { createHash } from "node:crypto";
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSlateLabelSupported,
  AudiobookVideoOptionsSchema,
  BOOK_OPENING_SEC,
  bookParts,
  burnedCues,
  CAPTION_BOTTOM_SHARE,
  CARD_TITLE_SHARE,
  captionFontPx,
  chapterCues,
  ffmpegDrawtextText,
  ffmpegFilterPath,
  OPENING_CAPTION_SHARE,
  SCRIM_HEIGHT_SHARE,
  SCRIM_OPACITY,
  segmentFades,
  serializeTimedText,
  shapeSize,
  titleCardSeconds,
  VIDEO_FPS,
  VIDEO_PUSH,
  videoFileName,
  videoFolderName,
  videoRateKey,
  videoSegments,
  wrapWords,
  type AudiobookVideoFile,
  type AudiobookVideoOptions,
  type AudiobookVideoProgress,
  type AudiobookVideoResult,
  type AudiobookVideoState,
  type ListeningChapter,
  type VideoCue,
  type VideoRates,
  type VideoSegment,
} from "@arke-studio/contracts";
import type { FfmpegRunner } from "../takes/export.js";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { anyNarrator, audiobookListening } from "./audiobook-listening.js";
import { containedWorldFile } from "./interactive.js";

/**
 * The audiobook as a video (design turn 197, SPEC-047): what the player shows rendered to MP4 on
 * this machine, through the ffmpeg the app ships for the Cut.
 *
 * A chapter is one encode. Its pictures are held as the player holds them, each crossfading into
 * the next over a second, moving 6% toward its focus when Slow push is on; the cover, blurred and
 * dimmed, shows before the first; a title card holds while the title is read. The sound is the
 * chapter's one mix from the renderer the chapter's Play uses, encoded once; the words are timed
 * by the player's own Text plan, burned in, carried as a text track, or both.
 *
 * Never twice (rule 11): each chapter's video is kept in the world's cache under a digest of
 * everything that touches its pixels and sound, and a render makes only the chapters whose digest
 * is new. A book file is joined from those pieces. A render keeps a note of itself while it runs,
 * so one cut short by the app closing starts again from the next chapter not yet made.
 */

/** Moves when what a render makes from the same inputs changes, so an older render is never reused. */
export const VIDEO_RENDER_VERSION = 1;

const EXPORT_ID = /^vb_[0-9A-HJKMNP-TV-Z]{26}$/;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export function videoCacheFolder(productionId: string): string {
  return join(".cache", "audiobook-video", productionId);
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// What a render would make.

interface PlannedChapter {
  chapter: ListeningChapter;
  segments: VideoSegment[];
  /** The words burned into the picture; empty when they are not. */
  burned: VideoCue[];
  /** The text track and the sidecar files; empty when there are none. */
  cues: VideoCue[];
  /** The world-relative mix the sound comes from. */
  mix: string;
  digest: string;
}

interface Book {
  title: string;
  cover: string | null;
  readBy: string;
  chapters: PlannedChapter[];
  /** What kept a chapter read whole out, said by name. */
  blockers: string[];
}

const wantsBurnIn = (options: AudiobookVideoOptions) => options.subtitles === "burn-in" || options.subtitles === "burn-in+sidecar";
const wantsSidecar = (options: AudiobookVideoOptions) => options.subtitles === "sidecar" || options.subtitles === "burn-in+sidecar";

/** A picture's identity on disk: a file replaced under the same name is another picture to the cache. */
async function fileStamp(store: WorldStore, file: string | null): Promise<string> {
  if (file === null) return "none";
  const real = await containedWorldFile(store.dir, file);
  if (real === null) return `${file}:missing`;
  const info = await stat(toExtendedLength(real)).catch(() => null);
  return info === null ? `${file}:missing` : `${file}:${info.size}:${Math.round(info.mtimeMs)}`;
}

/**
 * The book as the video would show it: every chapter read whole, each on its one mix, with its
 * pictures, its words and its digest. `render` false reads only the mixes already made, so the
 * sheet can say what a render would make without making anything.
 */
async function planBook(store: WorldStore, productionId: string, options: AudiobookVideoOptions, ffmpeg: FfmpegRunner | undefined): Promise<Book> {
  const listening = await audiobookListening(store, productionId, { ...(ffmpeg !== undefined ? { ffmpeg } : {}), mixAll: true });
  const narrator = await anyNarrator(store, productionId);
  const readBy = `Read by ${narrator.label ?? narrator.voiceId}’s voice`;
  const blockers: string[] = [];
  const chapters: PlannedChapter[] = [];
  for (const chapter of listening.chapters) {
    if (chapter.state !== "read" || chapter.blocks.length === 0) continue;
    if (chapter.mix === undefined) {
      blockers.push(`${chapter.title}: its mix could not be made on this machine`);
      continue;
    }
    const segments = videoSegments(chapter, listening.cover, options.titleCards);
    // No words over a card: the title is what is being read, and a caption over the title (or
    // over it fading) reads as two lines fighting. A sentence begun under the card shows from
    // the moment the card has given way, to its own end.
    const after = options.titleCards ? titleCardSeconds(chapter) + (segmentFades(segments)[1] ?? 0) : 0;
    const burned = wantsBurnIn(options) ? burnedCues(chapter, options.shape, options.captionSize, after) : [];
    const cues = wantsSidecar(options) ? chapterCues(chapter) : [];
    const stamps = await Promise.all(segments.map((segment) => fileStamp(store, segment.file)));
    const digest = sha(
      JSON.stringify({
        version: VIDEO_RENDER_VERSION,
        mix: [chapter.mix.file, chapter.seconds],
        segments: segments.map((segment, index) => [segment.kind, stamps[index], segment.from, segment.to, segment.focus ?? null, segment.title ?? null]),
        burned,
        cues,
        options: { shape: options.shape, slowPush: options.slowPush, subtitles: options.subtitles, position: options.captionPosition, size: options.captionSize, titleCards: options.titleCards },
      }),
    ).slice(0, 24);
    chapters.push({ chapter, segments, burned, cues, mix: chapter.mix.file, digest });
  }
  return { title: listening.title, cover: listening.cover, readBy, chapters, blockers };
}

const cachedPiece = (store: WorldStore, productionId: string, planned: PlannedChapter) => join(store.dir, videoCacheFolder(productionId), planned.chapter.chapterId, `${planned.digest}.mp4`);

const exists = (path: string) => stat(toExtendedLength(path)).then((info) => info.isFile() && info.size > 0, () => false);

// ————————————————————————————————————————————————————————————————————————————————————————————
// This machine's rates (rule 9): kept per device, beside the app's own settings.

const ratesFile = (appRoot: string) => join(appRoot, "audiobook-video-rates.json");
const memoryRates: VideoRates = {};

export async function readVideoRates(appRoot: string | undefined): Promise<VideoRates> {
  if (appRoot === undefined) return { ...memoryRates };
  try {
    const raw = JSON.parse(await readFile(toExtendedLength(ratesFile(appRoot)), "utf8")) as Record<string, { bytesPerSec?: unknown; speed?: unknown }>;
    const out: VideoRates = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value?.bytesPerSec === "number" && typeof value.speed === "number" && value.bytesPerSec > 0 && value.speed > 0) out[key] = { bytesPerSec: value.bytesPerSec, speed: value.speed };
    }
    return out;
  } catch {
    return {};
  }
}

async function recordRate(appRoot: string | undefined, key: string, rate: { bytesPerSec: number; speed: number }): Promise<void> {
  if (appRoot === undefined) {
    memoryRates[key] = rate;
    return;
  }
  const rates = await readVideoRates(appRoot);
  rates[key] = { bytesPerSec: Math.round(rate.bytesPerSec), speed: Math.round(rate.speed * 100) / 100 };
  await atomicWriteFile(ratesFile(appRoot), `${JSON.stringify(rates, null, 2)}\n`).catch(() => {});
}

/** What a render with these options would make: each chapter read whole and whether it is already in the cache. */
export async function audiobookVideoState(store: WorldStore, productionId: string, options: AudiobookVideoOptions, context: { ffmpeg?: FfmpegRunner; appRoot?: string; running: string | null }): Promise<AudiobookVideoState> {
  const book = await planBook(store, productionId, options, context.ffmpeg);
  const chapters = await Promise.all(book.chapters.map(async (planned) => ({ chapterId: planned.chapter.chapterId, seconds: planned.chapter.seconds, rendered: await exists(cachedPiece(store, productionId, planned)) })));
  return { chapters, rates: await readVideoRates(context.appRoot), readBy: book.readBy, running: context.running };
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// One chapter's encode.

/** A scrim from clear at its top to 72% black at the foot, one frame, laid over every frame after. */
function scrimSource(width: number, height: number): string {
  const tall = Math.round(height * SCRIM_HEIGHT_SHARE);
  return `color=c=black:s=${width}x${tall}:r=${VIDEO_FPS}:d=${(1 / VIDEO_FPS).toFixed(4)},format=rgba,geq=r=0:g=0:b=0:a='${Math.round(255 * SCRIM_OPACITY)}*Y/H'`;
}

const textOptions = (font: string, size: number) =>
  // The face is the bundled Geist at its one weight; a hairline of the same white stands for the
  // player's 600, and the shadow is the player's `0 1px 3px` scaled to the frame.
  `expansion=none:fontfile=${ffmpegFilterPath(font)}:fontcolor=white:fontsize=${size}:borderw=${Math.max(1, Math.round(size * 0.025))}:bordercolor=white:shadowcolor=black@0.6:shadowx=0:shadowy=${Math.max(1, Math.round(size * 0.04))}:line_spacing=${Math.round(size * 0.1)}:text_align=C`;

/** The filter graph for one chapter, written to a file: a long chapter's words outrun a command line. */
function chapterGraph(
  planned: PlannedChapter,
  options: AudiobookVideoOptions,
  font: string,
  inputs: { file: (index: number) => number | null },
): string {
  const { width: W, height: H } = shapeSize(options.shape);
  const vertical = options.shape === "1080x1920";
  const fades = segmentFades(planned.segments);
  const filters: string[] = [];
  const short = Math.min(W, H);
  const blur = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=${Math.round(H * 0.08)},colorchannelmixer=rr=0.6:gg=0.6:bb=0.6`;
  planned.segments.forEach((segment, index) => {
    const length = segment.to - segment.from + (fades[index + 1] ?? 0);
    // A frame of slack past the crossfade: the fade reads the first input's frames up to its end.
    const frames = Math.ceil(length * VIDEO_FPS) + 1;
    const input = inputs.file(index);
    const hold = `loop=loop=${frames - 1}:size=1:start=0,settb=1/${VIDEO_FPS},setpts=N,fps=${VIDEO_FPS}`;
    const out = `[s${index}]`;
    if (input === null || segment.file === null) {
      filters.push(`color=c=black:s=${W}x${H}:r=${VIDEO_FPS}:d=${(frames / VIDEO_FPS).toFixed(3)},format=yuv420p,setsar=1,settb=1/${VIDEO_FPS}${out}`);
      return;
    }
    if (segment.kind === "cover") {
      filters.push(`[${input}:v]${blur},setsar=1,format=yuv420p,${hold}${out}`);
      return;
    }
    if (segment.kind === "card") {
      const size = Math.round(short * CARD_TITLE_SHARE);
      const lines = wrapWords(segment.title ?? "", Math.max(10, Math.floor((W * 0.84) / (size * 0.55))));
      const title = lines.length > 0 ? `,drawtext=${textOptions(font, size)}:text='${ffmpegDrawtextText(lines.join("\n"))}':x=(w-tw)/2:y=(h-th)/2` : "";
      filters.push(`[${input}:v]${blur},drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill${title},setsar=1,format=yuv420p,${hold}${out}`);
      return;
    }
    // A picture: letterboxed at 16:9 when its shape differs, never cropped to a face (rule 4);
    // vertical, a full-height column around its focus, kept inside the picture (rule 3).
    const fx = segment.focus?.x ?? 0.5;
    const fy = segment.focus?.y ?? 0.5;
    const scale = options.slowPush ? 2 : 1;
    const fit = vertical
      ? `crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)':x='max(0,min(iw-ow,iw*${fx}-ow/2))':y='max(0,min(ih-oh,ih*${fy}-oh/2))',scale=${W * scale}:${H * scale}`
      : `scale=${W * scale}:${H * scale}:force_original_aspect_ratio=decrease,pad=${W * scale}:${H * scale}:(ow-iw)/2:(oh-ih)/2:black`;
    if (!options.slowPush) {
      filters.push(`[${input}:v]${fit},setsar=1,format=yuv420p,${hold}${out}`);
      return;
    }
    // Slow push: 6% closer over the hold, toward the focus (vertical: the column is already
    // centred on it). Rendered from twice the frame so the window's whole-pixel steps are halves.
    const px = vertical ? 0.5 : fx;
    const hold2 = Math.max(1, Math.round((segment.to - segment.from) * VIDEO_FPS));
    filters.push(
      `[${input}:v]${fit},setsar=1,zoompan=z='1+${VIDEO_PUSH}*min(on/${hold2},1)':x='(iw-iw/zoom)*${px}':y='(ih-ih/zoom)*${fy}':d=${frames}:s=${W}x${H}:fps=${VIDEO_FPS},setsar=1,format=yuv420p,settb=1/${VIDEO_FPS},fps=${VIDEO_FPS}${out}`,
    );
  });
  // Each piece gives way to the next over its crossfade, at the next piece's start on the clock.
  let last = "s0";
  planned.segments.forEach((segment, index) => {
    if (index === 0) return;
    const next = `x${index}`;
    filters.push(`[${last}][s${index}]xfade=transition=fade:duration=${fades[index]}:offset=${segment.from}[${next}]`);
    last = next;
  });
  if (planned.burned.length > 0) {
    filters.push(`${scrimSource(W, H)}[scrim]`);
    filters.push(`[${last}][scrim]overlay=0:H-h:format=auto[scrimmed]`);
    last = "scrimmed";
    const size = captionFontPx(options.shape, options.captionSize);
    const y = options.captionPosition === "middle" ? "(h-th)/2" : `h-th-${Math.round(H * CAPTION_BOTTOM_SHARE)}`;
    planned.burned.forEach((cue, index) => {
      const next = `c${index}`;
      filters.push(`[${last}]drawtext=${textOptions(font, size)}:text='${ffmpegDrawtextText(cue.text)}':x=(w-tw)/2:y=${y}:enable='between(t,${cue.startSec},${cue.endSec})'[${next}]`);
      last = next;
    });
  }
  filters.push(`[${last}]format=yuv420p[vout]`);
  return filters.join(";\n");
}

/** ffmpeg's chapter list: one entry a chapter, named by its title. */
function metadataFile(title: string, chapters: Array<{ title: string; from: number; to: number }>): string {
  const escape = (text: string) => text.replace(/([=;#\\\n])/g, "\\$1");
  const lines = [";FFMETADATA1", `title=${escape(title)}`];
  for (const chapter of chapters) lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${Math.round(chapter.from * 1000)}`, `END=${Math.round(chapter.to * 1000)}`, `title=${escape(chapter.title)}`);
  return `${lines.join("\n")}\n`;
}

const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", String(VIDEO_FPS)];
const AUDIO = ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"];
const quality = (options: AudiobookVideoOptions) => ["-crf", options.shape === "1280x720" ? "22" : "20"];
const QUIET = ["-v", "error", "-nostats", "-progress", "pipe:2"];

/** The characters the bundled face cannot draw, refused by name before an encode is started. */
function undrawable(texts: readonly string[]): string | null {
  for (const text of texts) {
    try {
      for (const line of text.split("\n")) assertSlateLabelSupported(line);
    } catch (err) {
      return err instanceof Error ? err.message.replace(/^export slate font/, "the caption font") : String(err);
    }
  }
  return null;
}

async function renderChapter(
  store: WorldStore,
  productionId: string,
  planned: PlannedChapter,
  options: AudiobookVideoOptions,
  ffmpeg: FfmpegRunner,
  work: string,
  signal: AbortSignal,
  onSeconds: (seconds: number) => void,
): Promise<string> {
  const target = cachedPiece(store, productionId, planned);
  await mkdir(toExtendedLength(join(target, "..")), { recursive: true });
  await mkdir(toExtendedLength(work), { recursive: true });
  const args: string[] = ["-y", ...QUIET];
  const indexOf = new Map<string, number>();
  let count = 0;
  for (const segment of planned.segments) {
    if (segment.file === null || indexOf.has(segment.file)) continue;
    const real = await containedWorldFile(store.dir, segment.file);
    if (real === null) throw new Error(`${segment.file.split("/").pop()} is not a file inside this world`);
    args.push("-i", real);
    indexOf.set(segment.file, count++);
  }
  const mix = await containedWorldFile(store.dir, planned.mix);
  if (mix === null) throw new Error(`${planned.chapter.title}: its mix is not on this machine`);
  args.push("-i", mix);
  const audio = count++;
  let subtitles: number | null = null;
  if (planned.cues.length > 0) {
    const srt = join(work, `${planned.chapter.chapterId}.srt`);
    await writeFile(toExtendedLength(srt), serializeTimedText(planned.cues, "srt"), "utf8");
    args.push("-i", srt);
    subtitles = count++;
  }
  const meta = join(work, `${planned.chapter.chapterId}.ffmeta`);
  await writeFile(toExtendedLength(meta), metadataFile(planned.chapter.title, [{ title: planned.chapter.title, from: 0, to: planned.chapter.seconds }]), "utf8");
  args.push("-i", meta);
  const metaIndex = count++;
  const graph = join(work, `${planned.chapter.chapterId}.graph`);
  await writeFile(toExtendedLength(graph), chapterGraph(planned, options, ffmpeg.slateFont, { file: (index) => { const file = planned.segments[index]!.file; return file === null ? null : (indexOf.get(file) ?? null); } }), "utf8");
  const stage = join(work, `${planned.chapter.chapterId}-${planned.digest}.mp4`);
  args.push("-/filter_complex", graph, "-map", "[vout]", "-map", `${audio}:a`);
  if (subtitles !== null) args.push("-map", `${subtitles}:s`, "-c:s", "mov_text");
  args.push("-map_metadata", String(metaIndex), "-map_chapters", String(metaIndex));
  args.push(...ENCODE, ...quality(options), ...AUDIO, "-t", planned.chapter.seconds.toFixed(3), "-movflags", "+faststart", stage);
  await ffmpeg.run(args, () => {}, signal, onSeconds);
  if (signal.aborted) throw new Error("cancelled");
  await rename(toExtendedLength(stage), toExtendedLength(target));
  await prunePieces(join(target, ".."), `${planned.digest}.mp4`);
  return target;
}

/** A chapter keeps its newest two pieces: the one just made and the one before, for a change undone. */
async function prunePieces(folder: string, keep: string): Promise<void> {
  const names = (await readdir(toExtendedLength(folder)).catch(() => [] as string[])).filter((name) => name.endsWith(".mp4") && name !== keep);
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(toExtendedLength(join(folder, name))).catch(() => null))?.mtimeMs ?? 0 })));
  dated.sort((a, b) => b.at - a.at);
  for (const old of dated.slice(1)) await rm(toExtendedLength(join(folder, old.name)), { force: true }).catch(() => {});
}

/** The book file's opening (rule 6): the cover as it is, with Read by in the caption's place, for five seconds. */
async function renderOpening(store: WorldStore, book: Book, options: AudiobookVideoOptions, ffmpeg: FfmpegRunner, work: string, signal: AbortSignal): Promise<string> {
  const { width: W, height: H } = shapeSize(options.shape);
  const out = join(work, "opening.mp4");
  const size = Math.round(Math.min(W, H) * OPENING_CAPTION_SHARE);
  const cover = book.cover === null ? null : await containedWorldFile(store.dir, book.cover);
  const args = ["-y", ...QUIET];
  let picture: string;
  if (cover !== null) {
    args.push("-i", cover);
    picture = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p,loop=loop=${BOOK_OPENING_SEC * VIDEO_FPS}:size=1:start=0,settb=1/${VIDEO_FPS},setpts=N,fps=${VIDEO_FPS}[pic]`;
  } else {
    args.push("-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${VIDEO_FPS}:d=${BOOK_OPENING_SEC}`);
    picture = `[0:v]format=yuv420p,setsar=1[pic]`;
  }
  args.push("-f", "lavfi", "-t", String(BOOK_OPENING_SEC), "-i", "anullsrc=r=48000:cl=stereo");
  const graph = [
    picture,
    `${scrimSource(W, H)}[scrim]`,
    `[pic][scrim]overlay=0:H-h:format=auto[lit]`,
    `[lit]drawtext=${textOptions(ffmpeg.slateFont, size)}:text='${ffmpegDrawtextText(book.readBy)}':x=(w-tw)/2:y=h-th-${Math.round(H * CAPTION_BOTTOM_SHARE)},format=yuv420p[vout]`,
  ].join(";\n");
  const graphFile = join(work, "opening.graph");
  await writeFile(toExtendedLength(graphFile), graph, "utf8");
  args.push("-/filter_complex", graphFile, "-map", "[vout]", "-map", "1:a", ...ENCODE, ...quality(options), ...AUDIO, "-t", String(BOOK_OPENING_SEC), "-movflags", "+faststart", out);
  await ffmpeg.run(args, () => {}, signal);
  return out;
}

// ————————————————————————————————————————————————————————————————————————————————————————————
// The render.

/** A render's note of itself, kept while it runs: what a restart reads to start it again. */
interface VideoJob {
  exportId: string;
  options: AudiobookVideoOptions;
  startedAt: string;
}

const jobFile = (store: WorldStore, productionId: string) => join(store.dir, videoCacheFolder(productionId), "job.json");

export async function pendingVideoJobs(store: WorldStore): Promise<Array<{ productionId: string } & VideoJob>> {
  const root = join(store.dir, ".cache", "audiobook-video");
  const out: Array<{ productionId: string } & VideoJob> = [];
  for (const productionId of await readdir(toExtendedLength(root)).catch(() => [] as string[])) {
    try {
      const raw = JSON.parse(await readFile(toExtendedLength(jobFile(store, productionId)), "utf8")) as Partial<VideoJob>;
      const options = AudiobookVideoOptionsSchema.safeParse(raw.options);
      if (typeof raw.exportId !== "string" || !EXPORT_ID.test(raw.exportId) || !options.success || typeof raw.startedAt !== "string") continue;
      if (!store.getBundle().productions.some((production) => production.meta.id === productionId)) continue;
      out.push({ productionId, exportId: raw.exportId, options: options.data, startedAt: raw.startedAt });
    } catch {
      // No note, or one this build cannot read: nothing to resume.
    }
  }
  return out;
}

export async function forgetVideoJob(store: WorldStore, productionId: string): Promise<void> {
  await rm(toExtendedLength(jobFile(store, productionId)), { force: true }).catch(() => {});
}

export interface VideoRunContext {
  ffmpeg: FfmpegRunner | undefined;
  clock: () => string;
  exportId: string;
  signal: AbortSignal;
  appRoot?: string;
  /** Where the render stands, with its percent measured against the chapters' length. */
  onProgress?: (progress: AudiobookVideoProgress & { percent: number }) => void;
  /** Wall-clock seconds, for the render's own pace; a test may hold it still. */
  now?: () => number;
}

/** Hard-linked from the cache where the disk allows it, so a chapter's video is not on disk twice. */
async function place(source: string, target: string): Promise<void> {
  const temp = `${target}.part`;
  await rm(toExtendedLength(temp), { force: true }).catch(() => {});
  try {
    await link(toExtendedLength(source), toExtendedLength(temp));
  } catch {
    await copyFile(toExtendedLength(source), toExtendedLength(temp));
  }
  await rename(toExtendedLength(temp), toExtendedLength(target));
}

export async function exportAudiobookVideo(store: WorldStore, productionId: string, options: AudiobookVideoOptions, context: VideoRunContext): Promise<AudiobookVideoResult> {
  if (!EXPORT_ID.test(context.exportId)) throw new Error("invalid audiobook video export id");
  const ffmpeg = context.ffmpeg;
  if (ffmpeg === undefined) return { ok: false, blockers: ["making a video needs ffmpeg, which this machine does not have"] };
  const now = context.now ?? (() => Date.now() / 1000);
  const book = await planBook(store, productionId, options, ffmpeg);
  if (book.chapters.length === 0) return { ok: false, blockers: book.blockers.length > 0 ? book.blockers : ["no chapter is read whole yet"] };
  const cannot = undrawable([...book.chapters.flatMap((planned) => [...planned.burned.map((cue) => cue.text), ...(options.titleCards ? [planned.chapter.title] : [])]), ...(options.files === "book" ? [book.readBy] : [])]);
  if (cannot !== null) return { ok: false, blockers: [cannot] };

  const job: VideoJob = { exportId: context.exportId, options, startedAt: context.clock() };
  await mkdir(toExtendedLength(join(store.dir, videoCacheFolder(productionId))), { recursive: true });
  await atomicWriteFile(jobFile(store, productionId), `${JSON.stringify(job)}\n`);
  const work = join(store.dir, videoCacheFolder(productionId), `work-${context.exportId}`);
  const folder = videoFolderName(book.title, job.startedAt);
  const dir = join(store.dir, "exports", folder);
  const totalSec = book.chapters.reduce((sum, planned) => sum + planned.chapter.seconds, 0);
  const started = now();
  let doneSec = 0;
  /** Seconds of video this render has encoded, and so not copied from the cache. */
  let renderedSec = 0;
  /** What is still to encode, for the time left: a cached chapter costs nothing. */
  let toRenderSec = 0;
  const report = (chapter: number, here: number) => {
    const done = Math.min(totalSec, doneSec + here);
    // The pace is this render's own, once it has encoded a few seconds.
    const encoded = renderedSec + here;
    const pace = encoded >= 1 ? encoded / Math.max(0.001, now() - started) : null;
    const left = pace === null ? null : Math.round(Math.max(0, toRenderSec - encoded) / pace);
    context.onProgress?.({ title: book.title, chapter, of: book.chapters.length, doneSec: Math.round(done), totalSec: Math.round(totalSec), leftSec: left, percent: totalSec > 0 ? Math.min(99, Math.floor((done / totalSec) * 100)) : 0 });
  };
  const files: AudiobookVideoFile[] = [];
  let made = 0;
  const shape = options.shape;
  const sidecarNames = wantsSidecar(options) ? [".srt", ".vtt"] : [];
  const writeManifest = async () =>
    atomicWriteFile(join(dir, "video.json"), `${JSON.stringify({ kind: "audiobook-video", version: 1, productionId, title: book.title, files, provenance: { exportId: context.exportId, exportedAt: context.clock() } }, null, 2)}\n`);
  // A second render the same day lands in the same folder; only a folder this render made is
  // taken away when it ends with nothing in it.
  const fresh = !(await stat(toExtendedLength(dir)).then((info) => info.isDirectory(), () => false));
  try {
    await mkdir(toExtendedLength(dir), { recursive: true });
    for (const planned of book.chapters) if (!(await exists(cachedPiece(store, productionId, planned)))) toRenderSec += planned.chapter.seconds;
    const pieces: string[] = [];
    for (const [index, planned] of book.chapters.entries()) {
      if (context.signal.aborted) throw new Error("cancelled");
      report(index + 1, 0);
      let piece = cachedPiece(store, productionId, planned);
      if (!(await exists(piece))) {
        const before = now();
        piece = await renderChapter(store, productionId, planned, options, ffmpeg, work, context.signal, (seconds) => report(index + 1, Math.min(planned.chapter.seconds, seconds)));
        const wall = Math.max(0.001, now() - before);
        renderedSec += planned.chapter.seconds;
        made += 1;
        const bytes = (await stat(toExtendedLength(piece))).size;
        await recordRate(context.appRoot, videoRateKey(shape, options.slowPush), { bytesPerSec: bytes / Math.max(1, planned.chapter.seconds), speed: planned.chapter.seconds / wall });
      }
      doneSec += planned.chapter.seconds;
      pieces.push(piece);
      if (options.files === "chapter") {
        // Each chapter lands as it is finished: a cancel keeps the ones already made (rule 10).
        const name = videoFileName(book.title, { kind: "chapter", order: planned.chapter.order, title: planned.chapter.title });
        await store.gateOp(async () => place(piece, join(dir, name)));
        const base = name.replace(/\.mp4$/, "");
        if (planned.cues.length > 0) {
          await atomicWriteFile(join(dir, `${base}.srt`), serializeTimedText(planned.cues, "srt"));
          await atomicWriteFile(join(dir, `${base}.vtt`), serializeTimedText(planned.cues, "vtt"));
        }
        files.push({ name, seconds: planned.chapter.seconds, bytes: (await stat(toExtendedLength(join(dir, name)))).size, shape, sidecars: planned.cues.length > 0 ? sidecarNames : [], picture: planned.segments.find((segment) => segment.kind === "picture")?.file ?? book.cover });
        await writeManifest();
      }
    }
    if (options.files === "book") {
      // One for the book (rule 2): joined from the chapters' pieces, in parts of at most twelve
      // hours, each opening on the cover and marking its chapters.
      if (context.signal.aborted) throw new Error("cancelled");
      await mkdir(toExtendedLength(work), { recursive: true });
      const opening = await renderOpening(store, book, options, ffmpeg, work, context.signal);
      const parts = bookParts(book.chapters.map((planned, index) => ({ planned, piece: pieces[index]!, seconds: planned.chapter.seconds })));
      for (const [partIndex, part] of parts.entries()) {
        if (context.signal.aborted) throw new Error("cancelled");
        const name = videoFileName(book.title, { kind: "book", part: parts.length > 1 ? partIndex + 1 : null });
        const list = join(work, `part-${partIndex + 1}.txt`);
        const quote = (path: string) => `file '${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
        await writeFile(toExtendedLength(list), [opening, ...part.chapters.map((entry) => entry.piece)].map(quote).join("\n") + "\n", "utf8");
        const marks: Array<{ title: string; from: number; to: number }> = [];
        const cues: VideoCue[] = [];
        let clock = BOOK_OPENING_SEC;
        for (const entry of part.chapters) {
          marks.push({ title: entry.planned.chapter.title, from: clock, to: clock + entry.seconds });
          for (const cue of entry.planned.cues) cues.push({ text: cue.text, startSec: cue.startSec + clock, endSec: cue.endSec + clock });
          clock += entry.seconds;
        }
        const meta = join(work, `part-${partIndex + 1}.ffmeta`);
        await writeFile(toExtendedLength(meta), metadataFile(parts.length > 1 ? `${book.title} · Part ${partIndex + 1}` : book.title, marks), "utf8");
        const args = ["-y", ...QUIET, "-f", "concat", "-safe", "0", "-i", list, "-i", meta];
        const srt = join(work, `part-${partIndex + 1}.srt`);
        if (cues.length > 0) {
          await writeFile(toExtendedLength(srt), serializeTimedText(cues, "srt"), "utf8");
          args.push("-i", srt);
        }
        const stage = join(work, name);
        args.push("-map", "0:v", "-map", "0:a", ...(cues.length > 0 ? ["-map", "2:s", "-c:s", "mov_text"] : []), "-map_metadata", "1", "-map_chapters", "1", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", stage);
        await ffmpeg.run(args, () => {}, context.signal);
        await store.gateOp(async () => rename(toExtendedLength(stage), toExtendedLength(join(dir, name))));
        const base = name.replace(/\.mp4$/, "");
        if (cues.length > 0) {
          await atomicWriteFile(join(dir, `${base}.srt`), serializeTimedText(cues, "srt"));
          await atomicWriteFile(join(dir, `${base}.vtt`), serializeTimedText(cues, "vtt"));
        }
        files.push({ name, seconds: Math.round(clock * 1000) / 1000, bytes: (await stat(toExtendedLength(join(dir, name)))).size, shape, sidecars: cues.length > 0 ? sidecarNames : [], picture: book.cover ?? book.chapters[0]?.segments.find((segment) => segment.kind === "picture")?.file ?? null });
        await writeManifest();
      }
    }
    await forgetVideoJob(store, productionId);
    return { ok: true, dir: `exports/${folder}`, files, made, renderedAt: context.clock() };
  } catch (err) {
    // A cancel ends the chapter in hand and keeps those finished; the job note stays only when
    // the app is closing under the render, so the next start resumes it (the caller decides).
    if (files.length === 0 && fresh) await rm(toExtendedLength(dir), { recursive: true, force: true }).catch(() => {});
    if (context.signal.aborted) return { ok: false, blockers: ["the render was cancelled"] };
    await forgetVideoJob(store, productionId);
    throw err;
  } finally {
    await rm(toExtendedLength(work), { recursive: true, force: true }).catch(() => {});
  }
}

/** A finished video folder, for Publications: read by its own manifest. */
export async function listVideoExports(store: WorldStore): Promise<Array<{ kind: "audiobook-video"; productionId: string; title: string; dir: string; exportedAt: string }>> {
  const exportsDir = join(store.dir, "exports");
  const out: Array<{ kind: "audiobook-video"; productionId: string; title: string; dir: string; exportedAt: string }> = [];
  for (const entry of await readdir(toExtendedLength(exportsDir), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/-video-\d{8}$/.test(entry.name)) continue;
    try {
      const raw = JSON.parse(await readFile(toExtendedLength(join(exportsDir, entry.name, "video.json")), "utf8")) as { kind?: unknown; productionId?: unknown; title?: unknown; files?: unknown; provenance?: { exportedAt?: unknown } };
      if (raw.kind !== "audiobook-video" || typeof raw.productionId !== "string" || typeof raw.provenance?.exportedAt !== "string" || !Array.isArray(raw.files) || raw.files.length === 0) continue;
      out.push({ kind: "audiobook-video", productionId: raw.productionId, title: typeof raw.title === "string" ? raw.title : raw.productionId, dir: `exports/${entry.name}`, exportedAt: raw.provenance.exportedAt });
    } catch {
      // A folder with no readable manifest is no video.
    }
  }
  return out;
}
