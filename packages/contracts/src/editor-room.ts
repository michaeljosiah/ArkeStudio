import { z } from "zod";
import { ArtifactIdSchema } from "./ids.js";
import type { TimelineClipCommand, TimelineClipId, TimelineTrackId } from "./timeline.js";

// Spelled here rather than read from the timeline, which reads this module.
const clipId = z.string().regex(/^cl_[A-Za-z0-9][A-Za-z0-9_-]*$/) as z.ZodType<TimelineClipId>;
const trackId = z.string().regex(/^tr_[A-Za-z0-9][A-Za-z0-9_-]*$/) as z.ZodType<TimelineTrackId>;
const SOUND_TRACK_KINDS: ReadonlySet<string> = new Set(["audio", "dialogue", "ambience", "music"]);

/**
 * A room laid from pieces (SPEC-038 R-61..R-64).
 *
 * A place has one room, and a made bed of it is seconds long. Looped under a scene it brings
 * every laugh back on the same beat: the film's first scene ran one six-second crowd nine times,
 * and the owner heard it ("I can hear the same laughing repeating over and over"). What mended it
 * was built outside the Studio: several beds cut into pieces, played in a shuffled order with no
 * piece used twice while an unused one remained, each crossing into the next at even power, and a
 * second layer under the first with its joins somewhere else.
 *
 * Here that is one command. What it lays is ordinary clips on ordinary tracks, each with its own
 * gain and its own even-power fades, so everything after the laying is the Cut as it already is:
 * a piece can be moved, swapped or deleted, and the card that asks for the room lists every one.
 */
export const ROOM = Object.freeze({
  /** A piece is between these long: short enough that no one piece's events are learned, long enough to be a room and not a stutter. */
  pieceMinSec: 4.5, pieceMaxSec: 8.5,
  /** A piece crosses into the next over this long, each at even power (R-54), so the room holds one level through the join. */
  crossSec: 1.2,
  /** A bed's first piece starts up to this far into it, so two rooms laid from the same beds do not cut them at the same places. */
  leadMaxSec: 1.5,
  /** The second layer plays this far under the first, and comes in this long after it, so its joins fall between the first's. */
  secondLayerDb: -4, secondLayerOffsetSec: 3.1,
  /** A bed is cut from at most this much of its file. */
  maxSourceSec: 600,
  maxSources: 12,
  /** As many pieces as one command lays; a longer room is laid in parts. */
  maxPieces: 240,
});

const second = z.number().finite().min(0).max(86_400);
const RoomSourceSchema = z.object({
  artifactId: ArtifactIdSchema,
  /** What each piece cut from this bed is called on its track. */
  label: z.string().min(1).max(200),
  /** The stretch of the file the bed is cut from, where it is not the whole of it. */
  inSec: second.optional(),
  /** Where that stretch ends. Asked or not, the coordinator holds it to the file's own length when it measures (R-63). */
  outSec: second.optional(),
  /** The stretch's loudness as the film plays it, measured by the coordinator; a command without it has not been measured (R-63). */
  measuredLufs: z.number().finite().min(-120).max(10).optional(),
}).strict();
export type RoomSource = z.infer<typeof RoomSourceSchema>;

/**
 * Lay a room. Two track ids lay one layer, alternating between them, because pieces that cross
 * cannot share a track; four lay a second layer on the last two. A track that is not on the
 * timeline is made, as an Ambience track that holds under speech (R-53); one that is there is used
 * as it is. The pieces are `clipId-1`, `clipId-2` and on, in the order they play, the first
 * layer's first.
 *
 * `lufs` is the room as a whole, both layers together. Nothing here listens: the coordinator
 * measures each bed and fills in its length and loudness before the command is applied or a
 * request is stored, and picks the seed where none was given, so a record replays to the room it
 * showed (R-63).
 */
export const LayRoomCommandSchema = z.object({
  kind: z.literal("lay-room"),
  clipId,
  // A plain object, as every command in the union is: what a schema cannot say here (different tracks, each bed once) the laying refuses.
  trackIds: z.union([z.tuple([trackId, trackId]), z.tuple([trackId, trackId, trackId, trackId])]),
  sources: z.array(RoomSourceSchema).min(1).max(ROOM.maxSources),
  startFrame: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  durationFrames: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  lufs: z.number().finite().min(-50).max(-5),
  seed: z.number().int().min(0).max(0x7fffffff).optional(),
}).strict();
export type LayRoomCommand = z.infer<typeof LayRoomCommandSchema>;
export const isLayRoomCommand = (value: { kind: string }): value is LayRoomCommand => value.kind === "lay-room";

/** Whether the coordinator has still to measure a room's beds and settle its seed. */
export const roomNeedsMeasure = (command: LayRoomCommand): boolean =>
  command.seed === undefined || command.sources.some(source => source.outSec === undefined || source.measuredLufs === undefined);

