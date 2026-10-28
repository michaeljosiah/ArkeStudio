import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  arkePlayerPictureEdge,
  compileStoryDocument,
  exploreStory,
  packageSlug,
  productionAspect,
  productionShape,
  publicationBlockers,
  STORY_MEDIA_TYPE,
  STORY_SHAPES,
  storyDefaults,
  storyPredicate,
  storyReplay,
  storyRoutes,
  WORLD_PACKAGE_FORMAT,
  type ArkePlayerPictureSize,
  type ArkePlayerRelease,
  type ProductionBundle,
  type Routing,
  type RoutingFinding,
  type StoryCompileInput,
  type StoryCompileScene,
  type StoryDocument,
  type StoryExportBlocker,
  type StoryExportMade,
  type StoryExportState,
  type StoryKind,
  type StoryShape,
  type WorldAsset,
} from "@arke-studio/contracts";
import { clipFit, readMp4Info, STORY_CLIP_SHORT_SIDE, type Mp4Info } from "../media/mp4-info.js";
import { fitReadingImage, pngHasAlpha, webpHasAlpha } from "../references/reading-image.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import type { ArkePlayerExportOptions, ArkePlayerExportResult, ArkePlayerListed } from "./arke-player-export.js";
import { containedWorldFile, interactiveFindings, resolveBeatScenes, resolveMovieScenes, type BeatVoices, type PlaybackWindow, type ResolvedBeatScenes } from "./interactive.js";
import { checkWorldPackageZip, editionFingerprint, writeWorldPackageZip } from "./world-package.js";

/**
 * Export → Arke Player for an interactive movie or a visual novel (design turn 245, SPEC-058 R-79 –
 * R-80, R-89; SPEC-063 R-27): a story package, schema 6 and `alone`, beside the world's edition as
 * an album is, so a world's audiobook is never downloaded again for its story (Player call 21).
 *
 * The production is read as the web package reads it — the same scenes, resolved by the same
 * `resolveMovieScenes` and `resolveBeatScenes`, behind the same blocking findings — and its routing
 * compiled by contracts' `compileStoryDocument`, the code that holds the Dart port to its fixtures.
 * Each reachable clip ships as made when it is H.264 and AAC in MP4 at most 1080 on its short side,
 * else re-encoded; each beat's picture is fitted as R-6 fits one, at the sheet's Size; each voice
 * is M4A. It is made as R-4's package is: in a staging folder, read back by the shared reader and
 * every route of the document replayed through the contracts evaluator, then the production read
 * again under the world's gate before the package is named `exports/<slug>-story-<UTC date>.zip`.
 */

const COMPILER = "arke-studio/arke-player-story-export";
const COMPILER_VERSION = 1;

/**
 * How far the read-back walks (SPEC-063 R-6 allows loops, so the routes need not end): a route of
 * this many choices is kept unended, and the walk stops at this many routes. Each route holds its
 * steps, so the bound is memory as much as time.
 */
const ROUTE_LIMITS = { choices: 512, routes: 20_000 } as const;

// What the estimate assumes (245a, 245b): a fitted picture, a voiced line, a 1080 re-encode at
// 5 Mb/s, and how fast this machine copies, encodes and hashes. An estimate, said with `~`.
const PICTURE_BYTES = 450_000;
const FULL_EDGE = 2048;
const VOICE_BYTES = 60_000;
const ENCODED_BYTES_PER_MS = 5_000_000 / 8 / 1000;
const COPY_BYTES_PER_SECOND = 150_000_000;
const ENCODE_SECONDS_PER_SECOND = 1;
const SECONDS_PER_PICTURE = 0.4;
const SECONDS_PER_VOICE = 0.2;

const pad = (value: number, width: number) => String(value).padStart(width, "0");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const transparent = (bytes: Uint8Array) => pngHasAlpha(bytes) || webpHasAlpha(bytes);

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(toExtendedLength(file))) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** A reachable scene's footage, resolved to the world's own file and measured. */
interface PlannedClip {
  sceneId: string;
  title: string;
  rel: string;
  real: string;
  info: Mp4Info | null;
  bytes: number;
  windows: PlaybackWindow[];
  shots: string[];
}

interface StoryPlan {
  production: ProductionBundle;
  routing: Routing;
  kind: StoryKind;
  shape: StoryShape;
  /** The scenes a route reaches, in the order the compiler reaches them. */
  order: string[];
  titles: ReadonlyMap<string, string>;
  clips: PlannedClip[];
  beats: ResolvedBeatScenes | null;
  /** Each world-relative source the package copies, resolved to its real file. */
  real: Map<string, string>;
  cover: string | null;
  tall: string | null;
  /** The world as the package names it, to read again under the gate. */
  world: string;
}

