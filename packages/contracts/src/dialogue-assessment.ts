import { ShotVisualFactsSchema } from "./shot-visual-facts.js";
import type { Shot } from "./scene.js";
import { DialogueFrameModeSchema, DialogueAudioIntentSchema, DialogueGuidanceActionSchema, ModelDialogueGuidanceSchema, type ModelDialogueGuidance } from "./provider-guidance.js";
import { z } from "zod";
import {
  IsoDateTimeSchema,
  ShotIdSchema,
  SlugSchema,
} from "./ids.js";

export const DialogueShotFactSnapshotSchema = z
  .object({
    shotId: ShotIdSchema,
    /** Context only; never used as an on-screen/face count. */
    citedCharacterIds: z.array(SlugSchema),
    speakerId: SlugSchema.nullable(),
    visualFacts: ShotVisualFactsSchema.nullable(),
    authoredOnScreenCharacterCount: z.number().int().min(0).nullable(),
    authoredPresentedFaceCount: z.number().int().min(0).nullable(),
    authoredNonSpeakerPresentedFaceCount: z
      .number()
      .int()
      .min(0)
      .nullable(),
    speakerPresentation: z.enum([
      "face-front",
      "face-three-quarter",
      "face-profile",
      "turned-away",
      "back-of-head",
      "body-only",
      "not-on-screen",
      "unknown",
    ]),
    frameMode: DialogueFrameModeSchema,
    audioIntent: DialogueAudioIntentSchema,
    shotDurationSec: z.number().finite().positive().nullable(),
    audioDurationSec: z.number().finite().positive().nullable(),
    audioDurationRelation: z.enum([
      "within-shot",
      "longer-than-shot",
      "unknown",
    ]),
  })
  .strict();

export const DialogueRecommendationSnapshotSchema = z
  .object({
    id: z.string().min(1),
    guidanceId: z.string().min(1),
    guidanceRevision: z.number().int().min(1),
    guidance: ModelDialogueGuidanceSchema,
    classification: z.enum([
      "validated-warning",
      "provider-guidance",
      "anecdotal-tip",
    ]),
    message: z.string().min(1),
    actions: z.array(DialogueGuidanceActionSchema).min(1),
  })
  .strict();

export const IgnoredDialogueGuidanceSchema = z
  .object({
    guidanceId: z.string().min(1),
    guidanceRevision: z.number().int().min(1),
    reason: z.enum([
      "different-route",
      "endpoint-version-mismatch",
      "expired",
      "visual-facts-unavailable",
      "predicate-not-matched",
    ]),
  })
  .strict();

export const DialogueDispatchAssessmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    engineVersion: z.number().int().min(1),
    manifestVersion: z.number().int().min(1),
    modelId: z.string().min(1),
    providerRoute: z.string().min(1),
    endpointVersion: z.string().min(1),
    facts: DialogueShotFactSnapshotSchema,
    recommendations: z.array(DialogueRecommendationSnapshotSchema),
    ignoredGuidance: z.array(IgnoredDialogueGuidanceSchema),
    acknowledgedRecommendationIds: z.array(z.string().min(1)),
    assessedAt: IsoDateTimeSchema,
  })
  .strict();

export interface DialogueAssessmentInput {
  engineVersion: number;
  manifestVersion: number;
  modelId: string;
  providerRoute: string;
  endpointVersion: string;
  now: string;
  facts: z.infer<typeof DialogueShotFactSnapshotSchema>;
  guidance: readonly ModelDialogueGuidance[];
  hardBlocks: readonly { code: string; message: string }[];
  acknowledgedRecommendationIds: readonly string[];
}

export interface DialogueAssessmentResult {
  blockers: Array<{ code: string; message: string }>;
  assessment: z.infer<typeof DialogueDispatchAssessmentSchema>;
}

export type DialogueDispatchAssessment = z.infer<typeof DialogueDispatchAssessmentSchema>;
export type DialogueShotFactSnapshot = z.infer<typeof DialogueShotFactSnapshotSchema>;
const presentsFace = (presentation: string) => ["face-front", "face-three-quarter", "face-profile"].includes(presentation);