/** The stretch of a bed a room is cut from, in seconds, or why it has none. */
export function roomSourceWindow(source: Pick<RoomSource, "inSec" | "outSec" | "label">, fileSec: number): { ok: true; inSec: number; outSec: number } | { ok: false; reason: string } {
  const inSec = source.inSec ?? 0, outSec = Math.min(source.outSec ?? fileSec, fileSec, inSec + ROOM.maxSourceSec);
  if (!(outSec - inSec >= ROOM.pieceMinSec)) return { ok: false, reason: `${source.label} has ${Math.max(0, Math.round((outSec - inSec) * 10) / 10)} s to cut from, and a room's piece is at least ${ROOM.pieceMinSec} s` };
  return { ok: true, inSec, outSec };
}

/**
 * Each layer's loudness, so that the layers together are the room's (R-62). Two layers of
 * different sound add as powers: the first sits a little under the figure, the second its own
 * step under that.
 */
export function roomLayerLufs(lufs: number, layers: 1 | 2): [number] | [number, number] {
  if (layers === 1) return [lufs];
  const first = lufs - 10 * Math.log10(1 + Math.pow(10, ROOM.secondLayerDb / 10));
  return [first, first + ROOM.secondLayerDb];
}

/** One piece of a laid room, in frames of the film from the room's own start. */
export interface RoomPiece { layer: 0 | 1; row: 0 | 1; source: number; sourceInFrames: number; startFrame: number; durationFrames: number }

/** Small, fast and the same on every machine: a room replays from its seed (R-63). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** How long a join is, and the least a piece may play, in frames: two fades and a breath between them. */
export function roomFrames(frameRate: number): { cross: number; least: number } {
  const cross = Math.max(1, Math.round(ROOM.crossSec * frameRate));
  return { cross, least: 2 * cross + Math.max(1, Math.round(.2 * frameRate)) };
}

/**
 * Where each piece of a room plays (R-61). Pure, and all of it in whole frames, so a join is
 * exactly as long on the timeline as the fades that cross it and the room ends on its last frame.
 *
 * Each bed is cut into pieces end to end. They are shuffled, then laid one after another, each
 * starting one join before the last one ends. The piece taken next is one used least so far. Of
 * those, it is one from a bed the other layer is not playing then, and from another bed than the
 * piece before it, where there is one; the other layer's rule comes first, because one bed on
 * both layers at once is the same sound twice. So nothing is heard twice while anything is
 * unheard, and what repeats in a room longer than its beds repeats as late as it can.
 *
 * A piece that would leave less than a piece's least for the last one is shortened to leave
 * exactly that, so no clip is ever shorter than its own two fades.
 */
export function roomPieces(input: { sources: ReadonlyArray<{ inSec: number; outSec: number }>; durationFrames: number; frameRate: number; layers: 1 | 2; seed: number }): RoomPiece[] {
  const { frameRate: fps, durationFrames: total } = input, { cross, least } = roomFrames(fps), random = seeded(input.seed);
  const cuts: Array<{ source: number; inFrames: number; frames: number; uses: number }> = [];
  input.sources.forEach((source, index) => {
    // The lead never takes a bed's only piece: a bed five seconds long starts within half a second of its start.
    let at = source.inSec + random() * Math.min(ROOM.leadMaxSec, Math.max(0, source.outSec - source.inSec - ROOM.pieceMinSec));
    while (at + ROOM.pieceMinSec <= source.outSec + 1e-9) {
      const length = Math.min(ROOM.pieceMinSec + random() * (ROOM.pieceMaxSec - ROOM.pieceMinSec), source.outSec - at);
      const inFrames = Math.ceil(at * fps - 1e-9), frames = Math.floor((at + length) * fps + 1e-9) - inFrames;
      if (frames >= least) cuts.push({ source: index, inFrames, frames, uses: 0 });
      // Half a join shared with the next piece of the same bed: they are never neighbours unless the room has run out of others.
      at += length - ROOM.crossSec / 2;
    }
  });
  if (cuts.length === 0) return [];
  for (let i = cuts.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [cuts[i], cuts[j]] = [cuts[j]!, cuts[i]!]; }

  const pieces: RoomPiece[] = [];
  for (const layer of (input.layers === 2 ? [0, 1] : [0]) as Array<0 | 1>) {
    const offset = layer === 0 ? 0 : Math.round(ROOM.secondLayerOffsetSec * fps);
    // A room too short to hold a second layer's first piece has one layer.
    if (total - offset < least) continue;
    let at = offset, count = 0, last = -1;
    for (;;) {
      const fewest = Math.min(...cuts.map(cut => cut.uses)), free = cuts.filter(cut => cut.uses === fewest);
      const busy = (cut: { source: number; frames: number }) => pieces.some(piece => piece.layer !== layer && piece.source === cut.source && piece.startFrame < at + cut.frames && at < piece.startFrame + piece.durationFrames);
      const pick = free.find(cut => cut.source !== last && !busy(cut)) ?? free.find(cut => !busy(cut)) ?? free.find(cut => cut.source !== last) ?? free[0]!;
      const remaining = total - at;
      let frames = pick.frames;
      if (frames >= remaining) frames = remaining;
      else { const after = remaining - (frames - cross); if (after < least) frames -= least - after; }
      pieces.push({ layer, row: (count % 2) as 0 | 1, source: pick.source, sourceInFrames: pick.inFrames, startFrame: at, durationFrames: frames });
      pick.uses++; last = pick.source; count++;
      if (at + frames >= total) break;
      at += frames - cross;
    }
  }
  return pieces;
}