type Planned = { plan: StoryPlan | null; state: StoryExportState };

/** The scenes a route can reach, in the order `compileStoryDocument` reaches them. */
function reachableOrder(routing: Pick<Routing, "start" | "choices">): string[] {
  const order = [routing.start];
  const reached = new Set(order);
  for (let at = 0; at < order.length; at++) {
    for (const choice of routing.choices) {
      if (choice.from === order[at] && !reached.has(choice.to)) {
        reached.add(choice.to);
        order.push(choice.to);
      }
    }
  }
  return order;
}

/** The shortest route of choices from the start to a scene, so a legacy finding can be shown too. */
function routeTo(routing: Pick<Routing, "start" | "choices">, sceneId: string): string[] | undefined {
  const routes = new Map<string, string[]>([[routing.start, []]]);
  const queue = [routing.start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    if (at === sceneId) return routes.get(at);
    for (const choice of routing.choices) {
      if (choice.from === at && !routes.has(choice.to)) {
        routes.set(choice.to, [...routes.get(at)!, choice.id]);
        queue.push(choice.to);
      }
    }
  }
  return undefined;
}

/** `when Key is Left`: the facts a route has moved off their starting values, by their labels. */
function whenClause(routing: Routing, route: readonly string[] | undefined): string {
  if (route === undefined || routing.schemaVersion !== 2 || (routing.facts ?? []).length === 0) return "";
  try {
    const state = storyReplay(routing, route).state;
    const defaults = storyDefaults(routing);
    const moved = (routing.facts ?? []).filter((fact) => state[fact.id] !== defaults[fact.id]);
    if (moved.length === 0) return "";
    const value = (raw: boolean | string | undefined) => (typeof raw === "string" ? `${raw.charAt(0).toUpperCase()}${raw.slice(1)}` : String(raw));
    return ` when ${moved.map((fact) => `${fact.label} is ${value(state[fact.id])}`).join(" and ")}`;
  } catch {
    return "";
  }
}

/**
 * A blocking finding (SPEC-063 R-16) as one clause with what clears it (245c): a state the route
 * reaches is shown, by its witness; anything else is a scene to go to.
 */
function findingBlocker(finding: RoutingFinding, routing: Routing, titleOf: (id: string) => string): StoryExportBlocker {
  const sceneId = finding.sceneIds[0];
  const title = sceneId === undefined ? "Story" : titleOf(sceneId);
  const choice = routing.choices.find((candidate) => candidate.id === finding.choiceIds[0]);
  const at = (detail: string, route?: string[], scene = sceneId): StoryExportBlocker => ({ detail, row: "story", ...(scene !== undefined ? { sceneId: scene } : {}), ...(route !== undefined ? { route } : {}) });
  switch (finding.kind) {
    case "state-route": {
      if (finding.witnessPrefix === undefined) return at(`${title} · ${finding.detail}`);
      const base = finding.detail.split(" at ")[0]!;
      const phrase = base === "No available choice or ending" ? "a dead end" : base === "This state cannot reach an ending" ? "no ending from here" : base === "Ending still offers choices" ? "an ending that offers choices" : base;
      return at(`${title} · ${phrase}${whenClause(routing, finding.witnessPrefix)}`, finding.witnessPrefix);
    }
    case "untraversed-edge": {
      const route = finding.witnessPrefix ?? (choice === undefined ? undefined : routeTo(routing, choice.from));
      return at(`${choice?.label ?? finding.choiceIds[0] ?? title} · not walked${whenClause(routing, finding.witnessPrefix)}`, route, choice?.from ?? sceneId);
    }
    case "unreachable":
      return at(`${title} · no route reaches it`);
    case "cannot-reach-ending":
      return at(`${title} · cannot reach an ending`);
    case "unintended-loop":
      return at(`${title} · a loop no ending escapes`);
    case "ending-with-choices":
      return at(`${title} · an ending that offers choices`);
    case "invalid-destination":
      return at(`${choice?.label ?? title} · names a scene that is not here`, undefined, choice?.from);
    case "state-incomplete":
      return { detail: "Story facts · too many states to check", row: "story" };
    default:
      return at(`${title} · ${finding.detail}`);
  }
}

