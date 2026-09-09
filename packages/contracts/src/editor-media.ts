import { z } from "zod";
import { ArtifactIdSchema } from "./ids.js";
import { ArtifactKindSchema, type ArtifactSidecar } from "./artifact.js";
import {
  AUDIO_TRACK_KINDS, PICTURE_TRACK_ID, TimelineOperationRefused, applyTimelineCommands,
  basePictureTrack, newAudioTrack, secondsToFrames, trackEndFrame,
  type ProductionTimeline, type TimelineClipCommand, type TimelineClipId, type TimelineTrackId,
} from "./timeline.js";

/**
 * Where an import lands (SPEC-043 R-1, R-3; issue 1035).
 *
 * `library` files and lists; `append` runs picture on after the last Picture clip and sound on
 * after the last clip of the first audio track; a bare frame is a drop on the base Picture track.
 * A named lane is a drop on a lane the timeline already has, and `newTrack` is a drop on the
 * strip under the last lane, which makes a lane of each file's own kind. The two object forms
 * exist because a desktop file dropped on `Overlay 1` used to be imported somewhere else
 * entirely — the drop bubbled to the screen and appended — while the lane it was dropped on said
 * "picture lanes take picture" about a file nobody had read.
 */
export type MediaDestination =
  | "library"
  | "append"
  | number
  | { trackId: TimelineTrackId; frame: number }
  | { newTrack: true; frame: number };

const STILL_KINDS = new Set<ArtifactSidecar["kind"]>(["image", "board"]);
const PLAYABLE_KINDS = new Set<ArtifactSidecar["kind"]>(["video", "audio", "image", "board"]);

/** Whether a filed artifact can sit on a lane of this kind; the reason it cannot, in plain words. */
export function laneRefusal(artifact: ArtifactSidecar, sound: boolean): string | null {
  if (sound) {
    if (artifact.kind === "audio") return null;
    if (artifact.kind === "video" && artifact.mediaInfo?.hasAudio === true) return null;
    return artifact.kind === "video" ? "has no measured sound" : "has no sound";
  }
  if (STILL_KINDS.has(artifact.kind) || artifact.kind === "video") return null;
  return "has no picture";
}

/** The next free overlay lane id, numbered the way the editor numbers them. */
export function nextOverlayTrack(timeline: Pick<ProductionTimeline, "tracks">): { trackId: TimelineTrackId; name: string } {
  let number = 1;
  while (timeline.tracks.some((track) => track.id === `tr_overlay-${number}`)) number += 1;
  return { trackId: `tr_overlay-${number}` as TimelineTrackId, name: `Overlay ${number}` };
}

export function mediaPlacementCommands(
  timeline: ProductionTimeline, artifacts: readonly ArtifactSidecar[], destination: MediaDestination,
  mint: () => TimelineClipId,
): TimelineClipCommand[] {
  const commands: TimelineClipCommand[] = [];
  let current = timeline;
  const picture = basePictureTrack(timeline);
  const onLane = typeof destination === "object";
  let cursor = typeof destination === "number" ? destination : onLane ? destination.frame : trackEndFrame(picture ?? { clips: [] });
  /*
   * A lane made by this batch is made once: three sound files dropped on the strip land end to
   * end on one new lane rather than each opening a lane of its own, which is what dropping them
   * together meant.
   */
  let madeSound: TimelineTrackId | null = null;
  let madePicture: TimelineTrackId | null = null;
  const laneTrack = onLane && "trackId" in destination ? current.tracks.find((track) => track.id === destination.trackId) : undefined;
  if (onLane && "trackId" in destination && laneTrack === undefined) {
    throw new TimelineOperationRefused("that lane is no longer on the timeline");
  }
  for (const artifact of artifacts) {
    if (!PLAYABLE_KINDS.has(artifact.kind)) throw new TimelineOperationRefused(`${artifact.file} has no playable picture or sound`);
    if (typeof destination === "number" && artifact.kind === "audio") throw new TimelineOperationRefused(`${artifact.file} has no picture; import it to the Library or use Import media to add an audio track`);
    const batch: TimelineClipCommand[] = current.library.some(item => item.kind === "artifact" && item.artifactId === artifact.id)
      ? [] : [{ kind: "add-to-library", items: [{ kind: "artifact", artifactId: artifact.id }] }];
    if (destination !== "library") {
      const still = STILL_KINDS.has(artifact.kind);
      const seconds = still ? 4 : artifact.mediaInfo?.durationSec;
      if (seconds === undefined || seconds <= 0) throw new TimelineOperationRefused(`${artifact.file} needs a measured duration before placement; add it from the Library after measuring`);
      const durationFrames = Math.max(1, secondsToFrames(seconds, timeline.frameRate));
      let trackId: TimelineTrackId = picture?.id ?? PICTURE_TRACK_ID;
      let startFrame = cursor;
      // On a lane the lane decides what the file is placed as: a video dropped on a sound lane is
      // its sound. Elsewhere the file's own kind decides.
      let sound = artifact.kind === "audio";
      if (laneTrack !== undefined) {
        sound = AUDIO_TRACK_KINDS.has(laneTrack.kind);
        const refusal = laneRefusal(artifact, sound);
        if (refusal !== null) throw new TimelineOperationRefused(`${artifact.file} ${refusal}; ${laneTrack.name} takes ${sound ? "sound" : "picture"}`);
        trackId = laneTrack.id;
      } else if (onLane) {
        if (sound) {
          if (madeSound === null) { const added = newAudioTrack(current); batch.push(added); madeSound = added.trackId; }
          trackId = madeSound;
        } else {
          if (madePicture === null) {
            const overlay = nextOverlayTrack(current);
            batch.push({ kind: "add-track", trackId: overlay.trackId, trackKind: "picture", name: overlay.name });
            madePicture = overlay.trackId;
          }
          trackId = madePicture;
        }
      } else if (sound) {
        const audioTrack = current.tracks.find(track => track.kind === "audio");
        if (audioTrack) {
          trackId = audioTrack.id;
          startFrame = trackEndFrame(audioTrack);
        } else {
          const added = newAudioTrack(current);
          batch.push(added); trackId = added.trackId; startFrame = 0;
        }
      }
      batch.push({ kind: "place", trackId, clip: {
        id: mint(), startFrame, durationFrames, sourceInFrames: 0,
        source: { kind: "artifact", artifactId: artifact.id, label: artifact.file.split("/").pop() ?? artifact.file },
        ...(sound ? { gainDb: 0 } : artifact.kind === "video" ? { audio: "keep" as const } : {}),
      } });
      // Append and a bare frame chain picture only; a lane chains whatever lands on it, so a
      // handful of files dropped together read in the order they were dropped.
      if (onLane || !sound) cursor += durationFrames;
    }
    if (!batch.length) continue;
    current = applyTimelineCommands(current, batch);
    commands.push(...batch);
  }
  return commands;
}

/**
 * A file another world offers the Library (issue 1033): what a row needs and nothing a renderer
 * should hold. `picture` is world-relative to the source world — its own file for a still, its
 * poster for a video when one has been drawn — and is served under that world's slug.
 */
export const BorrowableArtifactSchema = z.object({
  id: ArtifactIdSchema,
  kind: ArtifactKindSchema,
  /** Filename within the source world's `artifacts/`; the borrow names it by this. */
  file: z.string().min(1),
  /** The name the Artifacts page gives it there (issue 1005). */
  name: z.string().min(1),
  durationSec: z.number().positive().optional(),
  picture: z.string().nullable(),
}).strict();
export type BorrowableArtifact = z.infer<typeof BorrowableArtifactSchema>;
