import { DEFAULT_MIX, type ProductionTimeline, type RenderPlan } from "@arke-studio/contracts";
import type { EffectAnalysisContext } from "../src/screens/editor-effect-analysis.js";
import { FIXTURE_STATE } from "./fixture-state.js";

export function effectArrangementFixture() {
  const state = structuredClone(FIXTURE_STATE), production = state.world!.productions[0]!;
  const timeline: ProductionTimeline = { schemaVersion: 1, revision: 0, frameRate: 24, mix: DEFAULT_MIX, library: [], history: { undo: [], redo: [] }, tracks: [
    { id: "tr_picture", kind: "picture", name: "Video 1", order: 0, muted: false, clips: [
      { id: "cl_still", startFrame: 0, durationFrames: 96, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_still", label: "Still" } },
      { id: "cl_video", startFrame: 96, durationFrames: 144, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_video", label: "Waves" } },
    ] },
    { id: "tr_audio", kind: "audio", name: "Backing sound", order: 1, muted: true, clips: [
      { id: "cl_audio", startFrame: 48, durationFrames: 264, sourceInFrames: 0, source: { kind: "artifact", artifactId: "ar_audio", label: "Backing" } },
    ] },
  ] };
  const prototype = state.world!.artifacts[0]!;
  const artifacts = [
    { ...prototype, id: "ar_still", kind: "image" as const, file: "still.png", production: production.meta.id },
    { ...prototype, id: "ar_video", kind: "video" as const, file: "waves.mp4", production: production.meta.id, mediaInfo: { durationSec: 12, hasAudio: true, width: 100, height: 100 } },
    { ...prototype, id: "ar_audio", kind: "audio" as const, file: "backing.wav", production: production.meta.id, mediaInfo: { durationSec: 12, hasAudio: true } },
  ];
  const plan: RenderPlan = { preset: "review-cut", frameRate: 24, items: [], overlays: [], audio: [], totalSec: 10, revision: 0,
    range: { startSec: 0, endSec: 10 }, scope: { kind: "production" }, mix: DEFAULT_MIX, speech: [], subtitles: null };
  const context: EffectAnalysisContext = { worldId: state.world!.meta.worldId, production, artifacts, timeline };
  return { context, plan, timeline };
}