/** Choices closed in some state a route reaches (SPEC-063 R-11), and those with the author's reason. */
function closedChoices(routing: Routing, reached: ReadonlySet<string>): { count: number; reasoned: number } {
  const guarded = routing.choices.filter((choice) => reached.has(choice.from) && choice.when !== undefined);
  if (guarded.length === 0) return { count: 0, reasoned: 0 };
  let points: ReturnType<typeof exploreStory>["points"] = [];
  try {
    points = exploreStory(routing).points;
  } catch {
    // Rules that do not read are a blocking finding already; nothing is counted closed.
  }
  const closed = guarded.filter((choice) => points.some((point) => point.sceneId === choice.from && !storyPredicate(choice.when, point.state)));
  return { count: closed.length, reasoned: closed.filter((choice) => choice.unavailable !== undefined).length };
}

/** A clip's windows in ms of its file (SPEC-058 R-80): an open end, or a whole pass, runs to the file's measured end. */
function clipWindows(clip: Pick<PlannedClip, "windows" | "shots">, asset: string, durationMs: number | null): NonNullable<StoryCompileScene["clips"]> {
  const end = durationMs ?? 0;
  if (clip.windows.length === 0) return [{ asset, from: 0, to: end }];
  return clip.windows.map((window, index) => ({
    asset,
    from: Math.round(window.from * 1000),
    to: window.to !== undefined ? Math.round(window.to * 1000) : end,
    ...(clip.shots[index] !== undefined ? { shotId: clip.shots[index]! } : {}),
  }));
}

/** What a scene's resolved beats give the compiler, with each package name made an asset id. */
function beatScenes(beats: ResolvedBeatScenes, titleOf: (id: string) => string, asset: (name: string | undefined) => string | undefined): Record<string, StoryCompileScene> {
  return Object.fromEntries(beats.scenes.map(({ sceneId, beats: list }) => [sceneId, {
    title: titleOf(sceneId),
    beats: list.map((beat) => {
      const picture = asset(beat.picture);
      const voice = asset(beat.audio);
      return {
        ...(beat.shotId !== undefined ? { shotId: beat.shotId } : {}),
        ...(beat.pictureShotId !== undefined ? { pictureShotId: beat.pictureShotId } : {}),
        ...(beat.blockId !== undefined ? { blockId: beat.blockId } : {}),
        ...(picture !== undefined ? { picture } : {}),
        ...(beat.text !== undefined ? { text: beat.text } : {}),
        ...(beat.speaker !== undefined ? { speaker: beat.speaker } : {}),
        ...(voice !== undefined ? { audio: voice } : {}),
      };
    }),
  }]));
}

