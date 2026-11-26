import type { ArtifactSidecar } from "./artifact.js";
import type { ProductionBundle } from "./client-state.js";
import { audibleTracks } from "./render-plan.js";
import { orderedShots, type SceneRecord } from "./scene-flow.js";
import type { Shot } from "./scene.js";
import {
  AUDIO_TRACK_KINDS, basePictureTrack, effectiveAudioRole, orderedTrackClips, sourceLengthFramesFor,
  type ProductionTimeline, type TimelineClip,
} from "./timeline.js";

/**
 * What is read of a cut before anyone is shown it (design turns 287 and 288d): the third of the
 * director's lists, after the shot's and the take's. Gold on Gold's scene was cut outside the
 * Studio and shown with three lines playing over other shots while their own shots' mouths moved
 * in silence, a six-second crowd looped under two minutes of it so the same laugh came round, and
 * two shots of one man from one camera position back to back that read as a zoom. The owner found
 * each by watching. Each is in the cut's own record, so each is read here.
 *
 * Only what the saved timeline and the scene say is here: nothing is decoded. What needs the
 * film's sound and picture (the words heard in each shot, the lips under a laid line, the room's
 * level from shot to shot) is the measured pass over an export. An item with nothing to read is
 * left out, never passed, as the shot's list leaves its own out.
 */
export const CUT_CHECKS = ["lines", "room", "set-ups"] as const;
export type CutCheckId = typeof CUT_CHECKS[number];

export const CUT_CHECK_NAMES: Readonly<Record<CutCheckId, string>> = { lines: "Lines", room: "Room tone", "set-ups": "Set-ups" };

export interface CutCheck {
  id: CutCheckId;
  result: "pass" | "fix";
  says: string;
  /** The clips a fix is about, the first to look at first. */
  clipIds?: readonly string[];
}

export interface CutChecksInput {
  production: ProductionBundle;
  timeline: ProductionTimeline;
  /** The shelf: a file placed in the cut is tied to a shot only by its links, and bounded by its length. */
  artifacts?: ReadonlyArray<Pick<ArtifactSidecar, "id" | "links"> & { mediaInfo?: { durationSec: number } }>;
}

/** A line may sit this far outside its own shot's picture in a film cut straight before it is one that has slipped. */
const STRAIGHT_CUT_SLACK_SEC = .5;
/** A hole in a room shorter than this is a join between two pieces of it, not a silence. */
const SHORTEST_GAP_SEC = .25;
/** Two uses of one sound sharing this much of it are the same moment heard twice. */
const REPEAT_SEC = 1;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const short = (text: string, most = 28) => (text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text);
const more = (count: number) => (count > 1 ? ` · ${count - 1} more` : "");

/** The cut's checks, or none when the cut cannot be read (a flow that will not order, a record half written). */
export function cutChecks(input: CutChecksInput): CutCheck[] {
  try { return read(input); } catch { return []; }
}

