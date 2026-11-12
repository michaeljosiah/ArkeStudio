import { AUDIO_TRACK_KINDS, effectiveAudioRole } from "./timeline.js";
import type { ProductionBundle } from "./client-state.js";

export const NO_BACKGROUND_MUSIC = "No background music — environmental and action sound only.";

/** Delivery owns the score after materialisation; an assigned spine master also states intent. */
export function productionHasScore(production: Pick<ProductionBundle, "spine" | "timeline" | "cut">): boolean {
  if (production.spine) return true;
  if (production.timeline?.status === "ready") return production.timeline.timeline.tracks.some(track =>
    AUDIO_TRACK_KINDS.has(track.kind) && track.clips.some(clip => effectiveAudioRole(track, clip) === "music"));
  return production.cut.audio.some(track => track.kind === "score" && track.entries.length > 0);
}
