import { resolveProductionArtifact } from "./artifact-access.js";
import type { ProductionBundle } from "./client-state.js";
import { dialogueSlots, performanceClipTiming } from "./dialogue-timing.js";
import { effectAnalysisCanonicalJson, type EffectAudioWindow } from "./editor-effect-analysis.js";
import type { EffectAudioInput } from "./editor-effects.js";
import type { RenderArtifact, RenderPlan } from "./render-plan.js";
import { textDigest } from "./subtitles.js";
import { AUDIO_TRACK_KINDS, type ProductionTimeline, type TimelineClip } from "./timeline.js";

export type ResolvedEffectAudioSource = { ok: true; label: string; selectedClipIds: string[]; sourcePaths: string[];
  placedWindows: EffectAudioWindow[]; audibleWindows: EffectAudioWindow[]; requestFingerprint: string; currentlySilent: boolean }
  | { ok: false; reason: string; requestFingerprint: string };

/** A UI freshness hint, never a substitute for the host's complete file hashes (SPEC-053 R-16). */
export function effectAudioRequestFingerprint(timeline: ProductionTimeline, plan: RenderPlan, input: EffectAudioInput): string {
  return `effect-audio-request-v1:${textDigest(effectAnalysisCanonicalJson({ input, frameRate: timeline.frameRate,
    range: plan.range, audio: plan.audio, mix: plan.mix, speech: plan.speech,
    tracks: timeline.tracks.filter(track => track.kind === "picture" || AUDIO_TRACK_KINDS.has(track.kind)).map(track => ({
      id: track.id, kind: track.kind, muted: track.muted, solo: track.solo, defaultRole: track.defaultRole,
      clips: track.clips.map(clip => ({ id: clip.id, startFrame: clip.startFrame, durationFrames: clip.durationFrames,
        sourceInFrames: clip.sourceInFrames, source: clip.source, gainDb: clip.gainDb, role: clip.role, audio: clip.audio })),
    })),
  }))}`;
}