export function dialogueShotFacts(shot: Shot, citedCharacterIds: string[], transport: Pick<DialogueShotFactSnapshot,
  "frameMode" | "audioIntent" | "shotDurationSec" | "audioDurationSec">): DialogueShotFactSnapshot {
  const visualFacts = shot.visualFacts ?? null;
  const speakerId = shot.audio?.speaker ?? null;
  const characters = visualFacts?.onScreenCharacters;
  return DialogueShotFactSnapshotSchema.parse({ shotId: shot.id, citedCharacterIds, speakerId, visualFacts,
    frameMode: transport.frameMode, audioIntent: transport.audioIntent, shotDurationSec: transport.shotDurationSec, audioDurationSec: transport.audioDurationSec,
    authoredOnScreenCharacterCount: characters?.length ?? null,
    authoredPresentedFaceCount: characters?.filter(c => presentsFace(c.presentation)).length ?? null,
    authoredNonSpeakerPresentedFaceCount: characters?.filter(c => c.characterId !== speakerId && presentsFace(c.presentation)).length ?? null,
    speakerPresentation: characters ? characters.find(c => c.characterId === speakerId)?.presentation ?? "not-on-screen" : "unknown",
    audioDurationRelation: transport.audioDurationSec === null || transport.shotDurationSec === null ? "unknown"
      : transport.audioDurationSec > transport.shotDurationSec ? "longer-than-shot" : "within-shot" });
}

// Canonical full snapshots make identity collision-free without a platform-specific hash or
// randomness. Timestamps of assessment are excluded; changes to actual evidence invalidate it.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function assessDialogueShot(input: DialogueAssessmentInput): DialogueAssessmentResult {
  const facts = DialogueShotFactSnapshotSchema.parse(input.facts);
  const recommendations: DialogueDispatchAssessment["recommendations"] = [];
  const ignoredGuidance: DialogueDispatchAssessment["ignoredGuidance"] = [];
  for (const raw of input.guidance) {
    const row = ModelDialogueGuidanceSchema.parse(raw), p = row.when;
    let reason: DialogueDispatchAssessment["ignoredGuidance"][number]["reason"] | undefined;
    const needsVisual = Object.keys(p).some(key => !["frameModes", "audioIntents", "audioDurationRelation"].includes(key));
    if (row.modelId !== input.modelId || row.providerRoute !== input.providerRoute) reason = "different-route";
    else if (row.endpointVersion !== input.endpointVersion) reason = "endpoint-version-mismatch";
    else if (row.expiresAt && Date.parse(row.expiresAt) <= Date.parse(input.now)) reason = "expired";
    else if (needsVisual && !facts.visualFacts) reason = "visual-facts-unavailable";
    else if (
      (p.minAuthoredOnScreenCharacters !== undefined && (facts.authoredOnScreenCharacterCount ?? -1) < p.minAuthoredOnScreenCharacters) ||
      (p.maxAuthoredOnScreenCharacters !== undefined && (facts.authoredOnScreenCharacterCount ?? Infinity) > p.maxAuthoredOnScreenCharacters) ||
      (p.minAuthoredPresentedFaces !== undefined && (facts.authoredPresentedFaceCount ?? -1) < p.minAuthoredPresentedFaces) ||
      (p.minAuthoredNonSpeakerPresentedFaces !== undefined && (facts.authoredNonSpeakerPresentedFaceCount ?? -1) < p.minAuthoredNonSpeakerPresentedFaces) ||
      (p.speakerPresentations && !p.speakerPresentations.includes(facts.speakerPresentation)) ||
      (p.compositions && (!facts.visualFacts || !p.compositions.includes(facts.visualFacts.composition))) ||
      (p.foregroundPresentations && !facts.visualFacts?.onScreenCharacters.some(c => c.depth === "foreground" && p.foregroundPresentations!.includes(c.presentation))) ||
      (p.frameModes && !p.frameModes.includes(facts.frameMode)) ||
      (p.audioIntents && !p.audioIntents.includes(facts.audioIntent)) ||
      (p.audioDurationRelation && p.audioDurationRelation !== facts.audioDurationRelation)
    ) reason = "predicate-not-matched";
    if (reason) { ignoredGuidance.push({ guidanceId: row.id, guidanceRevision: row.revision, reason }); continue; }
    const id = canonical({ engine: input.engineVersion, manifest: input.manifestVersion, model: input.modelId,
      route: input.providerRoute, endpoint: input.endpointVersion, guidance: row, facts });
    recommendations.push({ id, guidanceId: row.id, guidanceRevision: row.revision, guidance: row,
      classification: row.classification, message: row.message, actions: row.actions });
  }
  return { blockers: [...input.hardBlocks], assessment: DialogueDispatchAssessmentSchema.parse({ schemaVersion: 1,
    engineVersion: input.engineVersion, manifestVersion: input.manifestVersion, modelId: input.modelId,
    providerRoute: input.providerRoute, endpointVersion: input.endpointVersion, facts, recommendations, ignoredGuidance,
    acknowledgedRecommendationIds: [...new Set(input.acknowledgedRecommendationIds)].filter(id => recommendations.some(r => r.id === id)),
    assessedAt: input.now }) };
}
