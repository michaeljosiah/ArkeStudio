import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  orderedShots, TAKE_MEDIA_IDENTITY_SCHEMA_VERSION, TakeSchema,
  type Shot, type Take,
} from "@arke-studio/contracts";
import { containedArtifactFile } from "../artifacts/contained.js";
import type { AgentMediaTools } from "../media/agent-media-tools.js";
import { findCuts } from "../media/contact-sheet.js";
import { frameMotion } from "../media/measure-sync.js";
import { toExtendedLength } from "../world/paths.js";
import { WorldStateStaleError, type WorldStatePrecondition, type WorldStore } from "../world/store.js";

/*
 * A clip made somewhere else, kept as a take.
 *
 * Gold on Gold was shot on a route the Studio does not have: a hundred and seven clips were made
 * on another site and cut together outside, and because a downloaded clip could only sit on the
 * shelf as a file, none of them was a take. So no check ran on any of them, `list_takes` showed
 * Arke nothing, the rule that makes it look before it changes a shot beside a take never fired,
 * and the owner found by eye and ear what the checks exist to find. This is the door: the same
 * record a generated clip leaves, with the identity that says no model ran here (`user` /
 * `upload`, as an uploaded frame carries), so everything that reads takes reads these.
 *
 * One clip often holds several shots, cut inside it by the model. Those become segments of it, as
 * a scene pass's shots do, but cut where the picture cuts rather than where the cuts were asked
 * for: a model asked to cut at 5.6 s cuts at 6.2, and a segment cut on the asked second opens on
 * the last half second of the shot before it.
 */

/** Video a clip can arrive as. Bare extensions: this is a picker's filter as well as a check. */
export const IMPORTABLE_CLIPS = ["mp4", "mov", "webm"] as const;

/** A refusal whose words are for the person: they name no path and nothing of the host. */
export class ClipImportError extends Error {}

/**
 * The file of a video on the shelf, or null when it is not one. A sidecar's file name is only a
 * string the scan accepted: one that climbs out of the shelf, or names a link to a file of the
 * host's, would be copied into the world on an approval that showed a shelf video and no file
 * picker (codex on PR 3328). So it is resolved as the shelf's posters and borrowing resolve
 * theirs: a plain file, itself inside `artifacts/`.
 */
export async function shelfClipFile(worldDir: string, artifacts: ReadonlyArray<{ id: string; kind: string; file: string }>, artifactId: string): Promise<string | null> {
  const artifact = artifacts.find(candidate => candidate.id === artifactId);
  return artifact?.kind === "video" ? containedArtifactFile(worldDir, artifact.file) : null;
}

/** The picture is read a minute at a time, each minute starting a second inside the last so a cut on the join is in one of them. */
const SCAN_SEC = 60, SCAN_OVERLAP_SEC = 1;
/** A clip longer than this is not a board made as one clip, and is not read to be divided. */
const LONGEST_SCAN_SEC = 600;

/**
 * A clip's length and where its picture cuts, read as the checks after a take read a take: ten
 * frames a second, over the whole of it. The whole, because the cuts are trusted to be all of
 * them: read for its first minute only, a ninety-second clip of two shots with a stray cut at 15 s
 * and its real one at 75 s had one cut found, and one seam, and was divided at 15 (codex on
 * PR 3328). Null on a host with no picture tools, a file with no picture, or a clip too long to
 * be one; a clip of several shots cannot be divided then, and is refused by name.
 */
export async function clipCuts(tools: AgentMediaTools, path: string, signal: AbortSignal): Promise<{ durationSec: number; cuts: number[] } | null> {
  if (!tools.grayFrames) return null;
  const inventory = await tools.probe(path, signal), video = inventory.streams.find(stream => stream.kind === "video");
  const durationSec = inventory.durationSec;
  if (!video || durationSec === null || !(durationSec > 0) || durationSec > LONGEST_SCAN_SEC) return null;
  const cuts: number[] = [];
  for (let from = 0; from < durationSec; from += SCAN_SEC - SCAN_OVERLAP_SEC) {
    const picture = await tools.grayFrames(path, video, from, Math.min(durationSec, from + SCAN_SEC), { fps: 10, edge: 256 }, signal);
    for (const cut of findCuts([...frameMotion(picture.frames)], 10)) {
      const at = round(from + cut);
      // The second two readings share finds the same cut twice.
      if (!cuts.some(found => Math.abs(found - at) < .15)) cuts.push(at);
    }
    if (from + SCAN_SEC >= durationSec) break;
  }
  return { durationSec, cuts: cuts.sort((a, b) => a - b) };
}

/** A model's cut can land this far from where it was asked for and still be that cut. */
const CUT_REACH_SEC = 1.5;
/** A segment shorter than this is not a shot: a cut found that close to another is the same cut, or a flash. */
const SHORTEST_SEGMENT_SEC = .3;