/** A package name's asset id before anything is made: the name itself, made a slug. */
const placeholder = (name: string | undefined) => (name === undefined ? undefined : packageSlug(name.replace(/^media\//, "")));

/**
 * Reads the production the way the export will, and counts what the package would hold (245a –
 * 245c). Nothing is copied or encoded; a clip is measured from its own boxes.
 */
async function planStory(
  store: WorldStore,
  productionId: string,
  options: { voices?: BeatVoices; pictureSize?: ArkePlayerPictureSize; publish?: ArkePlayerExportOptions["publish"]; ffmpeg: boolean },
): Promise<Planned | { refused: string }> {
  const bundle = store.getBundle();
  const production = bundle.productions.find((entry) => entry.meta.id === productionId);
  if (production === undefined || !productionShape(production.meta).isBranching) return { refused: "that production is no longer an interactive story in this world" };
  const kind: StoryKind = productionShape(production.meta).playsAsBeats ? "novel" : "movie";
  const aspect = productionAspect(production.meta);
  const shape: StoryShape = (STORY_SHAPES as readonly string[]).includes(aspect) ? (aspect as StoryShape) : "16:9";
  const blockers: StoryExportBlocker[] = [];
  if (!options.ffmpeg) blockers.push({ detail: "Needs ffmpeg", row: "story" });
  if (shape !== aspect) blockers.push({ detail: `Shape · ${aspect} · Arke Player plays 16:9 or 9:16`, row: "story" });
  const empty = (): StoryExportState => ({ kind, shape, scenes: 0, choices: 0, facts: 0, endings: 0, closed: { count: 0, reasoned: 0 }, bytes: 0, seconds: 0, blockers });
  const routing = production.routing;
  if (routing === null) {
    blockers.push({ detail: "No routing yet · draw the first choice", row: "story" });
    return { plan: null, state: empty() };
  }
  const titleOf = (id: string) => production.scenes.find((scene) => scene.id === id)?.title || id;
  const titles = new Map(production.scenes.map((scene) => [scene.id, scene.title || scene.id]));

  // The web package's own blocking findings (SPEC-063 R-16, R-23): the same gate on both kinds.
  for (const finding of publicationBlockers(await interactiveFindings(store, production))) blockers.push(findingBlocker(finding, routing, titleOf));

  const order = reachableOrder(routing);
  const reached = new Set(order);
  const real = new Map<string, string>();
  const contain = async (rel: string) => {
    if (real.has(rel)) return real.get(rel)!;
    const found = await containedWorldFile(store.dir, rel);
    if (found !== null) real.set(rel, found);
    return found;
  };

  const clips: PlannedClip[] = [];
  let beats: ResolvedBeatScenes | null = null;
  const media = (sceneId: string | undefined, clause: string): StoryExportBlocker => ({ detail: sceneId === undefined ? clause : `${titleOf(sceneId)} · ${clause}`, row: "media", ...(sceneId !== undefined ? { sceneId } : {}) });
  if (kind === "movie") {
    const resolved = resolveMovieScenes(store, production, routing, reached);
    for (const blocker of resolved.blockers) blockers.push(media(blocker.sceneId, blocker.clause));
    for (const entry of resolved.media) {
      const found = await contain(entry.rel);
      if (found === null) {
        blockers.push(media(entry.sceneId, "a clip outside this world"));
        continue;
      }
      clips.push({ sceneId: entry.sceneId, title: titleOf(entry.sceneId), rel: entry.rel, real: found, info: await readMp4Info(found), bytes: (await stat(toExtendedLength(found))).size, windows: entry.windows, shots: entry.shots });
    }
  } else {
    beats = await resolveBeatScenes(store, production, routing, { ...(options.voices !== undefined ? { voices: options.voices } : {}), only: reached });
    for (const blocker of beats.blockers) blockers.push(media(blocker.sceneId, blocker.clause));
    // Each file a beat names, resolved to the world's own: one that leaves the world refuses the
    // package by the scene that shows it, before anything is copied.
    const firstScene = new Map<string, string>();
    for (const scene of beats.scenes) for (const beat of scene.beats) for (const name of [beat.picture, beat.audio]) if (name !== undefined && !firstScene.has(name)) firstScene.set(name, scene.sceneId);
    for (const [name, rel] of beats.copies) {
      if ((await contain(rel)) === null) blockers.push(media(firstScene.get(name), name.startsWith("media/voice-") ? "a voice outside this world" : "a picture outside this world"));
    }
  }

  // The production's wide cover is Publish's, else the key art, and its Tall cover where it has one (R-79).
  const cover = options.publish?.cover ?? bundle.keyArt ?? null;
  const tall = options.publish?.tall ?? null;
  for (const [file, what] of [[cover, "the cover"], [tall, "the Tall cover"]] as const) {
    if (file !== null && (await contain(file)) === null) blockers.push({ detail: `${what} is outside this world`, row: "story" });
  }

  // The compiler's own refusals, read before anything is made (SPEC-063 R-9): what a document cannot say.
  const scenes: Record<string, StoryCompileScene> =
    kind === "movie"
      ? Object.fromEntries(clips.map((clip) => [clip.sceneId, { title: clip.title, clips: clipWindows(clip, placeholder(clip.sceneId)!, clip.info?.durationMs ?? 1) }]))
      : beatScenes(beats!, titleOf, placeholder);
  const unresolved = new Set(blockers.filter((blocker) => blocker.row === "media").flatMap((blocker) => (blocker.sceneId !== undefined ? [blocker.sceneId] : [])));
  if (unresolved.size === 0) {
    const compiled = compileStoryDocument({ routing, kind, shape, scenes });
    if (!compiled.ok) for (const problem of compiled.problems) blockers.push({ detail: problem.detail, row: "story", ...(problem.sceneId !== undefined ? { sceneId: problem.sceneId } : {}) });
  }

  // The counts the sheet shows (245a, 245b).
  const edge = arkePlayerPictureEdge(options.pictureSize) ?? FULL_EDGE;
  const pictureBytes = PICTURE_BYTES * Math.min(1, (edge / FULL_EDGE) ** 2);
  const covers = (cover !== null ? 1 : 0) + (tall !== null ? 1 : 0);
  let bytes = covers * PICTURE_BYTES;
  let seconds = covers * SECONDS_PER_PICTURE;
  const state: StoryExportState = {
    kind,
    shape,
    scenes: order.length,
    choices: routing.choices.filter((choice) => reached.has(choice.from)).length,
    facts: routing.facts?.length ?? 0,
    endings: routing.endings.filter((ending) => reached.has(ending.sceneId)).length,
    closed: closedChoices(routing, reached),
    bytes: 0,
    seconds: 0,
    blockers,
  };
  if (kind === "movie") {
    let ms = 0;
    let largest: { width: number; height: number } | null = null;
    let reencoded = 0;
    for (const clip of clips) {
      const fit = clipFit(clip.info);
      const length = clip.info?.durationMs ?? 0;
      ms += clipWindows(clip, "", length).reduce((sum, window) => sum + Math.max(0, window.to - window.from), 0);
      const video = clip.info?.video;
      if (video != null && (largest === null || video.width * video.height > largest.width * largest.height)) largest = { width: video.width, height: video.height };
      if (fit !== "as-made") reencoded++;
      bytes += fit === "encode" ? length * ENCODED_BYTES_PER_MS : clip.bytes;
      seconds += clip.bytes / COPY_BYTES_PER_SECOND + (fit === "encode" ? (length / 1000) * ENCODE_SECONDS_PER_SECOND : 0);
    }
    state.clips = { count: clips.length, of: order.length, ms: Math.round(ms), ...(largest !== null ? { width: largest.width, height: largest.height } : {}), reencoded };
  } else if (beats !== null) {
    const all = beats.scenes.flatMap((scene) => scene.beats);
    const pictures = new Set(all.flatMap((beat) => (beat.picture !== undefined ? [beat.picture] : [])));
    const voiced = all.filter((beat) => beat.text !== undefined && beat.text !== "" && beat.audio !== undefined).length;
    // A beat's Tall (R-87) is the moment's own; nothing in a visual novel makes one yet, so every
    // beat is wide only until something does.
    state.pictures = { beats: all.length, wide: all.filter((beat) => beat.picture !== undefined).length, tall: 0, files: pictures.size };
    state.voices = { lines: all.filter((beat) => beat.text !== undefined && beat.text !== "").length, voiced };
    bytes += pictures.size * pictureBytes + voiced * VOICE_BYTES;
    seconds += pictures.size * SECONDS_PER_PICTURE + voiced * SECONDS_PER_VOICE;
  }
  state.bytes = Math.round(bytes);
  // Packing and the read-back each read every byte once more.
  state.seconds = Math.max(1, Math.ceil(seconds + (2 * bytes) / COPY_BYTES_PER_SECOND));
  const world = JSON.stringify([bundle.meta.name, bundle.meta.logline ?? null, bundle.meta.slug, cover, tall]);
  return { plan: { production, routing, kind, shape, order, titles, clips, beats, real, cover, tall, world }, state };
}

/** What Export → Arke Player would make of a story (245a – 245c), for the sheet: its rows, its estimate, its blockers. */
export async function readStoryExport(
  store: WorldStore,
  productionId: string,
  options: { voices?: BeatVoices; pictureSize?: ArkePlayerPictureSize; publish?: ArkePlayerExportOptions["publish"]; ffmpeg: boolean },
): Promise<StoryExportState> {
  const planned = await planStory(store, productionId, options);
  if ("refused" in planned) throw new Error(planned.refused);
  return planned.state;
}

export async function exportStoryPlayer(store: WorldStore, productionId: string, options: ArkePlayerExportOptions): Promise<ArkePlayerExportResult> {
  const ffmpeg = options.ffmpeg;
  if (ffmpeg === undefined) return { ok: false, blockers: ["Needs ffmpeg"], problems: [{ detail: "Needs ffmpeg", row: "story" }] };
  const signal = options.signal ?? new AbortController().signal;
  const cancelled = (): ArkePlayerExportResult => ({ ok: false, blockers: ["the export was cancelled"] });
  const refused = (problems: StoryExportBlocker[]): ArkePlayerExportResult => ({ ok: false, blockers: problems.map((problem) => problem.detail), problems });
  const step = options.onStep ?? (() => {});
  step("Reading the story", 0);
  const planned = await planStory(store, productionId, {
    ...(options.voices !== undefined ? { voices: options.voices } : {}),
    ...(options.pictureSize !== undefined ? { pictureSize: options.pictureSize } : {}),
    ...(options.publish !== undefined ? { publish: options.publish } : {}),
    ffmpeg: true,
  });
  if ("refused" in planned) return { ok: false, blockers: [planned.refused] };
  if (planned.plan === null || planned.state.blockers.length > 0) return refused(planned.state.blockers);
  const plan = planned.plan;
  if (signal.aborted) return cancelled();
  const bundle = store.getBundle();
  const title = (options.publish?.title ?? plan.production.meta.title).trim() || plan.production.meta.title;
  const own = packageSlug(productionId);

  const staging = join(store.dir, ".staging", "arke-player-export", options.exportId);
  const files = join(staging, "files");
  const at = (path: string) => join(files, ...path.split("/"));
  try {
    for (const folder of ["clips", "pictures", "voices"]) await mkdir(toExtendedLength(join(files, folder)), { recursive: true });
    const assets: Record<string, WorldAsset> = {};
    const sources = new Map<string, string>();
    const originals: Record<string, string> = {};
    const add = async (assetId: string, path: string, mediaType: string) => {
      const bytes = await readFile(toExtendedLength(at(path)));
      assets[assetId] = { path, mediaType, byteLength: bytes.byteLength, sha256: sha256(bytes) };
      sources.set(path, at(path));
    };
    const fitPicture = async (rel: string, assetId: string, path: (alpha: boolean) => string, edge: number | undefined, what: string): Promise<ArkePlayerExportResult | null> => {
      const source = plan.real.get(rel)!;
      const original = await readFile(toExtendedLength(source));
      const keepsAlpha = transparent(original);
      const out = path(keepsAlpha);
      try {
        await fitReadingImage(source, at(out), keepsAlpha, ffmpeg, signal, edge);
      } catch {
        if (signal.aborted) return cancelled();
        return refused([{ detail: `${what} could not be fitted for a phone`, row: "media" }]);
      }
      await add(assetId, out, keepsAlpha ? "image/png" : "image/jpeg");
      originals[assetId] = sha256(original);
      return null;
    };

    // Clips (R-79): H.264 with AAC in MP4, at most 1080 on the short side, re-encoded only when not.
    const scenes: Record<string, StoryCompileScene> = {};
    const fitting = plan.clips.length + (plan.beats?.copies.size ?? 0) + 2;
    const scale = `scale='if(gt(iw,ih),-2,trunc(min(${STORY_CLIP_SHORT_SIDE},iw)/2)*2)':'if(gt(iw,ih),trunc(min(${STORY_CLIP_SHORT_SIDE},ih)/2)*2,-2)'`;
    for (const [index, clip] of plan.clips.entries()) {
      if (signal.aborted) return cancelled();
      step(`Fitting clips · ${index + 1} of ${plan.clips.length}`, (index / fitting) * 80);
      const assetId = `c${pad(index + 1, 3)}`;
      const path = `clips/${assetId}.mp4`;
      const fit = clipFit(clip.info);
      try {
        if (fit === "as-made") await copyFile(toExtendedLength(clip.real), toExtendedLength(at(path)));
        else if (fit === "remux") {
          const aac = clip.info!.audio.every((track) => track.aac);
          await ffmpeg.run(["-y", "-i", clip.real, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", ...(aac ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "160k"]), "-movflags", "+faststart", at(path)], () => {}, signal);
        } else {
          await ffmpeg.run(["-y", "-i", clip.real, "-map", "0:v:0", "-map", "0:a:0?", "-vf", scale, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", at(path)], () => {}, signal);
        }
      } catch {
        if (signal.aborted) return cancelled();
        return refused([{ detail: `${clip.title} · its clip could not be made for a phone`, row: "media", sceneId: clip.sceneId }]);
      }
      // A window left open, or a whole pass, runs to the end of the file that ships (R-80).
      const open = clip.windows.length === 0 || clip.windows.some((window) => window.to === undefined);
      const length = fit === "as-made" ? clip.info?.durationMs ?? null : (await readMp4Info(at(path)))?.durationMs ?? null;
      if (open && length === null) return refused([{ detail: `${clip.title} · its clip's length could not be read`, row: "media", sceneId: clip.sceneId }]);
      await add(assetId, path, "video/mp4");
      if (fit !== "as-made") originals[assetId] = await fileSha256(clip.real);
      scenes[clip.sceneId] = { title: clip.title, clips: clipWindows(clip, assetId, length) };
    }

    // A novel's pictures, fitted as R-6 fits one at the sheet's Size, and its voices as M4A, each once.
    const named = new Map<string, string>();
    if (plan.beats !== null) {
      const edge = arkePlayerPictureEdge(options.pictureSize);
      let pictures = 0;
      let voices = 0;
      for (const [index, [name, rel]] of [...plan.beats.copies].sort(([a], [b]) => (a < b ? -1 : 1)).entries()) {
        if (signal.aborted) return cancelled();
        if (name.startsWith("media/voice-")) {
          step(`Fitting voices · ${index + 1} of ${plan.beats.copies.size}`, ((plan.clips.length + index) / fitting) * 80);
          const assetId = `v${pad(++voices, 3)}`;
          const path = `voices/${assetId}.m4a`;
          const source = plan.real.get(rel)!;
          const info = await readMp4Info(source);
          try {
            if (info !== null && info.video === null && info.audio.length > 0 && info.audio.every((track) => track.aac)) await copyFile(toExtendedLength(source), toExtendedLength(at(path)));
            else await ffmpeg.run(["-y", "-i", source, "-vn", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", at(path)], () => {}, signal);
          } catch {
            if (signal.aborted) return cancelled();
            return refused([{ detail: `${name.slice("media/voice-".length)} · its voice could not be made for a phone`, row: "media" }]);
          }
          await add(assetId, path, "audio/mp4");
          named.set(name, assetId);
          continue;
        }
        step(`Fitting pictures · ${index + 1} of ${plan.beats.copies.size}`, ((plan.clips.length + index) / fitting) * 80);
        const assetId = `p${pad(++pictures, 3)}`;
        const failed = await fitPicture(rel, assetId, (alpha) => `pictures/${assetId}.${alpha ? "png" : "jpg"}`, edge, `${rel.split("/").pop()}`);
        if (failed !== null) return failed;
        named.set(name, assetId);
      }
      Object.assign(scenes, beatScenes(plan.beats, (id) => plan.titles.get(id) ?? id, (name) => (name === undefined ? undefined : named.get(name))));
    }

    // The production's wide cover and its Tall, full size, as the world's card shows them larger than a moment.
    step("Fitting the cover", 82);
    let picture: string | undefined;
    let tallCover: string | undefined;
    if (plan.cover !== null) {
      const failed = await fitPicture(plan.cover, "cover", (alpha) => `cover.${alpha ? "png" : "jpg"}`, undefined, "the cover");
      if (failed !== null) return failed;
      picture = "cover";
    }
    if (plan.tall !== null) {
      const failed = await fitPicture(plan.tall, "cover-tall", (alpha) => `cover-tall.${alpha ? "png" : "jpg"}`, undefined, "the Tall cover");
      if (failed !== null) return failed;
      tallCover = "cover-tall";
    }

    // The story document (R-80), compiled by the code the web package's rules come from.
    step("Compiling the story", 86);
    const input: StoryCompileInput = { routing: plan.routing, kind: plan.kind, shape: plan.shape, scenes };
    const compiled = compileStoryDocument(input);
    if (!compiled.ok) return refused(compiled.problems.map((problem) => ({ detail: problem.detail, row: "story", ...(problem.sceneId !== undefined ? { sceneId: problem.sceneId } : {}) })));
    const document: StoryDocument = compiled.document;
    await writeFile(toExtendedLength(at("story.json")), `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await add("story", "story.json", STORY_MEDIA_TYPE);

    // world.json (R-79): the world's id, name and logline, the one production, and nothing else of the world's.
    const stamp = options.clock();
    const day = stamp.slice(0, 10);
    const slug = packageSlug(bundle.meta.slug);
    await mkdir(toExtendedLength(join(store.dir, "exports")), { recursive: true });
    const taken = new Set(await readdir(toExtendedLength(join(store.dir, "exports"))).catch(() => [] as string[]));
    let edition = day;
    for (let counter = 2; taken.has(`${own}-story-${edition}.zip`) || taken.has(`${own}-story-${edition}.zip.json`); counter++) edition = `${day}-${counter}`;
    const name = `${own}-story-${edition}.zip`;
    const author = options.publish?.author?.trim() || undefined;
    const manifest = {
      format: WORLD_PACKAGE_FORMAT,
      // A story package is schema 6, and the only thing schema 6 is (R-79): music stays at 5.
      schemaVersion: 6,
      alone: true,
      id: slug,
      edition,
      name: bundle.meta.name.slice(0, 200),
      ...(bundle.meta.logline !== undefined && bundle.meta.logline.trim() !== "" ? { logline: bundle.meta.logline.slice(0, 400) } : {}),
      productions: [{ id: own, title: title.slice(0, 200), ...(author !== undefined ? { author: author.slice(0, 200) } : {}), ...(picture !== undefined ? { picture } : {}), ...(tallCover !== undefined ? { tall: tallCover } : {}), story: "story" }],
      assets,
      provenance: { compiler: COMPILER, compilerVersion: COMPILER_VERSION, studio: options.studioVersion, exportId: options.exportId, exportedAt: stamp, story: document.fingerprint, routingVersion: plan.routing.version, originals },
    };

    // Read back (R-5, R-89): the shared reader, then every route replayed through the document it read.
    step("Checking the package", 90);
    const zip = join(staging, name);
    await writeWorldPackageZip(`${JSON.stringify(manifest, null, 2)}\n`, sources, zip, signal);
    const checked = await checkWorldPackageZip(zip, signal);
    if (!checked.ok) return refused(checked.problems.map((problem) => ({ detail: problem, row: "story" })));
    const read = checked.stories[own];
    if (read === undefined) return refused([{ detail: "the package holds no story", row: "story" }]);
    step("Replaying every route", 94);
    let made: StoryExportMade;
    try {
      const expected = storyRoutes(document, ROUTE_LIMITS);
      const replayed = storyRoutes(read, ROUTE_LIMITS);
      // Route by route, the package's document must play exactly as the compiled one: the same scene,
      // choices, projection, facts and ending at every step (R-81).
      const agree = expected.routes.filter((route, index) => replayed.routes[index] !== undefined && JSON.stringify(replayed.routes[index]) === JSON.stringify(route)).length;
      if (agree !== expected.routes.length || replayed.routes.length !== expected.routes.length || replayed.complete !== expected.complete) {
        return refused([{ detail: `Read back · ${agree} of ${expected.routes.length} routes · make it again`, row: "story" }]);
      }
      made = { kind: plan.kind, scenes: document.scenes.length, routes: agree, complete: expected.complete, endings: document.endings.length };
    } catch (error) {
      return refused([{ detail: `Read back · ${error instanceof Error ? error.message : String(error)}`, row: "story" }]);
    }
    const pictures = Object.values(assets).filter((asset) => asset.mediaType.startsWith("image/")).length;
    const holds = [plural(made.scenes, "scene"), `${made.routes} route${made.routes === 1 ? "" : "s"}`, plural(made.endings, "ending")].join(" · ");
    const release: ArkePlayerRelease = { edition, fingerprint: editionFingerprint({ edition, assets }), chapters: [] };

    // Under the gate, the production is read again (R-4): a choice drawn, a scene edited, a take
    // accepted, a picture or a voice changed meanwhile refuses the package rather than shipping the
    // story as it was.
    return await store.gateOp(async () => {
      const now = store.getBundle().productions.find((entry) => entry.meta.id === productionId);
      const moved = plan.beats !== null ? await plan.beats.moved(now) : JSON.stringify(now ?? null) !== JSON.stringify(plan.production) ? ["the story changed while the package was made"] : [];
      const nowWorld = store.getBundle();
      const reworlded = JSON.stringify([nowWorld.meta.name, nowWorld.meta.logline ?? null, nowWorld.meta.slug, options.publish?.cover ?? nowWorld.keyArt ?? null, plan.tall]) !== plan.world;
      if (moved.length > 0 || reworlded) return refused([...moved, ...(reworlded ? ["the world's name or picture changed while the package was made"] : [])].map((detail) => ({ detail: `${detail.replace(/ — export again$/, "")} · make it again`, row: "story" as const })));
      const destination = join(store.dir, "exports", name);
      // Never over an earlier export (SPEC-048 R-10).
      const exists = (path: string) => stat(toExtendedLength(path)).then(() => true, () => false);
      if ((await exists(destination)) || (await exists(`${destination}.json`))) return refused([{ detail: `exports/${name} already exists · make it again`, row: "story" }]);
      const listed: ArkePlayerListed = {
        kind: "arke-player",
        exportId: options.exportId,
        exportedAt: stamp,
        productionId,
        title: `${bundle.meta.name} · ${title}`.slice(0, 400),
        bytes: checked.bytes,
        sha256: checked.sha256,
        holds,
        chapters: 0,
        pictures,
        book: false,
        guide: false,
        release,
        story: made,
      };
      // What Publications lists, written before the package is named (233e): a record without its
      // package is never listed, and a package is never left without its record.
      await writeFile(toExtendedLength(`${destination}.json`), `${JSON.stringify(listed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      try {
        await rename(toExtendedLength(zip), toExtendedLength(destination));
      } catch (error) {
        await rm(toExtendedLength(`${destination}.json`), { force: true }).catch(() => {});
        throw error;
      }
      step("Done", 100);
      return { ok: true as const, file: `exports/${name}`, bytes: checked.bytes, sha256: checked.sha256, edition, chapters: 0, pictures, book: false, guide: false, story: made };
    });
  } finally {
    await rm(toExtendedLength(staging), { recursive: true, force: true }).catch(() => {});
  }
}
