import { z } from "zod";
import {
  prefixedIdSchema,
  ArtifactIdSchema,
  JobIdSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  SlugSchema,
  TakeIdSchema,
} from "./ids.js";

export const FullSha256Schema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);

export const AudioUseIntentSchema = z.enum([
  "voice-reference",
  "performance-sync",
]);


export const AudioRangeSchema = z
  .object({
    inSec: z.number().finite().min(0),
    outSec: z.number().finite().positive(),
  })
  .strict()
  .superRefine((range, ctx) => {
    if (range.outSec <= range.inSec) {
      ctx.addIssue({
        code: "custom",
        path: ["outSec"],
        message: "outSec must be greater than inSec",
      });
    }
  });

export const AudioSourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("performance"), productionId: SlugSchema, performanceId: prefixedIdSchema("pf"),
    sourceMediaHash: FullSha256Schema, range: AudioRangeSchema.optional() }).strict(),
  z.object({ kind: z.literal("performance-recording"), productionId: SlugSchema, performanceId: prefixedIdSchema("pf"),
    sourceFile: z.string().min(1), sourceMediaHash: FullSha256Schema }).strict(),
  z.object({ kind: z.literal("legacy-character-sample"), sheetId: SlugSchema,
    sourceFile: z.string().min(1), legacySource: z.enum(["cloning-recording", "voice-take"]),
    legacyDesignatedAt: IsoDateTimeSchema, sourceMediaHash: FullSha256Schema, range: AudioRangeSchema.optional() }).strict(),
  z
    .object({
      kind: z.literal("artifact"),
      artifactId: ArtifactIdSchema,
      /** Existing sidecars may contain an abbreviated hash. */
      recordedArtifactHash: Sha256Schema,
      /** Immutable generation identity without importing artifact/take contracts back into audio. */
      generation: z.object({
        jobId: JobIdSchema.optional(),
        model: z.string().min(1),
        provider: z.string().min(1),
        requestHash: FullSha256Schema,
      }).strict().optional(),
      sourceMediaHash: FullSha256Schema,
      range: AudioRangeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("production-take"),
      productionId: SlugSchema,
      /** The take/range the user selected, including a virtual pass segment. */
      selectedTakeId: TakeIdSchema,
      /** The take directory that owns the physical media. */
      mediaTakeId: TakeIdSchema,
      sourceMediaHash: FullSha256Schema,
      /** Relative to selectedTakeId, not parent-pass coordinates. */
      range: AudioRangeSchema,
    })
    .strict(),
]);

export const AudioTechnicalSchema = z
  .object({
    container: z.string().min(1).nullable(),
    codec: z.string().min(1).nullable(),
    sampleFormat: z.string().min(1).nullable(),
    sampleRateHz: z.number().int().positive().nullable(),
    channels: z.number().int().positive().nullable(),
    bitDepth: z.number().int().positive().nullable(),
    durationSec: z.number().finite().min(0).nullable(),
    sizeBytes: z.number().int().min(0),
  })
  .strict();

export const AudioQcOutcomeSchema = z.enum([
  "pass",
  "informational",
  "warning",
  "hard-incompatibility",
  "unavailable",
  "not-applicable",
]);

export const AudioQcCheckSchema = z
  .object({
    outcome: AudioQcOutcomeSchema,
    /** Stable product code; UI owns explanatory prose. */
    code: z.string().min(1),
  })
  .strict();

export const AudioQcReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceHash: FullSha256Schema,
    analyzer: z
      .object({
        id: z.literal("arke-pcm-qc"),
        version: z.number().int().min(1),
        policyVersion: z.number().int().min(1),
      })
      .strict(),
    analyzedAt: IsoDateTimeSchema,
    technical: AudioTechnicalSchema,
    measurements: z
      .object({
        samplePeakDbfs: z.number().finite().nullable(),
        rmsDbfs: z.number().finite().nullable(),
        fullScaleSampleCount: z.number().int().min(0).nullable(),
        leadingSilenceSec: z.number().finite().min(0).nullable(),
        trailingSilenceSec: z.number().finite().min(0).nullable(),
        longestInternalSilenceSec: z.number().finite().min(0).nullable(),
        dcOffset: z.number().finite().nullable(),
      })
      .strict(),
    checks: z
      .object({
        decode: AudioQcCheckSchema,
        duration: AudioQcCheckSchema,
        technicalFormat: AudioQcCheckSchema,
        clipping: AudioQcCheckSchema,
        silence: AudioQcCheckSchema,
        dcOffset: AudioQcCheckSchema,
        truePeak: AudioQcCheckSchema,
        lufs: AudioQcCheckSchema,
        noiseFloor: AudioQcCheckSchema,
        snr: AudioQcCheckSchema,
        speechPresence: AudioQcCheckSchema,
        musicLikelihood: AudioQcCheckSchema,
        multipleSpeakers: AudioQcCheckSchema,
        transcriptMatch: AudioQcCheckSchema,
      })
      .strict(),
  })
  .strict();