function read({ production, timeline, artifacts = [] }: CutChecksInput): CutCheck[] {
  const rate = timeline.frameRate, base = basePictureTrack(timeline);
  if (base === null) return [];
  const story = new Map<string, { scene: SceneRecord; shot: Shot; at: number }>();
  for (const scene of production.scenes) {
    let shots: Shot[];
    try { shots = orderedShots(scene); } catch { continue; }
    shots.forEach((shot, at) => story.set(shot.id, { scene, shot, at }));
  }
  const takes = new Map(production.takes.map((take) => [take.id as string, take]));
  const numberOf = (shotId: string) => story.get(shotId)!.shot.number;
  /** The story shots a clip's source is of: its own, its take's, or the ones a shelf file is linked to. */
  const shotsOf = (clip: TimelineClip): string[] => {
    const source = clip.source;
    if (source.kind === "shot" || source.kind === "performance") return story.has(source.shotId) ? [source.shotId] : [];
    if (source.kind === "take") return (takes.get(source.takeId)?.coversShots ?? []).filter((id) => story.has(id));
    if (source.kind === "artifact") return (artifacts.find((artifact) => artifact.id === source.artifactId)?.links ?? []).filter((id) => story.has(id));
    return [];
  };
  const picture = orderedTrackClips(base).map((clip) => {
    const shots = shotsOf(clip);
    return { clip, start: clip.startFrame, end: clip.startFrame + clip.durationFrames, shotId: shots.length === 1 ? shots[0]! : null };
  });
  // A cut with no story shot under it (a music video of placed clips, a reel of files) has no shots to hold anything to.
  if (!picture.some((entry) => entry.shotId !== null)) return [];
  const sound = audibleTracks(timeline).filter((track) => AUDIO_TRACK_KINDS.has(track.kind)).flatMap((track) => track.clips.map((clip) => (
    { clip, role: effectiveAudioRole(track, clip), start: clip.startFrame, end: clip.startFrame + clip.durationFrames })));
  const look = production.meta.look, items: CutCheck[] = [];
  /**
   * What a clip plays, on its file's own clock, as the render resolves it: the pass a segment is a
   * range of, and where in it the clip starts once the segment's in-point, a placed take's offset
   * or a shot's chosen trim, and the clip's own are added. Two clips are the same sound, or one
   * stretch of picture played on, only when they agree here; by take id and clip in-point alone,
   * two halves of one take read as a repeat and two segments replaying one stretch of a pass did not.
   */
  const sourceAt = (clip: TimelineClip): { key: string; fromSec: number } | null => {
    const source = clip.source;
    if (source.kind === "artifact") return { key: `artifact:${source.artifactId}`, fromSec: clip.sourceInFrames / rate };
    if (source.kind !== "take" && source.kind !== "shot") return null;
    const take = takes.get(source.kind === "take" ? source.takeId : production.selections[source.shotId]?.acceptedTakeId ?? "");
    if (!take) return null;
    const own = source.kind === "take" ? source.offsetSec ?? 0 : production.selections[source.shotId]?.trimInSec ?? 0;
    return { key: `take:${take.segment?.passTakeId ?? take.id}`, fromSec: (take.segment?.inSec ?? 0) + own + clip.sourceInFrames / rate };
  };

  /*
   * Lines. A line belongs under the picture of the shot it was made for. One lying wholly under
   * another shot's picture has lost its place: that is how a film was shown with a line over the
   * wrong face. Running over the next shot, or starting under the one before, is a split cut and
   * a choice, unless the look says the film is cut straight. A line tied to no shot cannot be
   * placed against anything, and says so rather than passing. A line under no picture at all plays
   * over black; under a title or a placed file alone it is not judged, and is not counted as
   * under its shot either.
   */
  const lines = sound.filter((entry) => entry.role === "dialogue");
  if (lines.length > 0) {
    const astray: Array<{ clipId: string; says: string }> = [], untied: string[] = [];
    const slack = look?.cutting?.splitCuts === false ? Math.round(STRAIGHT_CUT_SLACK_SEC * rate) : null;
    let placed = 0;
    for (const line of lines) {
      const own = shotsOf(line.clip);
      if (own.length === 0) { untied.push(line.clip.id); continue; }
      const under = picture.filter((entry) => entry.start < line.end && entry.end > line.start);
      const onOwn = under.filter((entry) => entry.shotId !== null && own.includes(entry.shotId));
      const other = under.find((entry) => entry.shotId !== null && !own.includes(entry.shotId));
      if (onOwn.length === 0) {
        if (other) astray.push({ clipId: line.clip.id, says: `shot ${numberOf(own[0]!)}'s under shot ${numberOf(other.shotId!)}` });
        else if (under.length === 0) astray.push({ clipId: line.clip.id, says: `shot ${numberOf(own[0]!)}'s under no picture` });
        continue;
      }
      const from = Math.min(...onOwn.map((entry) => entry.start)), to = Math.max(...onOwn.map((entry) => entry.end));
      if (slack !== null && (from - line.start > slack || line.end - to > slack)) astray.push({ clipId: line.clip.id, says: `shot ${numberOf(own[0]!)}'s runs past its shot` });
      else placed++;
    }
    if (astray.length > 0) items.push({ id: "lines", result: "fix", says: `${astray[0]!.says}${more(astray.length)}`, clipIds: astray.map((line) => line.clipId) });
    else if (untied.length > 0) items.push({ id: "lines", result: "fix", says: `${untied.length} tied to no shot`, clipIds: untied });
    else if (placed > 0) items.push({ id: "lines", result: "pass", says: `${placed} under their shots` });
  }

  /*
   * Room tone. A scene that has a room has it throughout: a gap is the room dropping out under
   * the talk. And no stretch of a sound is used twice: a room looped under a scene brings its
   * laugh and its glass back on the same beat, and the ear finds it within a minute. A clip
   * sounds only as far as its file runs, however long it was drawn.
   */
  const beds = sound.filter((entry) => entry.role === "ambience");
  if (beds.length > 0) {
    const lengthOf = sourceLengthFramesFor(production, artifacts);
    const sounding = beds.map((bed) => {
      const total = lengthOf(bed.clip);
      return { ...bed, end: total === undefined ? bed.end : Math.min(bed.end, bed.start + Math.max(0, total - bed.clip.sourceInFrames)) };
    }).filter((bed) => bed.end > bed.start);
    const gaps: Array<{ at: number; frames: number }> = [];
    if (look?.sound?.roomTonePerPlace !== false) {
      const scenes = new Map<string, Array<{ start: number; end: number }>>();
      for (const entry of picture) {
        if (entry.shotId === null) continue;
        const id = story.get(entry.shotId)!.scene.id;
        scenes.set(id, [...(scenes.get(id) ?? []), { start: entry.start, end: entry.end }]);
      }
      for (const shots of scenes.values()) {
        // A scene cut with no room at all is a choice; one with a room is held to it. Asked of the
        // beds as they were drawn: one whose file ran out before the scene began was still meant for it.
        if (!shots.some((window) => beds.some((bed) => bed.start < window.end && bed.end > window.start))) continue;
        // Shots that touch are one stretch of the scene: a silence across a cut is one gap, not one a shot.
        const windows: Array<{ start: number; end: number }> = [];
        for (const shot of [...shots].sort((a, b) => a.start - b.start)) {
          const last = windows[windows.length - 1];
          if (last && shot.start <= last.end) last.end = Math.max(last.end, shot.end); else windows.push({ ...shot });
        }
        for (const window of windows) {
          let at = window.start;
          for (const bed of sounding.filter((candidate) => candidate.start < window.end && candidate.end > window.start).sort((a, b) => a.start - b.start)) {
            if (bed.start - at >= SHORTEST_GAP_SEC * rate) gaps.push({ at, frames: bed.start - at });
            at = Math.max(at, bed.end);
          }
          if (window.end - at >= SHORTEST_GAP_SEC * rate) gaps.push({ at, frames: window.end - at });
        }
      }
    }
    const uses = new Map<string, Array<{ from: number; to: number; clip: TimelineClip }>>();
    for (const bed of sounding) {
      const played = sourceAt(bed.clip);
      if (played === null) continue;
      const from = Math.round(played.fromSec * rate);
      uses.set(played.key, [...(uses.get(played.key) ?? []), { from, to: from + (bed.end - bed.start), clip: bed.clip }]);
    }
    const repeated = [...uses.values()].map((ranges) => {
      const sorted = [...ranges].sort((a, b) => a.from - b.from);
      let reach = sorted[0]!.to; const again: TimelineClip[] = [];
      for (const range of sorted.slice(1)) {
        if (Math.min(reach, range.to) - range.from >= REPEAT_SEC * rate) again.push(range.clip);
        reach = Math.max(reach, range.to);
      }
      return { first: sorted[0]!.clip, again };
    }).filter((source) => source.again.length > 0);
    gaps.sort((a, b) => a.at - b.at);
    items.push(repeated.length > 0 ? { id: "room", result: "fix", says: `${short(repeated[0]!.first.source.label)} used ${repeated[0]!.again.length + 1} times${more(repeated.length)}`,
        clipIds: repeated.flatMap((source) => source.again.map((clip) => clip.id)) }
      : gaps.length > 0 ? { id: "room", result: "fix", says: `gap at ${clock(gaps[0]!.at / rate)} · ${(gaps[0]!.frames / rate).toFixed(1)} s${more(gaps.length)}` }
      : { id: "room", result: "pass", says: "no gap, none repeated" });
  }

  /*
   * Set-ups. Two shots in a row from one camera position read as a jump, or as a zoom when the
   * second is only tighter: the eye sees the same picture change size. Read from the positions
   * the shots were staged from on their place's plan. Not held against a film cut to a song,
   * where a jump is the style; nor a shot written to carry on from the one before it; nor two
   * ranges of one clip played straight on, which have no cut between them to jump.
   */
  if (production.spine === null && look?.preset !== "music-video") {
    const twice: Array<{ clipId: string; says: string }> = [];
    let judged = 0;
    for (let i = 1; i < picture.length; i++) {
      const before = picture[i - 1]!, after = picture[i]!;
      if (before.end !== after.start || before.shotId === null || after.shotId === null || before.shotId === after.shotId) continue;
      const out = story.get(before.shotId)!, into = story.get(after.shotId)!;
      const from = out.shot.staging?.position, to = into.shot.staging?.position;
      if (out.scene.id !== into.scene.id || from === undefined || to === undefined) continue;
      judged++;
      if (from !== to) continue;
      if (into.at === out.at + 1 && (into.shot.continuity?.openOnPrevious === true || into.shot.continuity?.continuesPrevious === true)) continue;
      const a = sourceAt(before.clip), b = sourceAt(after.clip);
      if (a !== null && b !== null && a.key === b.key && Math.abs(a.fromSec + before.clip.durationFrames / rate - b.fromSec) <= 2 / rate) continue;
      twice.push({ clipId: after.clip.id, says: `shots ${out.shot.number}, ${into.shot.number}` });
    }
    if (judged > 0) {
      items.push(twice.length > 0 ? { id: "set-ups", result: "fix", says: `${twice[0]!.says}${more(twice.length)}`, clipIds: twice.map((pair) => pair.clipId) }
        : { id: "set-ups", result: "pass", says: "none twice running" });
    }
  }
  return items;
}

/** The count beside Export: how many passed, of how many, and how many to fix. */
export function cutChecksCount(items: readonly CutCheck[]): { passed: number; of: number; toFix: number } {
  const passed = items.filter((item) => item.result === "pass").length;
  return { passed, of: items.length, toFix: items.length - passed };
}
