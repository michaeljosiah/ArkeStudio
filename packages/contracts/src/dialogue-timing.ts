import { z } from "zod";
import type { ProductionBundle } from "./client-state.js";
import { DialogueTimingIntentSchema, type DialogueTimingIntent } from "./cut.js";
import { PerformanceIdSchema } from "./performance.js";
import { orderedShots } from "./scene-flow.js";
import { resolvedAuthoredDuration, sortScenes } from "./scene.js";
import { basePictureTrack, framesToSeconds, orderedTrackClips } from "./timeline.js";

export const DispatchTimingSnapshotSchema = z.object({
  slotSource: z.enum(["shot-duration", "spine-anchor", "timeline-clip"]),
  slotDurationSec: z.number().finite().positive(), requestedDurationSec: z.number().finite().positive().nullable(),
  providerDurationMode: z.enum(["requested", "input-exact", "input-capped", "input-padded", "input-trimmed", "advisory"]),
  performanceId: PerformanceIdSchema.optional(), performanceDurationSec: z.number().finite().positive().optional(),
  providerPaddingSec: z.number().finite().nonnegative(),
}).strict();
export type DialogueSlot = { shotId: string; startSec: number; endSec: number; source: "shot-duration" | "spine-anchor" | "timeline-clip" };

/** Saved editor placement wins. A missing/duplicate picture placement is not an inferred slot. */
export function dialogueSlots(production: ProductionBundle): DialogueSlot[] {
  if (production.timeline?.status === "ready") {
    const timeline = production.timeline.timeline;
    const track = basePictureTrack(timeline);
    if (!track) return [];
    return orderedTrackClips(track).flatMap(clip => clip.source.kind === "shot" ? [{
      shotId: clip.source.shotId, startSec: framesToSeconds(clip.startFrame, timeline.frameRate),
      endSec: framesToSeconds(clip.startFrame + clip.durationFrames, timeline.frameRate), source: "timeline-clip" as const,
    }] : []);
  }
  if (production.timeline?.status === "invalid") return [];
  if (production.spine) return Object.entries(production.spine.anchors).map(([shotId, a]) => ({ shotId, ...a, source: "spine-anchor" as const })).sort((a,b) => a.startSec-b.startSec);
  let cursor = 0;
  return sortScenes(production.scenes).flatMap(scene => orderedShots(scene).map(shot => {
    const startSec = cursor; cursor += resolvedAuthoredDuration(shot);
    return { shotId: shot.id, startSec, endSec: cursor, source: "shot-duration" as const };
  }));
}
export type DialogueTiming = {
  shotId: string; sourceInSec: number; sourceOutSec: number; spokenSec: number;
  speechStartSec: number; speechEndSec: number; requiredMinimumSec: number; slotDurationSec: number;
  deltaSec: number; audioOverflowSec: number; unusedSlotSec: number; intent: DialogueTimingIntent;
};
export function calculateDialogueTiming(slot: DialogueSlot, measuredSec: number | null, leadInSec: number,
  intent: DialogueTimingIntent = DialogueTimingIntentSchema.parse({})):
  { ok: true; timing: DialogueTiming } | { ok: false; reason: string } {
  if (measuredSec === null || !Number.isFinite(measuredSec) || measuredSec <= 0) return { ok: false, reason: "The performance needs a measured duration." };
  if (!Number.isFinite(leadInSec) || leadInSec < 0) return { ok: false, reason: "Lead-in must be a nonnegative number of seconds." };
  const parsed = DialogueTimingIntentSchema.safeParse(intent);
  if (!parsed.success) return { ok: false, reason: parsed.error.message };
  intent = parsed.data;
  if (slot.endSec <= slot.startSec) return { ok: false, reason: "The picture slot must have positive duration." };
  const sourceInSec = intent.sourceRange?.inSec ?? 0, sourceOutSec = intent.sourceRange?.outSec ?? measuredSec;
  if (sourceOutSec > measuredSec || sourceInSec >= measuredSec) return { ok: false, reason: "The source range exceeds the measured performance." };
  if (intent.overflow.mode === "overlap" && intent.overflow.withShotId === slot.shotId) return { ok: false, reason: "A dialogue overlap cannot name its own shot." };
  const spokenSec = sourceOutSec-sourceInSec, speechStartSec = slot.startSec+leadInSec;
  const speechEndSec = speechStartSec+spokenSec, requiredMinimumSec = leadInSec+spokenSec+intent.postHandle.durationSec;
  const slotDurationSec = slot.endSec-slot.startSec;
  return { ok: true, timing: { shotId: slot.shotId, sourceInSec, sourceOutSec, spokenSec, speechStartSec, speechEndSec,
    requiredMinimumSec, slotDurationSec, deltaSec: slotDurationSec-requiredMinimumSec,
    audioOverflowSec: Math.max(0,speechEndSec-slot.endSec), unusedSlotSec: Math.max(0,slot.endSec-speechEndSec), intent } };
}
export function dialogueTimingProblems(timings: readonly DialogueTiming[], slots: readonly DialogueSlot[], timelineEndSec: number): string[] {
  const problems: string[] = [];
  for (const timing of timings) {
    const own = slots.filter(s => s.shotId === timing.shotId);
    if (own.length !== 1) problems.push(`${timing.shotId}: choose one unambiguous picture placement.`);
    if (timing.speechEndSec > timelineEndSec) problems.push(`${timing.shotId}: speech exceeds the production timeline by ${timing.speechEndSec-timelineEndSec}s.`);
    if (timing.audioOverflowSec > 0 && timing.intent.overflow.mode === "forbid") problems.push(`${timing.shotId}: speech exceeds its slot by ${timing.audioOverflowSec}s; review an overlap or extend picture.`);
    if (timing.intent.overflow.mode === "overlap") {
      const partnerId = timing.intent.overflow.withShotId;
      const partner = timings.find(t => t.shotId === partnerId);
      const targetSlots = slots.filter(s => s.shotId === partnerId);
      if (targetSlots.length !== 1 || (timing.audioOverflowSec > 0 && !targetSlots.some(s => Math.min(s.endSec,timing.speechEndSec)>Math.max(s.startSec,timing.speechStartSec)))) {
        problems.push(`${timing.shotId}: the named overlap has no intersecting picture slot.`);
      }
      if (!partner || partner.intent.overflow.mode !== "overlap" || partner.intent.overflow.withShotId !== timing.shotId || overlapSeconds(timing,partner) <= 0) {
        problems.push(`${timing.shotId}: overlap needs a positive speech intersection and mutual approval with ${partnerId}.`);
      }
    }
  }
  for (let i=0;i<timings.length;i++) for (let j=i+1;j<timings.length;j++) {
    const a=timings[i]!, b=timings[j]!;
    if (a.shotId===b.shotId) problems.push(`${a.shotId}: multiple dialogue placements are not supported.`);
    const seconds=overlapSeconds(a,b);
    if (seconds>0 && !(a.intent.overflow.mode==="overlap" && a.intent.overflow.withShotId===b.shotId && b.intent.overflow.mode==="overlap" && b.intent.overflow.withShotId===a.shotId)) problems.push(`${a.shotId} / ${b.shotId}: ${seconds}s of dialogue overlap lacks mutual approval.`);
  }
  return [...new Set(problems)];
}
function overlapSeconds(a: DialogueTiming,b: DialogueTiming): number {
  return Math.max(0,Math.min(a.speechEndSec,b.speechEndSec)-Math.max(a.speechStartSec,b.speechStartSec));
}
