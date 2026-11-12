import { readdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PRESETS, TEXT_PICTURE_DIR, TEXT_PICTURE_PATH, TimelineOperationRefused, canonicalJson, textPicturePath, textSourceWritten,
  type ProductionBundle, type ProductionTimeline, type RenderPlan, type TextFrame, type TextLook, type TextPictureAsk, type TimelineClip,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import type { WorldStore } from "../world/store.js";
import { paintTextPicture, textPicturePng, textPictureRefusal } from "./editor-text-pictures.js";

/**
 * Where a text clip's picture is kept, and when (SPEC-065 R-20, §2.3). A kept picture is a plain
 * file, `.cache/editor-text/<name>.png`, named by everything that decides its pixels, written once
 * and never again. Nothing remembers which pictures exist: the names a world holds are worked out
 * from its records whenever they are wanted, so a picture is painted the first time the Viewer or
 * an export asks for it, a deleted folder fills again by itself, and the sweep at world open
 * removes whatever nothing names any more.
 *
 * Not `DerivedCache`. That cache evicts by size and age, and an export reads its pictures at
 * render and hashes them again at publish: an eviction between the two would fail a film that a
 * timeline still names. The spec asks for the opposite policy, a reference sweep, and a
 * content-addressed file that is never rewritten gives it with less.
 *
 * Every write goes through `store.derivedWrite`, which checks the world is still this
 * coordinator's before it writes into it (issue 827). That queue is the one a timeline command
 * writes through, so nothing on the command path may call into it: the command asks only
 * `refuseUnpaintableText`, which lays out and writes nothing.
 */

/** One text source a record holds, in stored form (a pending request's typed words go through `textSourceWritten` first). */
export interface TextSourceNamed { text: string; look: TextLook; label: string; clipId?: string }
/** A clip whose picture could not be kept, in the words the painter refused it with (R-21). */
export interface TextPictureRefusal { clipId: string; label: string; reason: string }
/** A kept picture's name and the file it is in on this machine, or why it could not be kept. */
export type TextPictureKept = { ok: true; name: string; path: string } | { ok: false; reason: string };

/** What every export says when its plan and its pictures disagree, which no edit of a person's should reach. */
const MISSING = "timeline is not ready to export: a text picture is missing";
/** A stage file `atomicWriteFile` leaves behind when the process dies between its write and its rename. */
const STAGE = /^\.tmp-[0-9A-HJKMNP-TV-Z]{26}$/;
/** A kept picture's file name inside the folder; the whole path is `TEXT_PICTURE_PATH`. */
const KEPT = /^([0-9a-f]{64})\.png$/;

/**
 * The sizes one source may be painted at. In this slice that is every delivery size there is
 * (1280×720, 1920×1080, 1080×1920), whatever the source. It takes the source because a moving
 * clip will want a picture larger than its frame (R-17), and then this is the one place that
 * changes: the media route, the sweep and the name list all ask here.
 */
export function textPictureSizes(_source: TextSourceNamed): TextFrame[] {
  const sizes = new Map<string, TextFrame>();
  for (const { width, height } of Object.values(PRESETS)) sizes.set(`${width}x${height}`, { width, height });
  return [...sizes.values()];
}

const textOf = (clip: TimelineClip | null | undefined): TextSourceNamed | null =>
  clip?.source.kind === "text" ? { text: clip.source.text, look: clip.source.look, label: clip.source.label, clipId: clip.id } : null;

/**
 * Every text source a production's records hold (§2.3): on a clip of any track, muted or not, in
 * either side of every Undo and Redo entry, and in each pending request's `place`. Undo and Redo
 * are here because a step back must draw what it restores without asking the painter again, and a
 * pending request because its card shows what Accept would place. A request holds words as they
 * were typed, and a picture is named by the words a write would store (R-4), so those go through
 * `textSourceWritten` first; words a write would refuse name no picture and are left out. Decided
 * requests name nothing: their commands are a record of what happened, not something anyone draws.
 */
export function textSourcesNamed(production: Pick<ProductionBundle, "timeline" | "editorRequests">): TextSourceNamed[] {
  const named: TextSourceNamed[] = [];
  const add = (source: TextSourceNamed | null) => { if (source !== null) named.push(source); };
  if (production.timeline?.status === "ready") {
    const { tracks, history } = production.timeline.timeline;
    for (const track of tracks) for (const clip of track.clips) add(textOf(clip));
    for (const entry of [...history.undo, ...history.redo]) {
      if (entry.kind !== "change") continue;
      for (const change of entry.clips) { add(textOf(change.before)); add(textOf(change.after)); }
    }
  }
  for (const request of production.editorRequests) {
    if (request.status !== "pending") continue;
    for (const command of request.commands) {
      if (command.kind !== "place" || command.clip.source.kind !== "text") continue;
      const written = textSourceWritten(command.clip.source.text, command.clip.source.look);
      if (written.ok) add({ text: written.source.text, look: written.source.look, label: written.source.label, clipId: command.clip.id });
    }
  }
  return named;
}

/** False when the production's timeline could not be read, so the names it holds are unknown. */
export function textSourcesReadable(production: Pick<ProductionBundle, "timeline">): boolean {
  return production.timeline?.status !== "invalid";
}

/** The list `textPicturesNamed` last worked out for each bundle's productions, which a commit replaces whole. */
const namedFor = new WeakMap<readonly unknown[], ReadonlyMap<string, TextPictureAsk>>();

/**
 * name -> what to paint under it, for every source the productions hold at every size it may be
 * painted at. The media route and the sweep read this one list, so a picture the route would
 * paint is a picture the sweep keeps. A source whose typeface refuses its weight or slant names
 * no picture (the plan refuses that clip), so it is left out.
 *
 * Every name is a hash in plain TypeScript, and the records repeat themselves: a ripple edit on a
 * names track holds both sides of every clip it moved, so fifty names under a hundred such edits
 * are thirty thousand sources for a hundred and fifty pictures. Hashing each one cost most of a
 * second on the coordinator's loop for every picture the Viewer found missing (after a copied
 * world or a deleted folder, all of them). So a source is hashed at a size only the first time its
 * words and look appear at that size, and the list is kept for the productions array it came
 * from: the store replaces that array on every commit and never changes one it has handed out,
 * so a later miss before the next commit is a lookup. Callers must not change the list.
 *
 * The repeat test is plain JSON, not the canonical form the name is hashed from, which more than
 * doubled the walk on those records. It need only never call two different sources the same: a
 * look written with its keys in another order is hashed once more, and the name is still one.
 */
export function textPicturesNamed(productions: readonly Pick<ProductionBundle, "timeline" | "editorRequests">[]): ReadonlyMap<string, TextPictureAsk> {
  const known = namedFor.get(productions);
  if (known !== undefined) return known;
  const named = new Map<string, TextPictureAsk>(), seen = new Set<string>();
  for (const production of productions) for (const source of textSourcesNamed(production)) {
    const key = JSON.stringify([source.text, source.look]);
    for (const frame of textPictureSizes(source)) {
      const sized = `${frame.width}x${frame.height} ${key}`;
      if (seen.has(sized)) continue;
      seen.add(sized);
      const ref = textPicturePath(source, frame);
      if (ref.ok && !named.has(ref.name)) named.set(ref.name, { text: source.text, look: source.look, width: frame.width, height: frame.height });
    }
  }
  namedFor.set(productions, named);
  return named;
}

/**
 * The file a kept picture is in, or null when there is none worth serving. A file of no bytes is
 * not a picture; `atomicWriteFile` never leaves one under a final name, but a hand or a disk might.
 * A folder that is missing, or one that is not a plain folder inside the world, is no file.
 */
async function keptFile(dir: string, path: string): Promise<string | null> {
  const file = await containedWorldFilePath(dir, path, false, "world", true).catch(() => null);
  if (file === null) return null;
  const info = await stat(file).catch(() => null);
  return info !== null && info.isFile() && info.size > 0 ? file : null;
}

/** The keep of each name now running in each world, which `keepTextPicture` hands every ask that arrives meanwhile. */
const keeping = new WeakMap<WorldStore, Map<string, Promise<TextPictureKept>>>();
const notKept = (error: unknown): TextPictureKept =>
  ({ ok: false, reason: `Text picture not kept: ${error instanceof Error ? error.message : String(error)}` });

/**
 * Makes sure one picture is on disk and says where it is. One already there is used as it is,
 * with nothing painted and nothing written: a name is everything that decides a pixel, so a kept
 * picture is never rewritten (R-20, R-23), and an export that read it at its start reads the same
 * file at its end. That also needs no write, so a world that cannot be written still shows and
 * exports what it has already kept.
 *
 * Otherwise it is painted and written whole or not at all. An ask for a name whose keep is still
 * running shares that keep's answer, so the Viewer's, a second window's and an export's asks for
 * one picture that arrive together are one paint, not one each. Whether the file is there is asked
 * again inside the world's write queue, so a keep never writes over a file that appeared while it
 * waited. A world that cannot be written (closed, its lock lost, or holding external edits awaiting
 * reconciliation) refuses before anything is painted, in the store's own words, and never throws:
 * nothing it paints could be kept, and the Viewer asks again each time the clip comes back into its
 * window. `from` is where the fonts folder is looked for, as the painter reads it.
 */
export async function keepTextPicture(store: WorldStore, ask: TextPictureAsk, from?: string): Promise<TextPictureKept> {
  const ref = textPicturePath(ask, ask);
  if (!ref.ok) return ref;
  const running = keeping.get(store) ?? new Map<string, Promise<TextPictureKept>>();
  keeping.set(store, running);
  // By the fonts folder too, though the app has one: a keep that paints from another folder may
  // refuse where this one would not, and its answer is not this ask's.
  const key = `${ref.name} ${from ?? ""}`, joined = running.get(key);
  if (joined !== undefined) return joined;
  const keep = keepNamed(store, ask, ref, from).finally(() => running.delete(key));
  running.set(key, keep);
  return keep;
}

/** One name's keep, run once however many ask for it together. */
async function keepNamed(store: WorldStore, ask: TextPictureAsk, ref: { name: string; path: string }, from?: string): Promise<TextPictureKept> {
  const kept = await keptFile(store.dir, ref.path);
  if (kept !== null) return { ok: true, name: ref.name, path: kept };
  // `derivedWrite` refuses a world that cannot be written before it queues anything, so asking it
  // here waits behind nothing and gives the store's own words for the log.
  if (!store.canWrite()) return store.derivedWrite(async () => notKept("the world cannot be written")).catch(notKept);
  const paint = paintTextPicture(ask, from);
  if (!paint.ok) return paint;
  // The plan names a picture from the record and the painter names the one it drew; a picture kept
  // under a name its ink does not have would be found for the wrong words for as long as it is kept.
  if (paint.name !== ref.name) return { ok: false, reason: "A text picture's name does not match its ink" };
  const png = textPicturePng(paint);
  try {
    const file = await store.derivedWrite(async () => {
      const target = await containedWorldFilePath(store.dir, ref.path, true);
      if (await keptFile(store.dir, ref.path) === null) await atomicWriteFile(target, png);
      return target;
    });
    return { ok: true, name: ref.name, path: file };
  } catch (error) {
    return notKept(error);
  }
}

/**
 * The media route's answer for `.cache/editor-text/<64 hex>.png` (R-20): the kept file, painted
 * now when the open world's records name it, else null, which the route answers as not found.
 * The path pattern is the fence: anything else under the folder, a name nothing names, another
 * world's slug or a closed world is null and nothing is painted, so the route cannot be used to
 * make the coordinator draw words the world does not hold. `refused` is told why a picture the
 * world does name could not be kept; the page loads it as an image and could not read a reason
 * from the answer. It never throws.
 */
export async function serveTextPicture(store: WorldStore | null | undefined, slug: string, relative: string,
  from?: string, refused?: (reason: string) => void): Promise<{ path: string; contentType: string } | null> {
  const match = TEXT_PICTURE_PATH.exec(relative);
  if (!match || !store || store.isClosed() || store.getBundle().meta.slug !== slug) return null;
  try {
    const kept = await keptFile(store.dir, relative);
    if (kept !== null) return { path: kept, contentType: "image/png" };
    const ask = textPicturesNamed(store.getBundle().productions).get(match[1]!);
    if (!ask) return null;
    const made = await keepTextPicture(store, ask, from);
    if (made.ok) return { path: made.path, contentType: "image/png" };
    refused?.(made.reason);
    return null;
  } catch {
    return null;
  }
}

/**
 * Removes the kept pictures nothing names any more (§2.3), and any stage file a write was cut
 * short in. Nothing else in the folder is touched, and the folder itself stays. When any timeline
 * cannot be read its names are unknown, so nothing is removed: a picture is cheap to keep, and one
 * removed wrongly is only painted again, but there is no reason to pay for that. A world that
 * cannot be written is swept at its next open. Run once when the world opens, where no export of
 * it can be running.
 */
export async function sweepTextPictures(store: WorldStore): Promise<{ removed: number; skipped: boolean }> {
  const productions = store.getBundle().productions;
  if (!productions.every(textSourcesReadable)) return { removed: 0, skipped: true };
  const named = textPicturesNamed(productions);
  try {
    return await store.derivedWrite(async () => {
      // A name inside the folder, so the folder is found through the same containment as a picture:
      // a `.cache` that is a link out of the world is never listed.
      const probe = await containedWorldFilePath(store.dir, `${TEXT_PICTURE_DIR}/${"0".repeat(64)}.png`, false, "world", true).catch(() => null);
      if (probe === null) return { removed: 0, skipped: false };
      const entries = await readdir(dirname(probe)).catch(() => [] as string[]);
      let removed = 0;
      for (const entry of entries) {
        const kept = KEPT.exec(entry);
        if (kept ? named.has(kept[1]!) : !STAGE.test(entry)) continue;
        const file = await containedWorldFilePath(store.dir, `${TEXT_PICTURE_DIR}/${entry}`).catch(() => null);
        // A file that will not go now (held open for a moment, say) goes at the next open.
        if (file !== null && await rm(file, { force: true }).then(() => true, () => false)) removed += 1;
      }
      return { removed, skipped: false };
    });
  } catch {
    return { removed: 0, skipped: true };
  }
}

const textClips = (timeline: ProductionTimeline): TextSourceNamed[] =>
  timeline.tracks.flatMap(track => track.clips.flatMap(clip => textOf(clip) ?? []));
const sourceKey = (source: Pick<TextSourceNamed, "text" | "look">): string => canonicalJson({ text: source.text, look: source.look });

/**
 * Refuses a batch that leaves words or a look the painter would refuse (R-21), in the painter's
 * own words and before anything is written. Only words and looks this batch brought in are asked:
 * one the timeline already held drew when it was set, and a clip that has since become unpaintable
 * (a face file gone missing) must still be movable, deletable and retypeable into something that
 * draws. A split or a duplicate brings in nothing new and so asks nothing.
 *
 * Synchronous, and it writes nothing: it runs inside the timeline command's write, which holds the
 * world's write queue, and a keep or a sweep awaited there would wait for itself. It lays out and
 * paints nothing, at one frame size, because what a typeface lacks does not change with the frame
 * and Fit draws a line too wide for its room smaller rather than refusing it (R-10).
 */
export function refuseUnpaintableText(current: ProductionTimeline, next: ProductionTimeline, frame: TextFrame, from?: string): void {
  const asked = new Set(textClips(current).map(sourceKey));
  for (const source of textClips(next)) {
    const key = sourceKey(source);
    if (asked.has(key)) continue;
    asked.add(key);
    const reason = textPictureRefusal({ text: source.text, look: source.look, width: frame.width, height: frame.height }, from);
    if (reason !== null) throw new TimelineOperationRefused(reason);
  }
}

/** The export's refusal: the first clip by its label and the painter's reason, then how many more. */
function exportRefusal(refusals: readonly TextPictureRefusal[]): string {
  const [first] = refusals, more = refusals.length - 1;
  const text = `timeline is not ready to export: the text "${first!.label}" cannot be drawn: ${first!.reason}`
    + (more > 0 ? ` (and ${more} more text ${more === 1 ? "clip" : "clips"})` : "");
  // Cut by characters, not code units, so a label that ends in a pair never leaves half of one.
  const characters = [...text];
  return characters.length <= 500 ? text : `${characters.slice(0, 499).join("")}…`;
}

/**
 * Before an export renders (R-21): keeps every picture its plan names and says, by clip, which
 * cannot be drawn. Null when every one is kept or the plan names none; a plan with no text touches
 * no file here, so a film with no text exports exactly as it did (R-40). One site covers an export
 * begun from the Cut, from a script with no window open and by Arke, because all three reach the
 * export handler with a plan; the pictures exist before the effect host probes them for their size.
 *
 * Each picture is kept at the size its own layer says, and found by the layer's clip. Nothing here
 * asks what size the export is: a moving clip will be read from a picture larger than its frame
 * beside a still one at its frame, in the same export (R-17). A layer this cannot account for (no
 * size, a clip that is not text, a name the clip's words do not make) means the plan and its
 * timeline disagree, which no edit a person makes should reach; that refuses rather than renders.
 *
 * Only the layers inside the delivered window count. An episode's plan is the production's cut to
 * the episode, and the cut moves the window but keeps every layer; the export drops the rest before
 * it reads a file (`runEffectExport`), so painting them is wasted, and refusing on one would fail an
 * episode over words it does not hold, which the planner's episode rule exists to prevent.
 */
export async function textPicturesForExport(store: WorldStore, timeline: ProductionTimeline,
  plan: Pick<RenderPlan, "overlays"> & { effectRender?: Pick<NonNullable<RenderPlan["effectRender"]>, "pictureLayers" | "startFrame" | "endFrame"> },
  from?: string): Promise<string | null> {
  const delivered = plan.effectRender;
  const layers = delivered === undefined ? [] : delivered.pictureLayers.filter(layer => layer.path !== undefined && TEXT_PICTURE_PATH.test(layer.path)
    && layer.startFrame < delivered.endFrame && layer.endFrame > delivered.startFrame);
  // Every text clip sends its film through the compositor, so a kept picture an overlay names
  // without a layer is a plan this build does not make. The overlays are cut to the same window
  // as the layers, so a film whose text all lies outside it has neither.
  if (layers.length === 0) return plan.overlays.some(overlay => TEXT_PICTURE_PATH.test(overlay.path)) ? MISSING : null;
  // Keyed by plain string: a layer names its clip as the plan carries it, not as the record types it.
  const clips = new Map<string, TimelineClip>(timeline.tracks.flatMap(track => track.clips.map(clip => [clip.id, clip] as const)));
  const refusals: TextPictureRefusal[] = [];
  for (const layer of layers) {
    const source = clips.get(layer.clipId)?.source;
    if (source?.kind !== "text" || !layer.sourceSize) return MISSING;
    if (refusals.some(refusal => refusal.clipId === layer.clipId)) continue;
    const ask: TextPictureAsk = { text: source.text, look: source.look, width: layer.sourceSize.width, height: layer.sourceSize.height };
    const ref = textPicturePath(ask, ask);
    if (ref.ok && ref.path !== layer.path) return MISSING;
    const kept = ref.ok ? await keepTextPicture(store, ask, from) : ref;
    if (!kept.ok) refusals.push({ clipId: layer.clipId, label: source.label, reason: kept.reason });
  }
  return refusals.length > 0 ? exportRefusal(refusals) : null;
}