export interface SegmentBounds { from: "cuts" | "plan"; bounds: Array<{ shotId: string; inSec: number; outSec: number }> }

/**
 * Where each shot of a clip made as several shots sits in it. `planned` is the shots in order with
 * the seconds each was written to run; the clip came back `durationSec` long with its picture
 * cutting at `cuts`. With exactly one cut a seam, the cuts are the seams, so long as each is in its
 * seam's part of the clip: a clip whose model cut once in the wrong place and not at all at its
 * seam has the right number of cuts and none of them a seam. With more or fewer, each seam takes
 * the nearest cut within reach of where the plan put it, and if any seam finds none the whole
 * clip is divided by the plan (scaled to its real length): half of it snapped and half not would
 * put one shot's frames in two segments.
 */
export function segmentBounds(planned: ReadonlyArray<{ shotId: string; sec: number }>, durationSec: number, cuts: readonly number[]): SegmentBounds {
  const total = planned.reduce((sum, shot) => sum + shot.sec, 0), scale = total > 0 ? durationSec / total : 0;
  const seams: number[] = [];
  for (let i = 0, at = 0; i < planned.length - 1; i++) seams.push((at += planned[i]!.sec) * scale);
  const from = (edges: readonly number[], source: SegmentBounds["from"]): SegmentBounds => ({ from: source,
    bounds: planned.map((shot, i) => ({ shotId: shot.shotId, inSec: round(i === 0 ? 0 : edges[i - 1]!), outSec: round(i === planned.length - 1 ? durationSec : edges[i]!) })) });
  const usable = (edges: readonly number[]) => [0, ...edges, durationSec].every((edge, i, all) => i === 0 || edge - all[i - 1]! >= SHORTEST_SEGMENT_SEC);
  const found = [...cuts].filter(cut => cut > 0 && cut < durationSec).sort((a, b) => a - b);
  if (seams.length === 0) return from([], "cuts");
  // As many cuts as seams: a model's timing wanders further than one cut's reach, but not into another shot's part of the clip.
  const wander = Math.max(CUT_REACH_SEC, durationSec / 4);
  if (found.length === seams.length && usable(found) && found.every((cut, i) => Math.abs(cut - seams[i]!) <= wander)) return from(found, "cuts");
  const taken = new Set<number>(), snapped: number[] = [];
  for (const seam of seams) {
    let best = -1;
    for (let i = 0; i < found.length; i++) {
      if (taken.has(i) || Math.abs(found[i]! - seam) > CUT_REACH_SEC || snapped.length > 0 && found[i]! <= snapped[snapped.length - 1]!) continue;
      if (best < 0 || Math.abs(found[i]! - seam) < Math.abs(found[best]! - seam)) best = i;
    }
    if (best < 0) return from(seams, "plan");
    taken.add(best); snapped.push(found[best]!);
  }
  return usable(snapped) ? from(snapped, "cuts") : from(seams, "plan");
}
const round = (value: number) => Math.round(value * 1000) / 1000;

export interface ImportedClipInput {
  productionId: string;
  /** One shot, or a run of consecutive shots of one scene the clip was made as. */
  shotIds: readonly string[];
  /** The file to copy in: one the person picked, or a video already on the shelf. It is left where it is. */
  sourcePath: string;
  /** The clip's own take id (the pass's, when it covers several shots), so a retry files nothing twice. */
  takeId: Take["id"];
  /** What made it and from what words, said by whoever files it: the Studio sent nothing and knows neither. */
  madeWith?: string;
  prompt?: string;
  /** The clip's length and where its picture cuts. Needed to divide a clip of several shots. */
  measure?: (path: string) => Promise<{ durationSec: number; cuts: number[] } | null>;
  source?: string;
  requestId?: string;
  precondition?: WorldStatePrecondition;
}

export interface ImportedClip {
  /** The clip itself: the take of its one shot, or the pass its segments are ranges of. */
  clip: Take;
  /** The takes a shot can choose: the clip for one shot, a segment a shot for several. */
  takes: Take[];
  /** How a clip of several shots was divided; null for a clip of one. */
  segmentsFrom: SegmentBounds["from"] | null;
}

const fileHash = (path: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(toExtendedLength(path)).on("data", chunk => hash.update(chunk)).on("error", reject).on("end", () => resolve(`sha256:${hash.digest("hex")}`));
});

/** A segment's id from its clip's, so the same clip filed again names the same segments. */
function segmentId(clipId: string, index: number): Take["id"] {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", digest = createHash("sha256").update(`${clipId}:segment:${index}`).digest();
  return `tk_${Array.from({ length: 26 }, (_, i) => alphabet[digest[i]! % 32]).join("")}` as Take["id"];
}

/** What a shot was written to run, for dividing a clip nobody could find the cuts of. */
const DEFAULT_SHOT_SEC = 5;