export const AudioQcAnalysisSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("complete"),
      report: AudioQcReportSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      sourceHash: FullSha256Schema,
      analyzerId: z.literal("arke-pcm-qc"),
      analyzerVersion: z.number().int().min(1),
      policyVersion: z.number().int().min(1),
      reason: z.enum([
        "not-configured",
        "cancelled",
        "timeout",
        "process-failed",
        "output-too-large",
        "malformed-output",
        "unsupported-media",
        "source-changed",
      ]),
    })
    .strict(),
]);

const AudioSettingValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const AudioPreparationStepSchema = z
  .object({
    operation: z.enum(["extract-range", "trim", "gain", "convert"]),
    inputHash: FullSha256Schema,
    outputHash: FullSha256Schema,
    tool: z.string().min(1),
    toolVersion: z.string().min(1),
    settings: z.record(z.string(), AudioSettingValueSchema),
  })
  .strict();

export const AudioAssetProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: AudioSourceRefSchema,
    sourceTechnical: AudioTechnicalSchema,
    outputHash: FullSha256Schema,
    outputTechnical: AudioTechnicalSchema,
    preparation: z.array(AudioPreparationStepSchema),
    qualityReport: AudioQcReportSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const AudioAttestationSchema = z
  .object({
    audioHash: FullSha256Schema,
    kind: z.enum(["single-speaker", "no-music"]),
    statementVersion: z.number().int().min(1),
    acknowledgedAt: IsoDateTimeSchema,
  })
  .strict();

export const AudioRightsScopeSchema = z.enum([
  "cloud-voice-conversion",
  "cloud-reference-upload",
  "voice-cloning",
]);

export const AudioRightsEventSchema = z.discriminatedUnion("action", [
  z
    .object({
      schemaVersion: z.literal(1),
      action: z.literal("acknowledge"),
      id: z.string().min(1),
      audioHash: FullSha256Schema,
      /** User-only label/reference; never copied to app logs or provider payloads. */
      performerRef: z.string().min(1).optional(),
      basis: z.enum(["self", "authorized", "licensed"]),
      scopes: z.array(AudioRightsScopeSchema).min(1),
      statementVersion: z.number().int().min(1),
      at: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      action: z.literal("withdraw"),
      acknowledgementId: z.string().min(1),
      audioHash: FullSha256Schema,
      at: IsoDateTimeSchema,
    })
    .strict(),
]);

export type AudioQcReport = z.infer<typeof AudioQcReportSchema>;
export type AudioQcAnalysis = z.infer<typeof AudioQcAnalysisSchema>;
export type AudioAssetProvenance = z.infer<typeof AudioAssetProvenanceSchema>;

export const AudioTranscriptComparisonSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unavailable"),
      audioHash: FullSha256Schema,
      targetTextHash: FullSha256Schema,
      reason: z.enum([
        "stt-not-configured",
        "stt-failed",
        "no-authored-text",
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("compared"),
      audioHash: FullSha256Schema,
      targetTextHash: FullSha256Schema,
      transcriber: z
        .object({
          id: z.string().min(1),
          version: z.string().min(1),
          normalizationVersion: z.number().int().min(1),
        })
        .strict(),
      observedText: z.string(),
      result: z.enum(["exact", "mismatch"]),
      differences: z.array(
        z
          .object({
            kind: z.enum(["inserted", "omitted", "changed"]),
            authored: z.string(),
            observed: z.string(),
          })
          .strict(),
      ),
      boundaryAlignment: z.literal("unavailable"),
    })
    .strict(),
]);

export const AudioAssetSchema = z.object({
  file: z.string().min(1),
  hash: FullSha256Schema,
  technical: AudioTechnicalSchema,
}).strict();
export const AudioQualityUseSchema = z.object({
  sourceHash: FullSha256Schema,
  report: AudioQcReportSchema,
}).strict();
export const AudioDispatchClearanceSchema = z.object({
  audioHash: FullSha256Schema,
  scope: AudioRightsScopeSchema,
  acknowledgementId: z.string().min(1),
  statementVersion: z.number().int().positive(),
  quality: AudioQcReportSchema,
  warningCodes: z.array(z.string()),
  attestations: z.array(AudioAttestationSchema),
}).strict();
export type AudioRange = z.infer<typeof AudioRangeSchema>;
export type AudioTechnical = z.infer<typeof AudioTechnicalSchema>;
export type AudioSourceRef = z.infer<typeof AudioSourceRefSchema>;
export type AudioPreparationStep = z.infer<typeof AudioPreparationStepSchema>;
export type AudioTranscriptComparison = z.infer<typeof AudioTranscriptComparisonSchema>;
export type AudioAsset = z.infer<typeof AudioAssetSchema>;
export type AudioQualityUse = z.infer<typeof AudioQualityUseSchema>;
export type AudioDispatchClearance = z.infer<typeof AudioDispatchClearanceSchema>;
export type AudioRightsEvent = z.infer<typeof AudioRightsEventSchema>;
export type AudioRightsScope = z.infer<typeof AudioRightsScopeSchema>;
export type AudioAttestation = z.infer<typeof AudioAttestationSchema>;
export type AudioUseIntent = z.infer<typeof AudioUseIntentSchema>;

/** Host-verified ephemeral conversion input. Bytes never belong in durable job parameters. */
export interface PreparedAudioInput {
  name: string; contentType: "audio/wav" | "audio/mpeg"; hash: string; durationSec: number; data: Uint8Array;
}
