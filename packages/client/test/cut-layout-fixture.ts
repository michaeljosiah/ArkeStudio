import { applyTimelineCommands, seedEmptyPictureTimeline, type TimelineClipCommand } from "@arke-studio/contracts";
import { generateLayoutFixture } from "./generate-layout-fixture.js";

/** Turn 170, with ordinary saved timeline state and file-backed browser fixture media. */
export function cutLayoutFixture() {
  const state = generateLayoutFixture();
  const world = state.world!, production = world.productions[0]!;
  production.meta.aspect = "16:9";
  const scene = production.scenes.find(item => item.id === "sc_04")!;
  if (!("shots" in scene)) throw new Error("Expected shot fixture");
  const seed = production.takes.find(take => take.kind === "clip" && take.coversShots.includes("sh_12"))!;
  scene.shots = [
    { ...scene.shots[0]!, id: "sh_06", number: 6, title: "The harbour waits", durationSec: 9 },
    { ...scene.shots[0]!, id: "sh_07", number: 7, title: "The crossing", durationSec: 8.5 },
    { ...scene.shots[0]!, title: "Maren at the rail", durationSec: 4 },
    { ...scene.shots[1]!, durationSec: 6 },
    { ...scene.shots[2]!, durationSec: 5 },
    { ...scene.shots[3]!, durationSec: 34.5 },
  ];
  const commands: TimelineClipCommand[] = [];
  let startFrame = 0;
  for (const shot of scene.shots) {
    const take = { ...structuredClone(seed), id: `cut-take-${shot.number}`, coversShots: [shot.id], media: `cut-shot${shot.number}.mp4`, segment: undefined };
    production.takes.push(take);
    production.selections[shot.id] = { ...production.selections[shot.id], acceptedTakeId: take.id, trimInSec: 0 };
    production.takeMediaInfo[take.id] = { ...production.takeMediaInfo[seed.id]!, mediaInfo: { durationSec: shot.durationSec!, hasAudio: false, width: 1280, height: 720 } };
    commands.push({ kind: "place", trackId: "tr_picture", clip: { id: `cl_${shot.number}`, startFrame, durationFrames: shot.durationSec! * 24, sourceInFrames: 0, source: { kind: "shot", shotId: shot.id, shotNumber: shot.number, sceneNumber: shot.number < 12 ? 3 : 4, label: shot.title } } });
    startFrame += shot.durationSec! * 24;
  }
  const sound = { ...world.artifacts[0]!, id: "ar_01J8G0000000000000000000ZZ", links: [], kind: "audio" as const, file: "harbour-bells.wav", production: production.meta.id, mediaInfo: { durationSec: 67, hasAudio: true } };
  world.artifacts.push(sound);
  commands.push({ kind: "add-track", trackId: "tr_dialogue", trackKind: "dialogue", name: "Dialogue" }, { kind: "add-track", trackId: "tr_ambience", trackKind: "ambience", name: "Ambience" });
  for (const [id, frame, length, label] of [["maren", 480, 60, 'Maren · “Listen.”'], ["chorister", 588, 132, "Chorister · the verse, far below"], ["bray", 756, 132, 'Bray · “You hear that?”']] as const) commands.push({ kind: "place", trackId: "tr_dialogue", clip: { id: `cl_${id}`, startFrame: frame, durationFrames: length, sourceInFrames: 0, source: { kind: "artifact", artifactId: sound.id, label }, gainDb: 0 } });
  commands.push({ kind: "place", trackId: "tr_ambience", clip: { id: "cl_bells", startFrame: 0, durationFrames: startFrame, sourceInFrames: 0, source: { kind: "artifact", artifactId: sound.id, label: "Harbour bells" }, gainDb: -12 } });
  const timeline = seedEmptyPictureTimeline(production);
  const pictureId = timeline.tracks[0]!.id;
  for (const command of commands) if (command.kind === "place" && command.trackId === "tr_picture") command.trackId = pictureId;
  commands.push({ kind: "add-to-library", items: scene.shots.map(shot => ({ kind: "shot" as const, shotId: shot.id })) });
  production.scenes = [{ ...structuredClone(scene), id: "sc_03", number: 3, title: "At the harbour", shots: scene.shots.slice(0, 2) }, scene];
  scene.shots = scene.shots.slice(2);
  production.timeline = { status: "ready", timeline: applyTimelineCommands(timeline, commands) };
  return state;
}
