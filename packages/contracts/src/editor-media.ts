import type { ArtifactSidecar } from "./artifact.js";
import type { ProductionBundle } from "./client-state.js";
import {
  PICTURE_TRACK_ID, TimelineOperationRefused, applyTimelineCommands,
  basePictureTrack, newAudioTrack, placementAudioRole, resolvePictureTimeline, secondsToFrames, trackEndFrame,
  type ProductionTimeline, type TimelineClip, type TimelineClipCommand, type TimelineClipId, type TimelineTrackId,
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

/** Detachment freezes embedded sound only; external performances and master bindings stay put. */
export function detachAudioCommands(production: ProductionBundle, timeline: ProductionTimeline,
  artifacts: readonly ArtifactSidecar[], clipId: TimelineClipId, newClipId: TimelineClipId): TimelineClipCommand[] {
  const track = timeline.tracks.find(candidate => candidate.clips.some(clip => clip.id === clipId));
  const clip = track?.clips.find(candidate => candidate.id === clipId);
  if (!clip || track?.kind !== "picture") throw new TimelineOperationRefused("Select a video clip to detach its audio");
  if (clip.audio === "mute") throw new TimelineOperationRefused("This picture's embedded audio is already muted");
  let source = clip.source;
  const sourceInFrames = clip.sourceInFrames;
  let measured: { hasAudio: boolean } | undefined;
  if (source.kind === "artifact") {
    const artifact = artifacts.find(candidate => source.kind === "artifact" && candidate.id === source.artifactId);
    if (!artifact || artifact.kind !== "video") throw new TimelineOperationRefused("This clip has no embedded video audio");
    measured = artifact.mediaInfo;
  } else if (source.kind === "take" || source.kind === "shot") {
    let takeId = source.kind === "take" ? source.takeId : production.selections[source.shotId]?.acceptedTakeId;
    const offsetSec = source.kind === "take" ? source.offsetSec : production.selections[source.shotId]?.trimInSec;
    if (source.kind === "shot") {
      // Freeze the actually resolved take. Selection trims may be finer than a frame, so
      // preserve their exact seconds in the source and keep subsequent frame edits separate.
      const resolved = resolvePictureTimeline(production, { status: "ready", timeline }).entries.find(entry => entry.clipId === clip.id && !entry.hole);
      takeId = resolved?.takeId ?? undefined;
    }
    const take = production.takes.find(candidate => candidate.id === takeId);
    const pass = take?.segment ? production.takes.find(candidate => candidate.id === take.segment!.passTakeId) : take;
    if (!take || !pass?.media) throw new TimelineOperationRefused("The video's source is missing");
    measured = production.takeMediaInfo[pass.id]?.mediaInfo;
    source = { kind: "take", takeId: take.id, label: clip.source.label, ...(offsetSec ? { offsetSec } : {}) };
  } else throw new TimelineOperationRefused("This source is already independent performance audio");
  if (!measured) throw new TimelineOperationRefused("Measure the video before detaching its audio");
  if (!measured.hasAudio) throw new TimelineOperationRefused("This video has no audio stream");
  const destination = timeline.tracks.find(candidate => candidate.kind === "audio" &&
    !candidate.clips.some(other => other.startFrame < clip.startFrame + clip.durationFrames && other.startFrame + other.durationFrames > clip.startFrame));
  const added = destination ? null : newAudioTrack(timeline);
  const sound: TimelineClip = {
    id: newClipId, startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceInFrames,
    source, gainDb: clip.gainDb ?? 0, role: destination ? placementAudioRole(destination) : "unspecified",
  };
  return [
    ...(added ? [added] : []),
    { kind: "place", trackId: destination?.id ?? added!.trackId, clip: sound },
    { kind: "set-clip-audio", clipId, audio: "mute" },
  ];
}
