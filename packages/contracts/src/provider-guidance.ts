import { z } from "zod";
import { FullSha256Schema } from "./audio.js";
import { IsoDateTimeSchema } from "./ids.js";

export const DialogueFrameModeSchema = z.enum([
  "none",
  "reference-image",
  "exact-start-frame",
]);

export const DialogueAudioIntentSchema = z.enum([
  "none",
  "voice-reference",
  "performance-sync",
]);


export const DialogueGuidanceActionSchema = z.enum([
  "keep-current",
  "switch-model",
  "use-reference-image",
  "use-exact-start-frame",
  "create-over-shoulder-proposal",
  "isolate-speaker-proposal",
  "change-audio-route",
]);

export const DialogueGuidancePredicateSchema = z
  .object({
    minAuthoredOnScreenCharacters: z.number().int().min(1).optional(),
    maxAuthoredOnScreenCharacters: z.number().int().min(1).optional(),
    minAuthoredPresentedFaces: z.number().int().min(1).optional(),
    minAuthoredNonSpeakerPresentedFaces: z.number().int().min(1).optional(),
    speakerPresentations: z
      .array(
        z.enum([
          "face-front",
          "face-three-quarter",
          "face-profile",
          "turned-away",
          "back-of-head",
          "body-only",
          "not-on-screen",
          "unknown",
        ]),
      )
      .min(1)
      .optional(),
    compositions: z
      .array(
        z.enum([
          "single",
          "two-shot",
          "group",
          "over-the-shoulder",
          "wide",
          "other",
        ]),
      )
      .min(1)
      .optional(),
    foregroundPresentations: z
      .array(
        z.enum([
          "face-front",
          "face-three-quarter",
          "face-profile",
          "turned-away",
          "back-of-head",
          "body-only",
          "unknown",
        ]),
      )
      .min(1)
      .optional(),
    frameModes: z.array(DialogueFrameModeSchema).min(1).optional(),
    audioIntents: z.array(DialogueAudioIntentSchema).min(1).optional(),
    audioDurationRelation: z
      .enum(["within-shot", "longer-than-shot", "unknown"])
      .optional(),
  })
  .strict()
  .superRefine((predicate, ctx) => {
    if (Object.values(predicate).every((value) => value === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "guidance requires at least one predicate",
      });
    }
  });

const GuidanceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  revision: z.number().int().min(1),
  modelId: z.string().min(1),
  providerRoute: z.string().min(1),
  /** Stable manifest endpoint/schema revision, e.g. a canonical OpenAPI hash. */
  endpointVersion: z.string().min(1),
  reviewedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.optional(),
  when: DialogueGuidancePredicateSchema,
  claims: z.array(z.literal("cadence")).optional(),
  message: z.string().min(1),
  actions: z.array(DialogueGuidanceActionSchema).min(1),
});

export const ModelDialogueGuidanceSchema = z.discriminatedUnion(
  "classification",
  [
    GuidanceBaseSchema.extend({
      classification: z.literal("validated-warning"),
      evidence: z
        .object({
          benchmarkId: z.string().min(1),
          benchmarkVersion: z.number().int().min(1),
          reportFile: z.string().min(1),
          reportHash: FullSha256Schema,
        })
        .strict(),
    }).strict(),
    GuidanceBaseSchema.extend({
      classification: z.literal("provider-guidance"),
      evidence: z
        .object({
          url: z.string().url(),
          title: z.string().min(1),
          accessedAt: IsoDateTimeSchema,
        })
        .strict(),
    }).strict(),
    GuidanceBaseSchema.extend({
      classification: z.literal("anecdotal-tip"),
      evidence: z
        .object({
          url: z.string().url(),
          title: z.string().min(1),
          accessedAt: IsoDateTimeSchema,
        })
        .strict(),
    }).strict(),
  ],
);

export type ModelDialogueGuidance = z.infer<
  typeof ModelDialogueGuidanceSchema
>;
