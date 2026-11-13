import { AUDIO_TRACK_KINDS, resolveEffectAudioSource, type EffectAudioInput, type RenderPlan } from "@arke-studio/contracts";
import type { EffectAnalysisContext } from "../screens/editor-effect-analysis.js";
import { formatTimecode } from "./timeline-drag.js";

export function effectAudioOptions(context: EffectAnalysisContext, plan: RenderPlan | null) {
  const rows: Array<{ input: EffectAudioInput; label: string; reason?: string }> = [{ input: { kind: "composition-mix" }, label: "Composition mix" }];
  const range = (start: number, duration: number) => `${formatTimecode(start / context.timeline.frameRate, context.timeline.frameRate)}–${formatTimecode((start + duration) / context.timeline.frameRate, context.timeline.frameRate)}`;
  for (const track of context.timeline.tracks) {
    if (AUDIO_TRACK_KINDS.has(track.kind)) {
      const start = Math.min(...track.clips.map(clip => clip.startFrame)), end = Math.max(...track.clips.map(clip => clip.startFrame + clip.durationFrames));
      rows.push({ input: { kind: "audio-track", trackId: track.id }, label: `Whole audio track · ${track.name} · ${track.clips.length ? range(start, end - start) : "empty"}` });
    }
    if (AUDIO_TRACK_KINDS.has(track.kind) || track.kind === "picture") for (const clip of track.clips) {
      rows.push({ input: { kind: track.kind === "picture" ? "video-sound" : "audio-clip", clipId: clip.id },
        label: `${track.kind === "picture" ? "Video sound" : "Audio clip"} · ${clip.source.label} · ${track.name} · ${range(clip.startFrame, clip.durationFrames)}` });
    }
  }
  return rows.map(row => {
    if (!plan) return { ...row, reason: "Resolve the timeline's media before choosing sound." };
    const source = resolveEffectAudioSource({ ...context, plan, input: row.input });
    return source.ok ? { ...row, label: `${row.label}${source.currentlySilent ? " · currently silent" : ""}` } : { ...row, reason: source.reason };
  });
}