export async function recordImportedClipTakes(store: WorldStore, input: ImportedClipInput): Promise<ImportedClip> {
  const extension = extname(input.sourcePath).toLowerCase();
  if (!(IMPORTABLE_CLIPS as readonly string[]).includes(extension.slice(1))) throw new ClipImportError("That file is not a video the Studio can hold. Choose an MP4, MOV or WebM.");
  const info = await stat(toExtendedLength(input.sourcePath)).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new ClipImportError("That file could not be read. Try choosing it again.");
  if (input.shotIds.length === 0 || new Set(input.shotIds).size !== input.shotIds.length) throw new ClipImportError("Name the shot the clip is for, or the run of shots it was made as.");
  const several = input.shotIds.length > 1;
  // Read before the gate: finding a clip's cuts decodes it, and nothing else should wait on that.
  const measured = several ? await input.measure?.(input.sourcePath).catch(() => null) ?? null : null;
  if (several && (measured === null || !(measured.durationSec > 0))) throw new ClipImportError("This Studio could not read the clip to find its shots. File it one shot at a time.");

  return store.gateOp(async () => {
    const stale = input.precondition?.();
    if (stale) throw new WorldStateStaleError(stale);
    const bundle = store.getBundle();
    const production = bundle.productions.find(candidate => candidate.meta.id === input.productionId);
    if (!production) throw new Error(`no production ${input.productionId}`);
    let shots: Shot[] | null = null;
    for (const scene of production.scenes) {
      let ordered: Shot[];
      try { ordered = orderedShots(scene); } catch { continue; }
      const first = ordered.findIndex(shot => shot.id === input.shotIds[0]);
      if (first < 0) continue;
      const run = ordered.slice(first, first + input.shotIds.length);
      if (run.length === input.shotIds.length && run.every((shot, i) => shot.id === input.shotIds[i])) shots = run;
      break;
    }
    if (shots === null) throw new ClipImportError("Those shots are not a run of consecutive shots in one scene.");

    const existing = production.takes.find(take => take.id === input.takeId);
    if (existing) {
      if (existing.provider !== "user" || existing.model !== "upload" || existing.kind !== "clip" || !input.shotIds.every(id => existing.coversShots.includes(id as never))) {
        throw new Error(`take ${input.takeId} already records different work`);
      }
      const segments = production.takes.filter(take => take.segment?.passTakeId === existing.id);
      return { clip: existing, takes: several ? segments : [existing], segmentsFrom: several ? (existing.params["segmentsFrom"] === "cuts" ? "cuts" : "plan") : null };
    }

    const now = store.now(), media = `clip-upload${extension}`, dir = join(store.dir, "productions", input.productionId, "takes", input.takeId);
    const divided = several ? segmentBounds(shots.map(shot => ({ shotId: shot.id, sec: shot.durationSec ?? DEFAULT_SHOT_SEC })), measured!.durationSec, measured!.cuts) : null;
    await mkdir(toExtendedLength(dir), { recursive: true });
    await copyFile(toExtendedLength(input.sourcePath), toExtendedLength(join(dir, media))).catch(() => { throw new ClipImportError("That video could not be copied into the production."); });
    const shared = {
      kind: "clip" as const, provider: "user", model: "upload",
      provenance: { canonRevision: bundle.meta.canonRevision, sheets: {}, artDirectionVersion: bundle.artDirection.version },
      ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
      references: [],
      params: { uploadedFile: media, ...(input.madeWith?.trim() ? { madeWith: input.madeWith.trim() } : {}), ...(divided ? { segmentsFrom: divided.from } : {}) },
      dispatchedAt: now, completedAt: now,
    };
    let clip: Take, takes: Take[];
    try {
      clip = TakeSchema.parse({ ...shared, id: input.takeId, coversShots: [...input.shotIds], media, mediaHash: await fileHash(join(dir, media)),
        cost: { estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "local-zero" } });
      // A segment is a range of the clip, not a file: its media and hash are the clip's.
      takes = divided === null ? [clip] : divided.bounds.map((bound, i) => TakeSchema.parse({ ...shared, id: segmentId(input.takeId, i), coversShots: [bound.shotId],
        cost: { estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "local-zero", allocated: true },
        segment: { passTakeId: input.takeId, inSec: bound.inSec, outSec: bound.outSec } }));
    } catch (error) {
      await rm(toExtendedLength(dir), { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    // A rejected commit may have landed before its rescan failed: the copied clip stays, so a
    // retry under the same request finds its bytes (the uploaded frame's rule).
    await store.commitUnserialised({
      kind: "take-upload",
      raiseSchemaVersion: TAKE_MEDIA_IDENTITY_SCHEMA_VERSION,
      source: input.source ?? "user",
      files: [clip, ...(divided === null ? [] : takes)].map(take => ({
        path: `productions/${input.productionId}/takes/${take.id}/take.json`, action: "create" as const, content: JSON.stringify(take, null, 2) + "\n", baseHash: null })),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    return { clip, takes, segmentsFrom: divided?.from ?? null };
  });
}
