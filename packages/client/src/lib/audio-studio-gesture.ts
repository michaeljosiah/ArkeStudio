export { shiftAudioPlacement } from "@arke-studio/contracts";
import { shiftAudioPlacement, type AudioArrangementCommand, type ResolvedAudioClip } from "@arke-studio/contracts";
import type { PictureGesture } from "./picture-edit.js";

/** The shared pointer engine measures integer units; Audio Studio supplies samples, never fps. */
export function audioGestureCommand(entry: ResolvedAudioClip, gesture: PictureGesture, delta: number): AudioArrangementCommand | null {
  if (!Number.isSafeInteger(delta) || !delta || entry.clip.protected) return null;
  const clip = entry.clip;
  if (gesture === "move") return { kind: "set-clip", id: clip.id, changes: { placement: shiftAudioPlacement(clip.placement, Math.max(-entry.at, delta)) } };
  if (clip.placement.kind === "range") {
    const edge = gesture === "trim-start" ? "from" : "to";
    const amount = gesture === "trim-start"
      ? Math.max(clip.loop ? -(clip.loopOffset ?? 0) : -clip.sourceIn, -entry.at, Math.min(entry.samples - 1, delta))
      : Math.max(1 - entry.samples, clip.loop ? delta : Math.min(clip.sourceOut - clip.sourceIn - entry.samples, delta));
    const duration = entry.samples + (gesture === "trim-start" ? -amount : amount), fadeIn = Math.min(clip.fadeIn, duration);
    return { kind: "set-clip", id: clip.id, changes: {
      placement: { ...clip.placement, [edge]: { ...clip.placement[edge], offset: clip.placement[edge].offset + amount } },
      ...(gesture === "trim-start" ? clip.loop ? { loopOffset: (clip.loopOffset ?? 0) + amount } : { sourceIn: clip.sourceIn + amount, loopFade: Math.min(clip.loopFade, Math.floor((clip.sourceOut - clip.sourceIn - amount) / 2)) } : {}),
      fadeIn, fadeOut: Math.min(clip.fadeOut, duration - fadeIn),
    } };
  }
  if (clip.loop) {
    if (gesture === "trim-end") return { kind: "set-clip", id: clip.id, changes: { loopDuration: Math.max(1, entry.samples + delta), fadeIn: Math.min(clip.fadeIn, Math.max(1, entry.samples + delta)), fadeOut: Math.min(clip.fadeOut, Math.max(0, entry.samples + delta - clip.fadeIn)) } };
    const amount = Math.max(-(clip.loopOffset ?? 0), -entry.at, Math.min(entry.samples - 1, delta)), duration = entry.samples - amount;
    return { kind: "set-clip", id: clip.id, changes: { loopOffset: (clip.loopOffset ?? 0) + amount, loopDuration: duration, placement: shiftAudioPlacement(clip.placement, amount), fadeIn: Math.min(clip.fadeIn, duration), fadeOut: Math.min(clip.fadeOut, Math.max(0, duration - clip.fadeIn)) } };
  }
  if (gesture === "trim-start") {
    const amount = Math.max(-clip.sourceIn, -entry.at, Math.min(clip.sourceOut - clip.sourceIn - 1, delta));
    const sourceIn = clip.sourceIn + amount, duration = clip.sourceOut - sourceIn;
    return { kind: "set-clip", id: clip.id, changes: { sourceIn, placement: shiftAudioPlacement(clip.placement, amount), fadeIn: Math.min(clip.fadeIn, duration), fadeOut: Math.min(clip.fadeOut, Math.max(0, duration - clip.fadeIn)), loopFade: Math.min(clip.loopFade, Math.floor(duration / 2)) } };
  }
  const sourceOut = Math.max(clip.sourceIn + 1, Math.min(clip.source?.samples ?? clip.sourceOut, clip.sourceOut + delta)), duration = sourceOut - clip.sourceIn;
  return { kind: "set-clip", id: clip.id, changes: { sourceOut, fadeIn: Math.min(clip.fadeIn, duration), fadeOut: Math.min(clip.fadeOut, Math.max(0, duration - clip.fadeIn)), loopFade: Math.min(clip.loopFade, Math.floor(duration / 2)) } };
}
