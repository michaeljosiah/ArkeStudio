import type { ArtifactSidecar } from "./artifact.js";
import {
  PICTURE_TRACK_ID, TimelineOperationRefused, applyTimelineCommands,
  basePictureTrack, newAudioTrack, secondsToFrames, trackEndFrame,
  type ProductionTimeline, type TimelineClipCommand, type TimelineClipId, type TimelineTrackId,
} from "./timeline.js";

export function mediaPlacementCommands(
  timeline: ProductionTimeline, artifacts: readonly ArtifactSidecar[], destination: "library" | "append" | number,
  mint: () => TimelineClipId,
): TimelineClipCommand[] {
  const commands: TimelineClipCommand[] = [];
  let current = timeline;
  let cursor = typeof destination === "number" ? destination : trackEndFrame(basePictureTrack(timeline) ?? { clips: [] });
  for (const artifact of artifacts) {
    if (!["video", "audio", "image", "board"].includes(artifact.kind)) throw new TimelineOperationRefused(`${artifact.file} has no playable picture or sound`);
    const batch: TimelineClipCommand[] = current.library.some(item => item.kind === "artifact" && item.artifactId === artifact.id)
      ? [] : [{ kind: "add-to-library", items: [{ kind: "artifact", artifactId: artifact.id }] }];
    if (destination !== "library") {
      const still = artifact.kind === "image" || artifact.kind === "board";
      const seconds = still ? 4 : artifact.mediaInfo?.durationSec;
      if (seconds === undefined || seconds <= 0) throw new TimelineOperationRefused(`${artifact.file} needs a measured duration before placement; add it from the Library after measuring`);
      const durationFrames = Math.max(1, secondsToFrames(seconds, timeline.frameRate));
      const sound = artifact.kind === "audio";
      const audioTrack = sound ? current.tracks.find(track => track.kind === "audio") : undefined;
      let trackId: TimelineTrackId = PICTURE_TRACK_ID;
      let startFrame = cursor;
      if (sound) {
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
      if (!sound) cursor += durationFrames;
    }
    if (!batch.length) continue;
    current = applyTimelineCommands(current, batch);
    commands.push(...batch);
  }
  return commands;
}