/** The most pieces a room of this length could take, counted before it is cut: every piece at its shortest. */
export function roomPieceBound(durationFrames: number, frameRate: number, layers: 1 | 2): number {
  const { cross } = roomFrames(frameRate), step = Math.max(1, Math.floor(ROOM.pieceMinSec * frameRate) - 1 - cross);
  return layers * (Math.ceil(durationFrames / step) + 1);
}

/**
 * A measured room as the commands that lay it (R-61, R-62): the tracks it needs that are not
 * there, then each piece placed with the gain that brings its bed to its layer's loudness on its
 * own track, and an even-power fade at each end. Pure; the reducer applies what this returns one
 * step after another, so a room is laid by the same rules as a batch made by hand, and refused
 * whole where any step is.
 */
export function layRoomSteps(tracks: ReadonlyArray<{ id: string; kind: string; name?: string; levelDb?: number }>, frameRate: number, command: LayRoomCommand): TimelineClipCommand[] {
  if (roomNeedsMeasure(command)) throw new Error("A room is laid from its beds as they were measured; this host did not measure them");
  if (new Set(command.trackIds).size !== command.trackIds.length) throw new Error("A room's tracks are different tracks: pieces that cross cannot share one");
  if (new Set(command.sources.map(source => source.artifactId)).size !== command.sources.length) throw new Error("A room names each bed once");
  const layers = command.trackIds.length === 4 ? 2 : 1, { cross, least } = roomFrames(frameRate);
  if (command.durationFrames < least) throw new Error(`A room is at least ${Math.round(least / frameRate * 10) / 10} s long: a piece fades in and out over ${ROOM.crossSec} s each`);
  if (roomPieceBound(command.durationFrames, frameRate, layers) > ROOM.maxPieces) throw new Error(`A room this long takes more than the ${ROOM.maxPieces} pieces one command lays; lay it in parts`);
  const windows = command.sources.map(source => {
    const window = roomSourceWindow(source, source.outSec!);
    if (!window.ok) throw new Error(window.reason);
    return window;
  });
  const steps: TimelineClipCommand[] = [], level = new Map<string, number>();
  command.trackIds.forEach((id, index) => {
    const track = tracks.find(row => row.id === id);
    if (track === undefined) {
      steps.push({ kind: "add-track", trackId: id, trackKind: "ambience", name: `Room ${index + 1}` }, { kind: "set-track", trackId: id, ducks: false });
      level.set(id, 0);
    } else if (!SOUND_TRACK_KINDS.has(track.kind)) throw new Error(`${track.name ?? id} is not an audio track, and a room is sound`);
    else level.set(id, track.levelDb ?? 0);
  });
  const loudness = roomLayerLufs(command.lufs, layers);
  const pieces = roomPieces({ sources: windows, durationFrames: command.durationFrames, frameRate, layers, seed: command.seed! });
  if (pieces.length === 0) throw new Error("None of the room's beds is long enough to cut a piece from");
  pieces.forEach((piece, index) => {
    const source = command.sources[piece.source]!, track = command.trackIds[piece.layer * 2 + piece.row]!;
    const gainDb = Math.round((loudness[piece.layer]! - source.measuredLufs! - level.get(track)!) * 10) / 10;
    // Said, not clamped: a bed left short of the room's level is found by ear, a piece at a time.
    if (gainDb > 12 || gainDb < -60) throw new Error(`${source.label} measures ${source.measuredLufs} LUFS: a room at ${command.lufs} LUFS would take a gain of ${gainDb > 0 ? "+" : ""}${gainDb} dB, and a clip's gain is -60 to +12`);
    steps.push({ kind: "place", trackId: track, clip: { id: `${command.clipId}-${index + 1}` as TimelineClipId, startFrame: command.startFrame + piece.startFrame, durationFrames: piece.durationFrames,
      sourceInFrames: piece.sourceInFrames, source: { kind: "artifact", artifactId: source.artifactId, label: source.label }, gainDb, role: "ambience",
      soundFade: { inFrames: cross, outFrames: cross, power: true } } });
  });
  return steps;
}
