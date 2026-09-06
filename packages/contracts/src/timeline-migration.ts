import type { ProductionBundle } from "./client-state.js";
import { resolveProductionArtifact } from "./artifact.js";
import type { AudioTrack, CutOverlay } from "./cut.js";
import {
  AUDIO_TRACK_KINDS,
  basePictureTrack,
  orderedTrackClips,
  secondsToFrames,
  type ProductionTimeline,
  type TimelineClip,
  type TimelineClipId,
  type TimelineTrack,
  type TimelineTrackId,
  type TimelineTrackKind,
} from "./timeline.js";
import type { FrameRate } from "./world.js";

/**
 * Folding `cut.json` into typed tracks (SPEC-037 R-30, R-31; SPEC-038 R-12, R-20; issue #681).
 *
 * The legacy file holds two things: placements on numbered, untyped lanes, and three named
 * audio tracks nothing shipped a writer for. Both become tracks with stable ids so the render
 * plan reads one record. Nothing is lost on the way: a lane keeps its stacking order as a Picture
 * track above the story's, a video's `keep | mute` rides on its clip, a split's sound half becomes
 * an audio clip linked back to its picture, `score` is spelled Music, and a dialogue entry keeps
 * the speaking sheet and the version its voice was assigned at.
 *
 * Rounding is to the nearest frame with a one-frame minimum (R-31). Time is otherwise exact:
 * migration happens once, at the boundary, and the frame grid is the timeline's own clock.
 */

export interface MigrationArtifact {
  id: string;
  file: string;
  kind: string;
  production?: string | null;
  mediaInfo?: { hasAudio: boolean; durationSec?: number };
}

const DEFAULT_BED_SEC = 30;
const DEFAULT_LINE_SEC = 4;

function frames(seconds: number, frameRate: FrameRate): number {
  return secondsToFrames(Math.max(0, seconds), frameRate);
}

function windowFrames(startSec: number, endSec: number, frameRate: FrameRate): { startFrame: number; durationFrames: number } {
  const startFrame = frames(startSec, frameRate);
  return { startFrame, durationFrames: Math.max(1, frames(endSec, frameRate) - startFrame) };
}

/** A stable clip id from the placement's own id, so a migrated clip can be found again. */
function clipIdFor(overlayId: string): TimelineClipId {
  return `cl_${overlayId.replace(/^ov_/, "ov-")}`;
}

/**
 * Lay clips onto tracks that never overlap, in play order, keeping the legacy stacking. A lane
 * let two placements share seconds and drew the later-starting one on top; a typed track refuses
 * the overlap, so a clip steps to the track above everything it overlaps. First-fit packing
 * would use fewer tracks and could put an earlier placement above a later one it never covered
 * before — a migration that quietly changed the picture (round four).
 */
function packWithoutOverlap(clips: readonly TimelineClip[]): TimelineClip[][] {
  const lanes: TimelineClip[][] = [];
  const placed: Array<{ clip: TimelineClip; lane: number }> = [];
  for (const clip of orderedTrackClips({ clips: [...clips] })) {
    const end = clip.startFrame + clip.durationFrames;
    const under = placed.filter((item) => item.clip.startFrame < end && item.clip.startFrame + item.clip.durationFrames > clip.startFrame);
    const lane = under.length === 0 ? 0 : Math.max(...under.map((item) => item.lane)) + 1;
    (lanes[lane] ??= []).push(clip);
    placed.push({ clip, lane });
  }
  return lanes;
}

function nextOrder(tracks: readonly TimelineTrack[]): number {
  return tracks.reduce((high, track) => Math.max(high, track.order + 1), 0);
}

function track(
  id: TimelineTrackId,
  kind: TimelineTrackKind,
  name: string,
  order: number,
  clips: TimelineClip[],
): TimelineTrack {
  return { id, kind, name, order, muted: false, ...(AUDIO_TRACK_KINDS.has(kind) ? { solo: false } : {}), clips };
}

export interface MigrationResult {
  timeline: ProductionTimeline;
  /** Placements and entries that could not be carried, named. Empty when nothing was lost. */
  dropped: string[];
}

/**
 * The typed tracks a legacy cut becomes. Pure: the caller decides whether to write the result,
 * and writes it whole. A timeline already marked migrated comes back untouched.
 */
