import { AUDIO_TRACK_KINDS, EffectArrangementScopeSchema, WorldChatSubjectSchema,
  type EffectArrangementScope, type EffectAudioInput, type EffectVersionRef, type FrameRate,
  type ProductionTimeline, type RenderPlan, type WorldChatSubject } from "@arke-studio/contracts";

export interface EffectArrangementRange { startFrame: number; endFrame: number }
export type EffectArrangementSubject = Extract<WorldChatSubject, { kind: "effect-arrangement" }>;
export interface EffectArrangementRequest { scope: EffectArrangementScope; text: string }

/** The delivery clock, not the editor canvas extended by an effect beyond the film. */
export function effectArrangementDeliveryRange(plan: RenderPlan | null, frameRate: FrameRate): EffectArrangementRange | null {
  if (!plan) return null;
  const startFrame = Math.round(plan.range.startSec * frameRate), endFrame = Math.round(plan.range.endSec * frameRate);
  return Number.isSafeInteger(startFrame) && Number.isSafeInteger(endFrame) && startFrame >= 0 && endFrame > startFrame
    ? { startFrame, endFrame } : null;
}

export type EffectArrangementRangeResult = { ok: true; original: EffectArrangementRange; range: EffectArrangementRange; clipped: boolean; hasGaps: boolean }
  | { ok: false; reason: string };

/** A copy operation on the chosen placement. It never chooses the reaction source or visual target. */
export function effectArrangementPlacedRange(timeline: ProductionTimeline, input: EffectAudioInput,
  delivery: EffectArrangementRange | null): EffectArrangementRangeResult {
  if (!delivery) return { ok: false, reason: "The video needs a delivery range before copying a song interval." };
  if (input.kind === "composition-mix") return { ok: false, reason: "Choose a placed audio track, audio clip or video sound. The composition mix has no single song interval." };
  const tracks = timeline.tracks.filter(track => input.kind === "video-sound" ? track.kind === "picture" : AUDIO_TRACK_KINDS.has(track.kind));
  const clips = input.kind === "audio-track" ? tracks.find(track => track.id === input.trackId)?.clips
    : tracks.flatMap(track => track.clips).filter(clip => clip.id === input.clipId);
  if (!clips?.length) return { ok: false, reason: "This placed audio is missing or the track is empty. Choose another interval explicitly." };
  const sorted = [...clips].sort((a, b) => a.startFrame - b.startFrame);
  const original = { startFrame: sorted[0]!.startFrame, endFrame: Math.max(...sorted.map(clip => clip.startFrame + clip.durationFrames)) };
  const range = { startFrame: Math.max(delivery.startFrame, original.startFrame), endFrame: Math.min(delivery.endFrame, original.endFrame) };
  if (range.endFrame <= range.startFrame) return { ok: false, reason: "This placed audio is outside the video delivery range." };
  let coveredUntil = original.startFrame, hasGaps = false;
  for (const clip of sorted) {
    if (clip.startFrame > coveredUntil) hasGaps = true;
    coveredUntil = Math.max(coveredUntil, clip.startFrame + clip.durationFrames);
  }
  return { ok: true, original, range, clipped: range.startFrame !== original.startFrame || range.endFrame !== original.endFrame, hasGaps };
}

export function effectArrangementRequest(value: EffectArrangementScope): EffectArrangementRequest {
  const scope = EffectArrangementScopeSchema.parse(value);
  if (new Set(scope.palette.map(preset => `${preset.id}:${preset.version}`)).size !== scope.palette.length) throw new Error("Choose each effect preset only once.");
  return { scope, text: `Suggest an effects-only arrangement. ${scope.direction}` };
}

/** A revision is about exactly the reviewed family. Its new instructions do not rewrite that family's scope. */
export function effectArrangementFollowUp({ scope, reviewed, text, selectedEffectId }: {
  scope: EffectArrangementScope; reviewed: EffectVersionRef; text: string; selectedEffectId?: string;
}): { text: string; subject: EffectArrangementSubject } {
  const message = text.trim();
  if (!message) throw new Error("Describe the revision to ask Arke for.");
  const subject = WorldChatSubjectSchema.parse({ kind: "effect-arrangement", scope, reviewed,
    ...(selectedEffectId ? { selectedEffectId } : {}) });
  if (subject.kind !== "effect-arrangement") throw new Error("Choose the reviewed effect arrangement.");
  return { text: message, subject };
}
