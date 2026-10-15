import type { AudioArrangementCommand, AudioPlacement, ResolvedAudioClip } from "@arke-studio/contracts";
import type { PictureGesture } from "./picture-edit.js";

/** The shared pointer engine measures integer units; Audio Studio supplies samples, never fps. */
export function shiftAudioPlacement(placement: AudioPlacement, delta: number): AudioPlacement {
  if (placement.kind === "fixed") return { ...placement, at: placement.at + delta };
  if (placement.kind === "sequence") return { ...placement, offset: placement.offset + delta };
  if (placement.kind === "passage") return { ...placement, anchor: { ...placement.anchor, offset: placement.anchor.offset + delta } };
  return { ...placement, from: { ...placement.from, offset: placement.from.offset + delta }, to: { ...placement.to, offset: placement.to.offset + delta } };
}
export function audioGestureCommand(entry: ResolvedAudioClip, gesture: PictureGesture, delta: number): AudioArrangementCommand | null {
  if (!Number.isSafeInteger(delta) || !delta || entry.clip.protected) return null;
  const clip = entry.clip;
  if (gesture === "move") return { kind: "set-clip", id: clip.id, changes: { placement: shiftAudioPlacement(clip.placement, Math.max(-entry.at, delta)) } };
  if (clip.placement.kind === "range") {
    const edge = gesture === "trim-start" ? "from" : "to";
    return { kind: "set-clip", id: clip.id, changes: { placement: { ...clip.placement, [edge]: { ...clip.placement[edge], offset: clip.placement[edge].offset + delta } } } };
  }
  if (gesture === "trim-start") {
    const amount = Math.max(-clip.sourceIn, -entry.at, Math.min(clip.sourceOut - clip.sourceIn - 1, delta));
    const sourceIn = clip.sourceIn + amount, duration = clip.sourceOut - sourceIn;
    return { kind: "set-clip", id: clip.id, changes: { sourceIn, placement: shiftAudioPlacement(clip.placement, amount), fadeIn: Math.min(clip.fadeIn, duration), fadeOut: Math.min(clip.fadeOut, Math.max(0, duration - clip.fadeIn)), loopFade: Math.min(clip.loopFade, Math.floor(duration / 2)) } };
  }
  const sourceOut = Math.max(clip.sourceIn + 1, Math.min(clip.source?.samples ?? clip.sourceOut, clip.sourceOut + delta)), duration = sourceOut - clip.sourceIn;
  return { kind: "set-clip", id: clip.id, changes: { sourceOut, fadeIn: Math.min(clip.fadeIn, duration), fadeOut: Math.min(clip.fadeOut, Math.max(0, duration - clip.fadeIn)), loopFade: Math.min(clip.loopFade, Math.floor(duration / 2)) } };
}