export function migrateLegacyCut(
  timeline: ProductionTimeline,
  production: ProductionBundle,
  // Pass the whole world catalog, including scoped artifacts, for accurate dropped reasons.
  artifacts: readonly MigrationArtifact[],
): MigrationResult {
  if (timeline.migratedCut === true) return { timeline, dropped: [] };
  const frameRate = timeline.frameRate;
  const dropped: string[] = [];
  const tracks: TimelineTrack[] = [...timeline.tracks];
  const existingIds = new Set(tracks.flatMap((candidate) => candidate.clips.map((clip) => clip.id)));

  // ---- Lanes: picture above the story, sound beside it ---------------------------------------
  const byLane = new Map<number, CutOverlay[]>();
  for (const overlay of production.cut.overlays) {
    const lane = overlay.lane ?? 0;
    byLane.set(lane, [...(byLane.get(lane) ?? []), overlay]);
  }
  const soundHalves = new Map<string, TimelineClipId>();
  for (const [lane, overlays] of [...byLane].sort((a, b) => a[0] - b[0])) {
    const picture: TimelineClip[] = [];
    const sound: TimelineClip[] = [];
    for (const overlay of [...overlays].sort((a, b) => a.startSec - b.startSec)) {
      const resolved = resolveProductionArtifact(artifacts, overlay.artifactId, production.meta.id);
      if (!resolved.ok) {
        dropped.push(`${overlay.id} cites ${resolved.reason}`);
        continue;
      }
      const artifact = resolved.artifact;
      const id = clipIdFor(overlay.id);
      if (existingIds.has(id)) {
        dropped.push(`${overlay.id} is already on the timeline as ${id}`);
        continue;
      }
      existingIds.add(id);
      const window = windowFrames(overlay.startSec, overlay.endSec, frameRate);
      const label = artifact.file.split("/").pop() ?? artifact.file;
      const mode = overlay.audio ?? "keep";
      const isPicture = artifact.kind === "image" || artifact.kind === "board" || artifact.kind === "video";
      if (artifact.kind === "audio" || mode === "only") {
        if (artifact.kind !== "audio" && !(artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true)) {
          dropped.push(`${overlay.id} is a sound placement of ${label}, which is not known to carry sound`);
          continue;
        }
        sound.push({ id, ...window, sourceInFrames: 0, source: { kind: "artifact", artifactId: artifact.id, label }, gainDb: 0 });
        soundHalves.set(`${artifact.id}:${overlay.startSec}:${overlay.endSec}`, id);
        continue;
      }
      if (!isPicture) {
        dropped.push(`${overlay.id} places ${label}, which is ${artifact.kind} and has neither picture nor sound`);
        continue;
      }
      picture.push({
        id,
        ...window,
        sourceInFrames: 0,
        source: { kind: "artifact", artifactId: artifact.id, label },
        ...(artifact.kind === "video" ? { audio: mode === "mute" ? "mute" : "keep" } : {}),
      });
    }
    packWithoutOverlap(picture).forEach((clips, index) => {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      tracks.push(track(`tr_lane-${lane}${suffix}`, "picture", `Overlay L${lane}${suffix}`, nextOrder(tracks), clips));
    });
    packWithoutOverlap(sound).forEach((clips, index) => {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      tracks.push(track(`tr_lane-${lane}-sound${suffix}`, "ambience", `Overlay L${lane} sound${suffix}`, nextOrder(tracks), clips));
    });
  }
  // A split's two halves stay linked: the muted picture and the sound over the same file and window.
  for (const candidate of tracks) {
    if (candidate.kind !== "picture") continue;
    candidate.clips = candidate.clips.map((clip) => {
      if (clip.audio !== "mute" || clip.source.kind !== "artifact") return clip;
      const overlay = production.cut.overlays.find((placement) => clipIdFor(placement.id) === clip.id);
      const twin = overlay === undefined ? undefined : soundHalves.get(`${overlay.artifactId}:${overlay.startSec}:${overlay.endSec}`);
      if (twin === undefined) return clip;
      for (const soundTrack of tracks) {
        soundTrack.clips = soundTrack.clips.map((other) => (other.id === twin ? { ...other, linkedClipId: clip.id } : other));
      }
      return { ...clip, linkedClipId: twin };
    });
  }

  // ---- Named audio tracks: dialogue, score (Music) and ambience -------------------------------
  const base = basePictureTrack(timeline);
  const shotStartFrame = (shotId: string): number | null => {
    const clip = base === null ? undefined : orderedTrackClips(base).find((candidate) => candidate.source.kind === "shot" && candidate.source.shotId === shotId);
    return clip === undefined ? null : clip.startFrame;
  };
  const takesById = new Map(production.takes.map((take) => [take.id, take] as const));
  const kindFor = (legacy: AudioTrack["kind"]): TimelineTrackKind => (legacy === "score" ? "music" : legacy);
  const nameFor = (legacy: AudioTrack["kind"]): string => (legacy === "score" ? "Music" : legacy === "dialogue" ? "Dialogue" : "Ambience");
  production.cut.audio.forEach((legacy, trackIndex) => {
    const clips: TimelineClip[] = [];
    legacy.entries.forEach((entry, entryIndex) => {
      const anchored = entry.shotId === undefined ? 0 : shotStartFrame(entry.shotId);
      if (anchored === null) {
        dropped.push(`${legacy.label} entry ${entryIndex + 1} is placed against shot ${entry.shotId}, which is not in the cut`);
        return;
      }
      const startFrame = anchored + frames(entry.offsetSec, frameRate);
      const id: TimelineClipId = `cl_audio-${trackIndex}-${entryIndex}`;
      if (entry.takeId !== undefined) {
        const take = takesById.get(entry.takeId);
        // A pass segment has no media of its own: it is a window onto its pass (SPEC-013 R-3).
        // The clip cites the pass and carries the window as its in-point and length, which is
        // how the legacy renderer played it (round six).
        const segment = take?.segment;
        const source = segment === undefined ? take : takesById.get(segment.passTakeId);
        if (take === undefined || source?.media === undefined || (segment !== undefined && segment.outSec <= segment.inSec)) {
          dropped.push(`${legacy.label} entry ${entryIndex + 1} cites take ${entry.takeId}, which has no media`);
          return;
        }
        const measured = segment !== undefined ? segment.outSec - segment.inSec : production.takeMediaInfo[take.id]?.mediaInfo.durationSec;
        clips.push({
          id,
          startFrame,
          durationFrames: Math.max(1, frames(measured ?? DEFAULT_LINE_SEC, frameRate)),
          sourceInFrames: segment === undefined ? 0 : frames(segment.inSec, frameRate),
          source: {
            kind: "take",
            takeId: source.id,
            label: entry.note ?? `${nameFor(legacy.kind)} line`,
            ...(entry.sheetId !== undefined ? { sheetId: entry.sheetId } : {}),
            ...(entry.voiceAssignedAtVersion !== undefined ? { voiceAssignedAtVersion: entry.voiceAssignedAtVersion } : {}),
          },
          gainDb: 0,
        });
        return;
      }
      if (entry.artifactId !== undefined) {
        const resolved = resolveProductionArtifact(artifacts, entry.artifactId, production.meta.id);
        if (!resolved.ok) {
          dropped.push(`${legacy.label} entry ${entryIndex + 1} cites ${resolved.reason}`);
          return;
        }
        const artifact = resolved.artifact;
        // The legacy schema let a bed cite anything; a typed audio track refuses a source with
        // no sound, so the entry is named here rather than saved and refused by every render.
        if (!(artifact.kind === "audio" || (artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true))) {
          dropped.push(`${legacy.label} entry ${entryIndex + 1} cites ${artifact.file}, which is not known to carry sound`);
          return;
        }
        clips.push({
          id,
          startFrame,
          durationFrames: Math.max(1, frames(artifact.mediaInfo?.durationSec ?? DEFAULT_BED_SEC, frameRate)),
          sourceInFrames: 0,
          source: { kind: "artifact", artifactId: artifact.id, label: artifact.file.split("/").pop() ?? artifact.file },
          gainDb: 0,
        });
        return;
      }
      dropped.push(`${legacy.label} entry ${entryIndex + 1} names neither a take nor an artifact`);
    });
    packWithoutOverlap(clips).forEach((laneClips, index) => {
      const suffix = index === 0 ? "" : `-${index + 1}`;
      tracks.push(track(`tr_audio-${trackIndex}${suffix}`, kindFor(legacy.kind), `${legacy.label}${suffix}`, nextOrder(tracks), laneClips));
    });
  });

  // What the fold placed is in the Library too (SPEC-039 R-8): a person looking for the file
  // that plays on a lane finds it where the target keeps it, not only on the lane.
  const inLibrary = new Set(timeline.library.map((item) => (item.kind === "shot" ? `shot:${item.shotId}` : `artifact:${item.artifactId}`)));
  const library = [...timeline.library];
  for (const candidate of tracks) {
    for (const clip of candidate.clips) {
      if (clip.source.kind !== "artifact" || inLibrary.has(`artifact:${clip.source.artifactId}`)) continue;
      inLibrary.add(`artifact:${clip.source.artifactId}`);
      library.push({ kind: "artifact", artifactId: clip.source.artifactId });
    }
  }
  return { timeline: { ...timeline, tracks, library, migratedCut: true }, dropped };
}
