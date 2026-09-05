import { z } from "zod";
import type { Take } from "./take.js";
import {
  IsoDateTimeSchema,
  ShotIdSchema,
  TakeIdSchema,
} from "./ids.js";

export const DialogueFailureTagSchema = z.enum([
  "wrong-speaker-mouth",
  "listener-face-distorted",
  "audio-ignored",
  "cadence-changed",
  "framing-drifted",
  "camera-too-static",
  "start-frame-not-respected",
]);

export const TakeDialogueFeedbackSchema = z
  .object({
    requestId: z.string().optional(),
    schemaVersion: z.literal(1),
    kind: z.literal("dialogue-diagnostic"),
    ts: IsoDateTimeSchema,
    takeId: TakeIdSchema,
    shotId: ShotIdSchema,
    tags: z.array(DialogueFailureTagSchema).min(1),
    recommendationIds: z.array(z.string().min(1)),
    note: z.string().max(1000).optional(),
    by: z.string().min(1),
  })
  .strict().superRefine((value, ctx) => {
    if (new Set(value.tags).size !== value.tags.length || new Set(value.recommendationIds).size !== value.recommendationIds.length)
      ctx.addIssue({ code: "custom", message: "Feedback tags and recommendation IDs must be unique." });
  });

export type TakeDialogueFeedback = z.infer<typeof TakeDialogueFeedbackSchema>;
export function allowedDialogueFeedback(take: Take, shotId: string): TakeDialogueFeedback["tags"] {
  const assessment = take.provenance.dialogueAssessments?.[shotId];
  if (!take.coversShots.includes(shotId) || !assessment) return [];
  const tags: TakeDialogueFeedback["tags"] = ["framing-drifted", "camera-too-static"];
  if (assessment.facts.speakerId) tags.push("wrong-speaker-mouth");
  if ((assessment.facts.authoredNonSpeakerPresentedFaceCount ?? 0) > 0) tags.push("listener-face-distorted");
  if (assessment.facts.audioIntent !== "none" && take.params.audioReferences) tags.push("audio-ignored");
  if (assessment.facts.frameMode === "exact-start-frame" && take.startFrame && take.params.frameArtifact) tags.push("start-frame-not-respected");
  if (assessment.recommendations.some(r => r.guidance.claims?.includes("cadence"))) tags.push("cadence-changed");
  return tags;
}

export function aggregateDialogueFeedback(takes: readonly Take[], feedback: readonly TakeDialogueFeedback[]) {
  const groups = new Map<string, { modelId: string; providerRoute: string; endpointVersion: string;
    guidanceId: string | null; guidanceRevision: number | null; tag: string; sampleCount: number }>();
  for (const item of feedback) {
    const assessment = takes.find(t => t.id === item.takeId)?.provenance.dialogueAssessments?.[item.shotId];
    if (!assessment) continue;
    const rows = assessment.recommendations.filter(r => item.recommendationIds.includes(r.id));
    for (const row of rows.length ? rows : [null]) for (const tag of item.tags) {
      const key = JSON.stringify([assessment.modelId, assessment.providerRoute, assessment.endpointVersion,
        row?.guidanceId ?? null, row?.guidanceRevision ?? null, row?.guidance.when ?? null, assessment.facts, tag]);
      const existing = groups.get(key);
      if (existing) existing.sampleCount++;
      else groups.set(key, { modelId: assessment.modelId, providerRoute: assessment.providerRoute,
        endpointVersion: assessment.endpointVersion, guidanceId: row?.guidanceId ?? null,
        guidanceRevision: row?.guidanceRevision ?? null, tag, sampleCount: 1 });
    }
  }
  return [...groups.values()];
}