/** Select placed sound independently of the visual target, effect interval and music role. */
export function resolveEffectAudioSource({ timeline, production, artifacts, plan, input }: {
  timeline: ProductionTimeline; production: ProductionBundle; artifacts: readonly RenderArtifact[]; plan: RenderPlan; input: EffectAudioInput;
}): ResolvedEffectAudioSource {
  const base = effectAudioRequestFingerprint(timeline, plan, input);
  let requestFingerprint = base;
  const failed = (reason: string): ResolvedEffectAudioSource => ({ ok: false, reason, requestFingerprint });
  const tracks = timeline.tracks;
  const selected = input.kind === "composition-mix" ? tracks.flatMap(track => track.clips)
    : input.kind === "audio-track" ? tracks.find(track => track.id === input.trackId)?.clips
    : tracks.flatMap(track => track.clips).filter(clip => clip.id === input.clipId);
  if (input.kind === "audio-track") {
    const track = tracks.find(track => track.id === input.trackId);
    if (!track || !AUDIO_TRACK_KINDS.has(track.kind)) return failed(`Audio track ${input.trackId} is missing`);
  }
  if (!selected || (input.kind !== "composition-mix" && input.kind !== "audio-track" && selected.length !== 1)) return failed("The placed audio source is missing");
  const fps = timeline.frameRate;
  const resolved: Array<{ clipId: string; path: string; window?: EffectAudioWindow; identity: unknown }> = [];
  const sound = (clip: TimelineClip): { path: string; start: number; end: number; identity: unknown } | string => {
    let start = clip.startFrame / fps, end = (clip.startFrame + clip.durationFrames) / fps;
    let sourceIn = clip.sourceInFrames / fps, sourceOut: number | undefined, path: string, identity: unknown;
    const source = clip.source, video = input.kind === "video-sound";
    if (source.kind === "artifact") {
      const found = resolveProductionArtifact(artifacts, source.artifactId, production.meta.id);
      if (!found.ok) return `${clip.id} cites ${found.reason}`;
      const artifact = found.artifact;
      if (!((!video && artifact.kind === "audio") || (artifact.kind === "video" && artifact.mediaInfo?.hasAudio))) return `${source.label} has no measured sound`;
      path = `artifacts/${artifact.file}`; sourceOut = artifact.mediaInfo?.durationSec; identity = artifact;
    } else if (source.kind === "performance") {
      if (video) return `${source.label} is not video sound`;
      const timing = performanceClipTiming(clip, production.performances, dialogueSlots(production), fps);
      if (!timing.ok) return timing.reason;
      path = `productions/${production.meta.id}/performances/${timing.performance.id}/${timing.performance.file}`;
      start = timing.timing.speechStartSec; end = timing.timing.speechEndSec; sourceIn = timing.timing.sourceInSec;
      identity = timing.performance.provenance.outputHash;
    } else {
      const takeId = source.kind === "take" ? source.takeId : production.selections[source.shotId]?.acceptedTakeId;
      const take = production.takes.find(value => value.id === takeId);
      const pass = take?.segment ? production.takes.find(value => value.id === take.segment!.passTakeId) : take;
      const info = pass && production.takeMediaInfo[pass.id]?.mediaInfo;
      if (!pass?.media || !((!video && pass.kind === "voice") || (pass.kind === "clip" && info?.hasAudio))) return `${source.label} has no measured sound`;
      path = `productions/${production.meta.id}/takes/${pass.id}/${pass.media}`;
      sourceIn += (take?.segment?.inSec ?? 0) + (source.kind === "take" ? source.offsetSec ?? 0 : 0);
      sourceOut = Math.min(take?.segment?.outSec ?? Infinity, info?.durationSec ?? Infinity);
      identity = { takeId, passId: pass.id, segment: take?.segment, info };
    }
    if (sourceOut !== undefined) end = Math.min(end, start + Math.max(0, sourceOut - sourceIn));
    return { path, start, end, identity };
  };
  if (input.kind !== "composition-mix") for (const clip of selected) {
    const value = sound(clip);
    if (typeof value === "string") { requestFingerprint = `${base}:${textDigest(value)}`; return failed(value); }
    const startSec = Math.max(plan.range.startSec, value.start), endSec = Math.min(plan.range.endSec, value.end);
    resolved.push({ clipId: clip.id, path: value.path, ...(endSec > startSec ? { window: { startSec, endSec } } : {}), identity: value.identity });
  }
  requestFingerprint = `${base}:${textDigest(effectAnalysisCanonicalJson(resolved))}`;
  const selectedClipIds = input.kind === "composition-mix" ? plan.audio.flatMap(item => item.clipId ? [item.clipId] : []) : selected.map(clip => clip.id);
  const chosen = new Set(selectedClipIds);
  const audibleWindows = plan.audio.filter(item => input.kind === "composition-mix" || (item.clipId && chosen.has(item.clipId))).flatMap(item => {
    const selected = resolved.find(value => value.clipId === item.clipId);
    if (selected && !selected.window) return [];
    const physical = selected?.window;
    const startSec = Math.max(plan.range.startSec, item.startSec, physical?.startSec ?? -Infinity);
    const endSec = Math.min(plan.range.endSec, item.endSec, physical?.endSec ?? Infinity);
    return endSec > startSec ? [{ startSec, endSec }] : [];
  });
  return { ok: true, requestFingerprint, selectedClipIds, sourcePaths: [...new Set([...plan.audio.map(item => item.path), ...resolved.map(value => value.path)])].sort(),
    placedWindows: input.kind === "composition-mix" ? audibleWindows : resolved.flatMap(value => value.window ? [value.window] : []), audibleWindows,
    currentlySilent: audibleWindows.length === 0,
    label: input.kind === "composition-mix" ? "Composition mix" : input.kind === "audio-track" ? tracks.find(track => track.id === input.trackId)!.name : selected[0]!.source.label };
}
