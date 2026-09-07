import { z } from "zod";
import { ConversationActionSemanticIdSchema } from "./arke-actions.js";
import { AudioPolicySchema, FailureModesSchema, KeyArtIntentSchema } from "./art-direction.js";
import { BenchModeSchema, BenchParamsSchema } from "./bench.js";
import { BibleEditSchema } from "./bible.js";
import { ExportPresetSchema } from "./cut.js";
import { ModelEditorRequestSchema, ModelSceneEditSchema } from "./editor-request.js";
import {
  ArtifactIdSchema,
  CandidateIdSchema,
  CanonIdSchema,
  CheckReceiptIdSchema,
  EpisodeIdSchema,
  SceneIdSchema,
  SessionIdSchema,
  SlugSchema,
  ShotIdSchema,
  TakeIdSchema,
  UlidSchema,
} from "./ids.js";
import { STAGED_REFERENCE_KEY } from "./planning.js";
import { CompilationFormatSchema, ReferenceAngleSchema } from "./reference.js";
import { CapabilitySchema } from "./provider.js";
import { ScriptBlockSchema, ShotFramingSchema } from "./scene.js";
import { SceneCommandSchema } from "./scene-operations.js";
import { AudioSpineCommandSchema } from "./spine.js";
import { SidecarFormatSchema, SubtitleOutputModeSchema } from "./subtitles.js";
import { TimelineTrackIdSchema } from "./timeline.js";
import {
  CHARACTER_ROLE_MAX,
  FrameRateSchema,
  ProductionMediumSchema,
  ProductionSchema,
  SeasonSchema,
  SeriesSchema,
  SheetKindSchema,
  SheetStatusSchema,
  WorldAuthoredFieldChangesSchema,
  ChapterImpliesWriteSchema,
} from "./world.js";

const CandidateRevisionSchema = z
  .object({ candidateId: CandidateIdSchema, revision: z.number().int().min(1) })
  .strict();

const CompleteReadIdsSchema = z.array(CheckReceiptIdSchema).min(1).max(8);
const SemanticIdsSchema = z.array(ConversationActionSemanticIdSchema).max(40);
const StagedReferenceKeySchema = z.string().min(1).max(120).regex(STAGED_REFERENCE_KEY);
const SheetSectionChangeSchema = z
  .object({ heading: z.string().min(1).max(120), body: z.string() })
  .strict();
const SettledCanonTypeSchema = z.enum(["rule", "lore", "location", "faction", "timeline", "tone"]);

const CanonChangeSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      entryType: SettledCanonTypeSchema,
      title: z.string().min(1).max(160),
      statement: z.string().trim().min(1),
      links: z.array(z.union([CanonIdSchema, SlugSchema])).default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("amend"),
      entryId: CanonIdSchema,
      changes: z
        .object({
          entryType: SettledCanonTypeSchema.optional(),
          title: z.string().min(1).max(160).optional(),
          statement: z.string().trim().min(1).optional(),
          links: z.array(z.union([CanonIdSchema, SlugSchema])).optional(),
        })
        .strict()
        .refine((changes) => Object.keys(changes).length > 0, "a Canon amendment must change at least one field"),
    })
    .strict(),
  z
    .object({
      operation: z.literal("open-thread"),
      title: z.string().min(1).max(160),
      question: z.string().trim().min(1),
      consideredEntryIds: z.array(CanonIdSchema).default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("settle-thread"),
      entryId: CanonIdSchema,
      resolvedType: SettledCanonTypeSchema,
      statement: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      operation: z.literal("set-status"),
      entryId: CanonIdSchema,
      change: z.discriminatedUnion("status", [
        z.object({ status: z.literal("open") }).strict(),
        z.object({ status: z.literal("settled"), resolvedType: SettledCanonTypeSchema }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("set-considered-entries"),
      entryId: CanonIdSchema,
      consideredEntryIds: z.array(CanonIdSchema),
    })
    .strict(),
]);

const SheetAuthoredChangesSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.string().max(CHARACTER_ROLE_MAX).nullable().optional(),
    billing: z.string().max(80).nullable().optional(),
    region: z.string().max(120).nullable().optional(),
    canonRules: z.array(CanonIdSchema).optional(),
    links: z.array(SlugSchema).optional(),
    sections: z.array(SheetSectionChangeSchema).optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "a sheet edit must change at least one field");

const SheetChangeSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      sheetType: SheetKindSchema,
      name: z.string().trim().min(1).max(120),
      role: z.string().max(CHARACTER_ROLE_MAX).optional(),
      billing: z.string().max(80).optional(),
      region: z.string().max(120).optional(),
      canonRules: z.array(CanonIdSchema).default([]),
      links: z.array(SlugSchema).default([]),
      sections: z.array(SheetSectionChangeSchema),
      /** A Production Chat guest remains a world sheet owned by that production. */
      productionId: SlugSchema.optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("edit"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      changes: SheetAuthoredChangesSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("relationship"),
      from: z.object({ sheetType: SheetKindSchema, sheetId: SlugSchema }).strict(),
      to: z.union([
        z.object({ kind: z.literal("sheet"), sheetId: SlugSchema }).strict(),
        z.object({ kind: z.literal("canon"), entryId: CanonIdSchema }).strict(),
      ]),
      linkAction: z.enum(["add", "remove"]),
      proseEdits: z
        .array(
          z
            .object({
              sheetType: SheetKindSchema,
              sheetId: SlugSchema,
              sectionHeading: z.string().min(1).max(120),
              body: z.string(),
            })
            .strict(),
        )
        .default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("rename"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      name: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      operation: z.literal("set-status"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      status: SheetStatusSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("duplicate"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      newName: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      operation: z.literal("promote-guest"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
    })
    .strict(),
]);

const ArtDirectionChangesSchema = z
  .object({
    description: z.string().trim().min(1).optional(),
    masterLook: z.enum(["keep", "clear"]).optional(),
    audio: AudioPolicySchema.optional(),
    failureModes: FailureModesSchema.optional(),
    keyArtIntent: KeyArtIntentSchema
      .refine(
        (intent) => Boolean(intent.prompt || intent.subject || intent.moment),
        "key-art intent must contain a prompt, subject or moment",
      )
      .nullable()
      .optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "an art-direction action must change at least one field");

const ArtifactMetadataChangeSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("add-links"),
      artifactId: ArtifactIdSchema,
      links: SemanticIdsSchema.min(1),
    })
    .strict(),
  z
    .object({
      operation: z.literal("set-owner"),
      artifactId: ArtifactIdSchema,
      productionId: SlugSchema.nullable(),
    })
    .strict(),
]);

const ReferenceImportSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("location-view-candidate"), sheetId: SlugSchema }).strict(),
  z.object({ operation: z.literal("main-photo-candidate"), sheetId: SlugSchema }).strict(),
  z.object({ operation: z.literal("main-photo"), sheetId: SlugSchema }).strict(),
  z.object({ operation: z.literal("character-sheet"), sheetId: SlugSchema }).strict(),
]);

const ReferenceResultUseSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("choose-anchor"),
      sheetId: SlugSchema,
      selection: z.discriminatedUnion("source", [
        z.object({ source: z.literal("take"), takeId: TakeIdSchema }).strict(),
        z.object({ source: z.literal("candidate"), candidateIndex: z.number().int().min(1) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("accept-location-view"),
      sheetId: SlugSchema,
      selection: z.discriminatedUnion("source", [
        z.object({ source: z.literal("take"), takeId: TakeIdSchema }).strict(),
        z.object({ source: z.literal("candidate"), candidateIndex: z.number().int().min(1) }).strict(),
      ]),
      name: z.string().trim().min(1).max(80),
      establishing: z.boolean().optional(),
      replaceExistingName: z.boolean().optional(),
    })
    .strict(),
  z.object({ operation: z.literal("accept-character-sheet"), sheetId: SlugSchema, takeId: TakeIdSchema }).strict(),
  z.object({ operation: z.literal("accept-character-look"), sheetId: SlugSchema, takeId: TakeIdSchema }).strict(),
]);

const ReferenceChangeSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("promote-look"), sheetId: SlugSchema, lookId: ConversationActionSemanticIdSchema }).strict(),
  z
    .object({
      operation: z.literal("attach-look"),
      sheetId: SlugSchema,
      lookId: ConversationActionSemanticIdSchema,
      scope: z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("production"), productionId: SlugSchema }).strict(),
          z.object({ kind: z.literal("scene"), productionId: SlugSchema, sceneId: ConversationActionSemanticIdSchema }).strict(),
        ])
        .nullable(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("designate-compilation"),
      sheetId: SlugSchema,
      compilation: z.object({ format: CompilationFormatSchema, compiledAt: z.string().datetime() }).strict(),
    })
    .strict(),
]);

const ReferenceGenerationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("establish-look"), sheetId: SlugSchema, count: z.number().int().min(1).max(8) }).strict(),
  z
    .object({
      operation: z.literal("location-view"),
      sheetId: SlugSchema,
      name: z.string().trim().min(1).max(80),
      prompt: z.string().trim().max(2_000).optional(),
      count: z.number().int().min(1).max(8),
      establishing: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("main-photo"),
      sheetId: SlugSchema,
      prompt: z.string().trim().min(1).max(2_000),
      count: z.number().int().min(1).max(8),
      identityReferenceIds: SemanticIdsSchema.max(4),
    })
    .strict(),
  z.object({ operation: z.literal("character-sheet"), sheetId: SlugSchema, styleOverride: z.string().trim().min(1).max(4_000).optional() }).strict(),
  z
    .object({
      operation: z.literal("character-looks"),
      sheetId: SlugSchema,
      lookKind: z.enum(["costume", "pose-expression", "condition-age"]),
      mode: z.enum(["stay-close", "push-it"]),
      prompt: z.string().trim().min(1).max(2_000),
      count: z.number().int().min(1).max(8),
    })
    .strict(),
  z.object({ operation: z.literal("missing-tiles"), sheetId: SlugSchema, group: z.enum(["head", "body"]) }).strict(),
  z.object({ operation: z.literal("regenerate-tile"), sheetId: SlugSchema, angle: ReferenceAngleSchema }).strict(),
]);

const VoiceSelectionSchema = z
  .object({
    provider: ConversationActionSemanticIdSchema,
    model: ConversationActionSemanticIdSchema,
    voiceId: ConversationActionSemanticIdSchema,
    label: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const VoiceClipReviewActionSchema = z
  .object({
    kind: z.literal("voice-clip-review"),
    productionId: SlugSchema,
    takeId: TakeIdSchema,
    review: z.discriminatedUnion("decision", [
      z.object({ decision: z.literal("accept"), shotId: ShotIdSchema }).strict(),
      z
        .object({
          decision: z.literal("reject"),
          shotId: ShotIdSchema.optional(),
          citation: z
            .object({ sheet: SlugSchema, field: z.string().trim().min(1).max(200), note: z.string().trim().min(1).max(1_000).optional() })
            .strict(),
        })
        .strict(),
    ]),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ReferenceImportActionSchema = z
  .object({ kind: z.literal("reference-import"), change: ReferenceImportSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceResultUseActionSchema = z
  .object({ kind: z.literal("reference-result-use"), change: ReferenceResultUseSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceReviewActionSchema = z
  .object({
    kind: z.literal("reference-review"),
    takeId: TakeIdSchema,
    decision: z.literal("reject"),
    field: z.string().trim().min(1).max(200),
    note: z.string().trim().min(1).max(1_000).optional(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ReferenceChangeActionSchema = z
  .object({ kind: z.literal("reference-change"), change: ReferenceChangeSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceTileLockActionSchema = z
  .object({
    kind: z.literal("reference-tile-lock"),
    sheetId: SlugSchema,
    angle: ReferenceAngleSchema,
    name: z.string().trim().min(1).max(120).optional(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ReferenceCompileActionSchema = z
  .object({ kind: z.literal("reference-compile"), sheetId: SlugSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceStyleActionSchema = z
  .object({ kind: z.literal("reference-style"), sheetId: SlugSchema, style: z.string().trim().min(1).max(500).nullable(), checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceGenerationActionSchema = z
  .object({ kind: z.literal("reference-generation"), request: ReferenceGenerationSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceImageTargetSchema = z.discriminatedUnion("surface", [
  z.object({ surface: z.literal("world-image") }).strict(),
  z.object({ surface: z.literal("master-look") }).strict(),
  z.object({ surface: z.literal("staged-reference"), key: StagedReferenceKeySchema }).strict(),
]);
const ReferenceImageImportActionSchema = z
  .object({ kind: z.literal("reference-image-import"), target: ReferenceImageTargetSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ReferenceWorldImageResultUseActionSchema = z
  .object({
    kind: z.literal("reference-world-image-result-use"),
    candidateIndex: z.number().int().min(1),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ReferenceMasterLookResultUseActionSchema = z
  .object({
    kind: z.literal("reference-master-look-result-use"),
    candidateIndex: z.number().int().min(1),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ReferenceImageDiscardActionSchema = z
  .object({ kind: z.literal("reference-image-discard"), target: ReferenceImageTargetSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();

const WorldMetadataModelActionSchema = z.object({ kind: z.literal("world-metadata"), changes: WorldAuthoredFieldChangesSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const CanonModelActionSchema = z.object({ kind: z.literal("canon"), change: CanonChangeSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const CanonRetireModelActionSchema = z.object({ kind: z.literal("canon-retire"), entryId: CanonIdSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const CanonRestoreModelActionSchema = z.object({ kind: z.literal("canon-restore"), entryId: CanonIdSchema, version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema }).strict();
const SheetModelActionSchema = z.object({ kind: z.literal("sheet"), change: SheetChangeSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const SheetRetireModelActionSchema = z.object({ kind: z.literal("sheet-retire"), sheetType: SheetKindSchema, sheetId: SlugSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const SheetRestoreModelActionSchema = z.object({ kind: z.literal("sheet-restore"), sheetType: SheetKindSchema, sheetId: SlugSchema, version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema }).strict();
const ArtDirectionModelActionSchema = z.object({ kind: z.literal("art-direction"), changes: ArtDirectionChangesSchema, checkReceiptIds: CompleteReadIdsSchema }).strict();
const ArtDirectionRestoreModelActionSchema = z.object({ kind: z.literal("art-direction-restore"), version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema }).strict();

const SeasonDefaultsSchema = z
  .object({
    episodeCount: z.number().int().min(1).optional(),
    episodeSecondsMin: z.number().positive().optional(),
    episodeSecondsMax: z.number().positive().optional(),
    hookWindowSec: z.number().positive().optional(),
    episodeEnding: z.string().min(1).optional(),
    exportPreset: z.string().min(1).optional(),
  })
  .strict();

const SeasonArcSchema = z
  .object({
    id: SlugSchema,
    title: z.string().trim().min(1).max(200),
    note: z.string().max(1_000).optional(),
    setup: EpisodeIdSchema.optional(),
    turn: EpisodeIdSchema.optional(),
    payoff: EpisodeIdSchema.optional(),
  })
  .strict();

const EpisodePromiseSchema = z
  .object({
    opens: z.string().max(1_000).optional(),
    turn: z.string().max(1_000).optional(),
    closes: z.string().max(1_000).optional(),
  })
  .strict();

const EpisodeLinkedSchema = z
  .object({ closesInto: EpisodeIdSchema.optional(), opensFrom: EpisodeIdSchema.optional() })
  .strict();

const EpisodeReleaseSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    thumbnailTakeId: TakeIdSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    recap: z.string().optional(),
    teaser: z.string().optional(),
    crops: z.array(z.object({ label: z.string().min(1), aspect: z.string().min(1) }).strict()).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const SceneInheritsSchema = z
  .object({
    location: SlugSchema.optional(),
    timeOfDay: z.string().optional(),
    tone: z.string().optional(),
  })
  .strict();

const ScriptBlocksSchema = z.array(ScriptBlockSchema).max(200).superRefine((blocks, context) => {
  const seen = new Set<string>();
  for (const [index, block] of blocks.entries()) {
    if (seen.has(block.id)) {
      context.addIssue({ code: "custom", path: [index, "id"], message: "script block ids must be unique" });
    }
    seen.add(block.id);
  }
});

const ProductionCreateModelActionSchema = z
  .object({
    kind: z.literal("production-create"),
    production: z
      .object({
        title: z.string().trim().min(1).max(200),
        medium: ProductionMediumSchema,
        productionKind: z.string().trim().min(1).max(120).optional(),
        seriesTitle: z.string().trim().min(1).max(200).optional(),
        aspect: z.string().trim().min(1).max(20).optional(),
        frameRate: FrameRateSchema.optional(),
        defaults: SeasonDefaultsSchema.optional(),
        logline: z.string().trim().min(1).max(1_000).optional(),
      })
      .strict(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ProductionMetadataChangesSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    medium: ProductionMediumSchema.optional(),
    productionKind: z.string().trim().min(1).max(120).nullable().optional(),
    seriesId: SlugSchema.nullable().optional(),
    status: z.string().trim().min(1).max(120).optional(),
    aspect: z.string().trim().min(1).max(20).optional(),
    frameRate: FrameRateSchema.optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "a production metadata action must change at least one field");

const ProductionMetadataModelActionSchema = z
  .object({
    kind: z.literal("production-metadata"),
    productionId: SlugSchema,
    changes: ProductionMetadataChangesSchema,
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ProductionModelModelActionSchema = z
  .object({
    kind: z.literal("production-model"),
    productionId: SlugSchema,
    capability: CapabilitySchema,
    modelId: z.string().min(1).nullable(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ProductionSeriesModelActionSchema = z
  .object({
    kind: z.literal("production-series"),
    productionId: SlugSchema,
    change: z.discriminatedUnion("operation", [
      z
        .object({
          operation: z.literal("create"),
          title: z.string().trim().min(1).max(200),
          engine: z.string().trim().min(1).max(4_000).optional(),
          continuity: z.string().trim().min(1).max(4_000).optional(),
          seasons: z.array(SlugSchema).default([]),
        })
        .strict(),
      z
        .object({
          operation: z.literal("edit"),
          seriesId: SlugSchema,
          changes: z
            .object({
              title: z.string().trim().min(1).max(200).optional(),
              engine: z.string().trim().min(1).max(4_000).nullable().optional(),
              continuity: z.string().trim().min(1).max(4_000).nullable().optional(),
              seasons: z.array(SlugSchema).optional(),
            })
            .strict()
            .refine((changes) => Object.keys(changes).length > 0, "a Series edit must change at least one field"),
        })
        .strict(),
    ]),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ProductionOverviewModelActionSchema = z
  .object({
    kind: z.literal("production-overview"),
    productionId: SlugSchema,
    changes: z
      .object({
        logline: z.string().min(1).max(1_000).nullable().optional(),
        spine: z.string().min(1).max(4_000).nullable().optional(),
        acts: z.array(z.object({ title: z.string().min(1).max(200), summary: z.string().max(2_000).optional() }).strict()).max(20).nullable().optional(),
        targetLength: z.string().min(1).max(120).nullable().optional(),
      })
      .strict()
      .refine((changes) => Object.keys(changes).length > 0, "an overview action must change at least one field"),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ProductionSeasonModelActionSchema = z
  .object({
    kind: z.literal("production-season"),
    productionId: SlugSchema,
    changes: z
      .object({
        question: z.string().min(1).max(1_000).nullable().optional(),
        ending: z.string().min(1).max(2_000).nullable().optional(),
        direction: z.string().min(1).max(4_000).nullable().optional(),
        arcs: z.array(SeasonArcSchema).max(40).nullable().optional(),
        defaults: SeasonDefaultsSchema.nullable().optional(),
      })
      .strict()
      .refine((changes) => Object.keys(changes).length > 0, "a season action must change at least one field"),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ProductionEpisodeModelActionSchema = z
  .object({
    kind: z.literal("production-episode"),
    productionId: SlugSchema,
    change: z.discriminatedUnion("operation", [
      z
        .object({
          operation: z.literal("create"),
          title: z.string().trim().min(1).max(200),
          order: z.number().int().min(1).optional(),
          promise: EpisodePromiseSchema.optional(),
          scenes: z.array(SceneIdSchema).default([]),
          linked: EpisodeLinkedSchema.optional(),
          release: EpisodeReleaseSchema.optional(),
        })
        .strict(),
      z
        .object({
          operation: z.literal("edit"),
          episodeId: EpisodeIdSchema,
          changes: z
            .object({
              title: z.string().trim().min(1).max(200).optional(),
              order: z.number().int().min(1).optional(),
              promise: EpisodePromiseSchema.nullable().optional(),
              scenes: z.array(SceneIdSchema).optional(),
              linked: EpisodeLinkedSchema.nullable().optional(),
              release: EpisodeReleaseSchema.nullable().optional(),
            })
            .strict()
            .refine((changes) => Object.keys(changes).length > 0, "an episode edit must change at least one field"),
        })
        .strict(),
    ]),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ChapterDrawsSchema = z
  .object({ sheets: z.array(SlugSchema), canon: z.array(CanonIdSchema) })
  .strict();

const ProductionChapterModelActionSchema = z
  .object({
    kind: z.literal("production-chapter"),
    productionId: SlugSchema,
    change: z.discriminatedUnion("operation", [
      z
        .object({
          operation: z.literal("create"),
          title: z.string().trim().min(1).max(200),
          order: z.number().int().min(1),
          body: z.string(),
          status: z.string().trim().min(1).max(120).default("planned"),
          draws: ChapterDrawsSchema.optional(),
          synopsis: z.string().trim().max(600).optional().describe("What this chapter is for, in a line or two; it steers the draft and the accepted draft keeps it."),
          pov: SlugSchema.optional().describe("The character sheet whose point of view the chapter holds."),
          when: z.string().trim().max(80).optional().describe("Story-time, in the story's own words."),
          implies: ChapterImpliesWriteSchema.optional().describe(
            "Facts about the world this prose implies but the world does not yet hold, each a kind and one sentence. They are listed on the chapter for the author to propose separately; this action never writes them into the world.",
          ),
        })
        .strict(),
      z
        .object({
          operation: z.literal("edit"),
          chapterId: SlugSchema,
          changes: z
            .object({
              title: z.string().trim().min(1).max(200).optional(),
              status: z.string().trim().min(1).max(120).optional(),
              body: z.string().optional(),
              draws: ChapterDrawsSchema.nullable().optional(),
              synopsis: z.string().trim().max(600).nullable().optional(),
              pov: SlugSchema.nullable().optional(),
              when: z.string().trim().max(80).nullable().optional(),
              implies: ChapterImpliesWriteSchema.nullable().optional().describe(
                "Facts about the world this prose implies but the world does not yet hold; listed on the chapter for the author to propose, never written into the world by this action.",
              ),
              /*
               * A revision is a passage, never a chapter (turn 128): one span quoted exactly
               * from the live body and the words that replace it. The coordinator applies it
               * when the draft is staged and refuses by name unless `find` occurs exactly once,
               * so the staged file is the whole chapter with one span changed and the card says so.
               */
              passage: z
                .object({
                  find: z.string().min(1).max(1_200).describe("The passage to replace, quoted exactly as the chapter holds it."),
                  with: z.string().max(2_400).describe("The words that take its place; empty removes the passage."),
                  paragraph: z.number().int().min(1).optional().describe(
                    "The paragraph the passage is in, counted from 1 by blank lines, when the ask named it (About this passage in chapter 07, paragraph 3). The passage is looked for there and only there. Without it the passage must occur exactly once in the chapter.",
                  ),
                })
                .strict()
                .optional()
                .describe(
                  "Replace one passage and nothing else. Use this for any change smaller than the chapter — a sentence tightened, a paragraph recast — instead of resending the body. Never with body.",
                ),
            })
            .strict()
            .refine((changes) => Object.keys(changes).length > 0, "a chapter edit must change at least one field")
            .refine((changes) => changes.body === undefined || changes.passage === undefined, "a chapter edit carries a body or a passage, never both")
            // A passage travels alone (codex, round four): the card says only the span is written,
            // so a status or a synopsis riding beside it would be a change the card did not show.
            .refine((changes) => changes.passage === undefined || Object.keys(changes).length === 1, "a passage travels alone: an edit that carries one carries nothing else"),
        })
        .strict(),
    ]),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ProductionSceneModelActionSchema = z
  .object({
    kind: z.literal("production-scene"),
    productionId: SlugSchema,
    change: z.discriminatedUnion("operation", [
      z
        .object({
          operation: z.literal("create"),
          title: z.string().trim().min(1).max(200),
          episodeId: EpisodeIdSchema.optional(),
          synopsis: z.string().max(2_000).optional(),
          status: z.string().trim().min(1).max(120).default("draft"),
          inherits: SceneInheritsSchema.optional(),
          defaults: ShotFramingSchema.optional(),
          scriptBlocks: ScriptBlocksSchema.optional(),
        })
        .strict(),
      z
        .object({
          operation: z.literal("edit"),
          sceneId: SceneIdSchema,
          changes: z
            .object({
              title: z.string().trim().min(1).max(200).optional(),
              synopsis: z.string().max(2_000).nullable().optional(),
              status: z.string().trim().min(1).max(120).optional(),
              inherits: SceneInheritsSchema.nullable().optional(),
              defaults: ShotFramingSchema.nullable().optional(),
            })
            .strict()
            .refine((changes) => Object.keys(changes).length > 0, "a scene edit must change at least one field"),
        })
        .strict(),
      z
        .object({ operation: z.literal("replace-script"), sceneId: SceneIdSchema, blocks: ScriptBlocksSchema })
        .strict(),
    ]),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ProductionEpisodeOrderModelActionSchema = z
  .object({ kind: z.literal("production-episode-order"), productionId: SlugSchema, orderedIds: z.array(EpisodeIdSchema).min(1), checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ProductionChapterOrderModelActionSchema = z
  .object({ kind: z.literal("production-chapter-order"), productionId: SlugSchema, orderedIds: z.array(SlugSchema).min(1), checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ProductionSceneOrderModelActionSchema = z
  .object({ kind: z.literal("production-scene-order"), productionId: SlugSchema, orderedIds: z.array(SceneIdSchema).min(1), checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ProductionSceneDeleteModelActionSchema = z
  .object({ kind: z.literal("production-scene-delete"), productionId: SlugSchema, sceneId: SceneIdSchema, checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ProductionSceneRestoreModelActionSchema = z
  .object({ kind: z.literal("production-scene-restore"), productionId: SlugSchema, sceneId: SceneIdSchema, version: z.number().int().min(1), checkReceiptIds: CompleteReadIdsSchema })
  .strict();
const ProductionStyleModelActionSchema = z
  .object({
    kind: z.literal("production-style"),
    productionId: SlugSchema,
    style: z.string().trim().min(1).max(4_000).nullable(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

/**
 * The style the book is written in (turn 128), settled in Develop the way the overview is and
 * kept in `prose-style.json` beside it. `production-style` is the look of a filmed production;
 * this is the prose. Each field clears with null; the sizes are turn 128's.
 */
const ProductionProseStyleModelActionSchema = z
  .object({
    kind: z.literal("production-prose-style"),
    productionId: SlugSchema,
    changes: z
      .object({
        pov: z.string().trim().min(1).max(120).nullable().optional().describe("first, close third, omniscient, or the author's own words."),
        tense: z.string().trim().min(1).max(40).nullable().optional(),
        voice: z.string().trim().min(1).max(2_000).nullable().optional().describe("How the sentences go: length, what comes before feeling, what a metaphor may draw on, how dialogue behaves."),
        samples: z.array(z.string().trim().min(1).max(1_200)).max(6).nullable().optional().describe("Passages that sound like the book, quoted from it or written for it."),
      })
      .strict()
      .refine((changes) => Object.keys(changes).length > 0, "a prose style action must change at least one field"),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

const ProductionSceneCommandModelActionSchema = z
  .object({
    kind: z.literal("production-scene-command"),
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
    command: SceneCommandSchema,
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ProductionBoardCompileModelActionSchema = z
  .object({
    kind: z.literal("production-board-compile"),
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
export const ProductionBoardExportModelActionSchema = z
  .object({
    kind: z.literal("production-board-export"),
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ProductionTakeImportModelActionSchema = z
  .object({
    kind: z.literal("production-take-import"),
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
    shotId: ShotIdSchema,
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ProductionTakeGenerationModelActionSchema = z
  .object({
    kind: z.literal("production-take-generation"),
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("shot"), shotId: ShotIdSchema }).strict(),
      z.object({ kind: z.literal("board"), memberShotIds: z.array(ShotIdSchema).min(1) }).strict(),
    ]),
    mode: z.enum(["image", "video"]),
    retakeOf: TakeIdSchema.optional(),
    instruction: z.string().trim().min(1).max(2_000).optional(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ProductionTakeReviewModelActionSchema = z
  .object({
    kind: z.literal("production-take-review"),
    productionId: SlugSchema,
    takeId: TakeIdSchema,
    review: z.discriminatedUnion("decision", [
      z.object({ decision: z.literal("accept"), shotId: ShotIdSchema }).strict(),
      z
        .object({
          decision: z.literal("reject"),
          shotId: ShotIdSchema.optional(),
          citation: z
            .object({
              sheet: SlugSchema,
              field: z.string().trim().min(1).max(200),
              note: z.string().trim().min(1).max(1_000).optional(),
            })
            .strict(),
        })
        .strict(),
    ]),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ProductionTakeTrimModelActionSchema = z
  .object({
    kind: z.literal("production-take-trim"),
    productionId: SlugSchema,
    shotId: ShotIdSchema,
    takeId: TakeIdSchema,
    trimInSec: z.number().min(0),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
const ProductionStageConstructModelActionSchema = z.object({
  kind: z.literal("production-stage-construct"), productionId: SlugSchema, sceneId: SceneIdSchema, shotId: ShotIdSchema,
  instruction: z.string().max(4000), preserve: z.enum(["blocking", "camera", "none"]), checkReceiptIds: CompleteReadIdsSchema,
}).strict();
const ProductionStagePlayblastModelActionSchema = z
  .object({
    kind: z.literal("production-stage-playblast"),
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
    shotId: ShotIdSchema,
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
export const AudioSpineModelActionSchema = z
  .object({
    kind: z.literal("audio-spine-command"),
    productionId: SlugSchema,
    /** Null creates the first spine; every other command names the exact live revision. */
    baseRevision: z.number().int().min(1).nullable(),
    command: AudioSpineCommandSchema,
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
export type AudioSpineModelAction = z.infer<typeof AudioSpineModelActionSchema>;

const RoutingChoiceIdSchema = z.string().regex(/^ch_[a-z0-9-]+$/, "expected ch_<slug>");
const RoutingGroupIdSchema = z.string().regex(/^grp_[a-z0-9-]+$/, "expected grp_<slug>");
const NonEmptyRoutingChangesSchema = <T extends z.ZodRawShape>(shape: T, message: string) =>
  z.object(shape).strict().refine((changes) => Object.keys(changes).length > 0, message);

/** Closed semantic edits replace the legacy whole-routing JSON submission. */
export const RoutingCommandSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("set-start"), sceneId: SceneIdSchema }).strict(),
  z
    .object({
      operation: z.literal("add-choice"),
      choice: z.object({ id: RoutingChoiceIdSchema, from: SceneIdSchema, label: z.string().trim().min(1), to: SceneIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("edit-choice"),
      choiceId: RoutingChoiceIdSchema,
      changes: NonEmptyRoutingChangesSchema(
        { from: SceneIdSchema.optional(), label: z.string().trim().min(1).optional(), to: SceneIdSchema.optional() },
        "a choice edit must change at least one field",
      ),
    })
    .strict(),
  z.object({ operation: z.literal("remove-choice"), choiceId: RoutingChoiceIdSchema }).strict(),
  z.object({ operation: z.literal("set-ending"), sceneId: SceneIdSchema, title: z.string().trim().min(1) }).strict(),
  z.object({ operation: z.literal("clear-ending"), sceneId: SceneIdSchema }).strict(),
  z.object({ operation: z.literal("exclude-scene"), sceneId: SceneIdSchema, reason: z.string().trim().min(1) }).strict(),
  z.object({ operation: z.literal("include-scene"), sceneId: SceneIdSchema }).strict(),
  z
    .object({
      operation: z.literal("add-group"),
      group: z.object({ id: RoutingGroupIdSchema, title: z.string().trim().min(1), scenes: z.array(SceneIdSchema) }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("edit-group"),
      groupId: RoutingGroupIdSchema,
      changes: NonEmptyRoutingChangesSchema(
        { title: z.string().trim().min(1).optional(), scenes: z.array(SceneIdSchema).optional() },
        "a group edit must change at least one field",
      ),
    })
    .strict(),
  z.object({ operation: z.literal("remove-group"), groupId: RoutingGroupIdSchema }).strict(),
]);
export type RoutingCommand = z.infer<typeof RoutingCommandSchema>;

export const ProductionRoutingModelActionSchema = z
  .object({
    kind: z.literal("production-routing"),
    productionId: SlugSchema,
    command: RoutingCommandSchema,
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
export const ProductionTraversalModelActionSchema = z
  .object({
    kind: z.literal("production-routing-traversal"),
    productionId: SlugSchema,
    choiceId: RoutingChoiceIdSchema,
    from: SceneIdSchema,
    to: SceneIdSchema,
    route: z.array(SceneIdSchema).min(1),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
export const ProductionBranchCanonModelActionSchema = z
  .object({
    kind: z.literal("production-branch-canon"),
    productionId: SlugSchema,
    sceneId: SceneIdSchema,
    route: z.array(SceneIdSchema).min(1),
    title: z.string().trim().min(1).max(160),
    body: z.string().trim().min(1),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
export const ProductionInteractiveExportModelActionSchema = z
  .object({
    kind: z.literal("production-interactive-export"),
    productionId: SlugSchema,
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
export const ProductionCutExportModelActionSchema = z
  .object({
    kind: z.literal("production-cut-export"),
    productionId: SlugSchema,
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("production") }).strict(),
      z.object({ kind: z.literal("episode"), episodeId: EpisodeIdSchema }).strict(),
    ]),
    preset: ExportPresetSchema,
    subtitles: z
      .object({
        trackId: TimelineTrackIdSchema,
        mode: SubtitleOutputModeSchema,
        sidecar: SidecarFormatSchema.optional(),
      })
      .strict()
      .optional(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
export const ProductionExportCancelModelActionSchema = z
  .object({
    kind: z.literal("production-export-cancel"),
    productionId: SlugSchema,
    exportId: z.string().regex(/^ex_[0-9A-HJKMNP-TV-Z]{26}$/),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();
export const BenchGenerationModelActionSchema = z
  .object({
    kind: z.literal("bench-generation"),
    sessionId: SessionIdSchema,
    composer: z
      .object({
        mode: BenchModeSchema,
        provider: z.string().trim().min(1).max(200),
        model: z.string().trim().min(1).max(300),
        params: BenchParamsSchema,
        brief: z.string().max(100_000),
      })
      .strict(),
    checkReceiptIds: CompleteReadIdsSchema,
  })
  .strict();

export const ModelWorldChatActionSchema = z.discriminatedUnion("kind", [
  WorldMetadataModelActionSchema,
  CanonModelActionSchema,
  CanonRetireModelActionSchema,
  CanonRestoreModelActionSchema,
  SheetModelActionSchema,
  SheetRetireModelActionSchema,
  SheetRestoreModelActionSchema,
  ArtDirectionModelActionSchema,
  ArtDirectionRestoreModelActionSchema,
  z
    .object({
      kind: z.literal("artifact-import"),
      source: z.enum(["files", "folder"]),
      links: SemanticIdsSchema.default([]),
      productionId: SlugSchema.nullable().optional(),
      allowLarge: z.boolean().optional(),
      supersedes: ArtifactIdSchema.optional(),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  z.object({ kind: z.literal("artifact-metadata"), change: ArtifactMetadataChangeSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("artifact-extraction"), artifactId: ArtifactIdSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("artifact-extraction-stop"), artifactId: ArtifactIdSchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z
    .object({
      kind: z.literal("artifact-extraction-review"),
      artifactId: ArtifactIdSchema,
      candidateHash: z.string().regex(/^[a-f0-9]{16}$/),
      decision: z.enum(["accept", "reject"]),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  z.object({ kind: z.literal("artifact-reference"), artifactId: ArtifactIdSchema, key: StagedReferenceKeySchema, checkReceiptIds: CompleteReadIdsSchema }).strict(),
  ReferenceImportActionSchema,
  ReferenceResultUseActionSchema,
  ReferenceReviewActionSchema,
  ReferenceChangeActionSchema,
  ReferenceTileLockActionSchema,
  ReferenceCompileActionSchema,
  ReferenceStyleActionSchema,
  ReferenceGenerationActionSchema,
  ReferenceImageImportActionSchema,
  ReferenceWorldImageResultUseActionSchema,
  ReferenceMasterLookResultUseActionSchema,
  ReferenceImageDiscardActionSchema,
  z
    .object({
      kind: z.literal("voice-assignment"),
      sheetType: SheetKindSchema,
      sheetId: SlugSchema,
      voice: VoiceSelectionSchema.nullable(),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("voice-audition"),
      sheetId: SlugSchema,
      voice: VoiceSelectionSchema,
      text: z.string().trim().min(1).max(2_000).optional(),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("voice-clone"),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().min(1).max(1_000),
      sheetId: SlugSchema.optional(),
      recordingGesture: z.literal("required"),
      checkReceiptIds: CompleteReadIdsSchema,
    })
    .strict(),
  VoiceClipReviewActionSchema,
  z.object({ kind: z.literal("world-archive"), checkReceiptIds: CompleteReadIdsSchema }).strict(),
  z.object({ kind: z.literal("world-export"), checkReceiptIds: CompleteReadIdsSchema }).strict(),
  ProductionCreateModelActionSchema,
  ProductionMetadataModelActionSchema,
  ProductionModelModelActionSchema,
  ProductionSeriesModelActionSchema,
  ProductionOverviewModelActionSchema,
  ProductionSeasonModelActionSchema,
  ProductionEpisodeModelActionSchema,
  ProductionChapterModelActionSchema,
  ProductionSceneModelActionSchema,
  ProductionEpisodeOrderModelActionSchema,
  ProductionChapterOrderModelActionSchema,
  ProductionSceneOrderModelActionSchema,
  ProductionSceneDeleteModelActionSchema,
  ProductionSceneRestoreModelActionSchema,
  ProductionStyleModelActionSchema,
  ProductionProseStyleModelActionSchema,
  ProductionSceneCommandModelActionSchema,
  ProductionBoardCompileModelActionSchema,
  ProductionBoardExportModelActionSchema,
  ProductionTakeImportModelActionSchema,
  ProductionTakeGenerationModelActionSchema,
  ProductionTakeReviewModelActionSchema,
  ProductionTakeTrimModelActionSchema,
  ProductionStagePlayblastModelActionSchema,
  ProductionStageConstructModelActionSchema,
  AudioSpineModelActionSchema,
  ProductionRoutingModelActionSchema,
  ProductionTraversalModelActionSchema,
  ProductionBranchCanonModelActionSchema,
  ProductionInteractiveExportModelActionSchema,
  ProductionCutExportModelActionSchema,
  ProductionExportCancelModelActionSchema,
  BenchGenerationModelActionSchema,
]);
export type ModelWorldChatAction = z.infer<typeof ModelWorldChatActionSchema>;

const preparedAction = <K extends string, T extends z.ZodTypeAny>(kind: K, action: T) => z
  .object({ kind: z.literal(kind), worldId: UlidSchema, productionId: SlugSchema.optional(), action })
  .strict();

export const WorldChatWorldMetadataActionSchema = preparedAction(
  "world-chat-world-metadata",
  WorldMetadataModelActionSchema,
);
export const WorldChatCanonActionSchema = preparedAction("world-chat-canon", CanonModelActionSchema);
export const WorldChatCanonRetireActionSchema = preparedAction("world-chat-canon-retire", CanonRetireModelActionSchema);
export const WorldChatCanonRestoreActionSchema = preparedAction("world-chat-canon-restore", CanonRestoreModelActionSchema);
export const WorldChatSheetActionSchema = preparedAction("world-chat-sheet", SheetModelActionSchema);
export const WorldChatSheetRetireActionSchema = preparedAction("world-chat-sheet-retire", SheetRetireModelActionSchema);
export const WorldChatSheetRestoreActionSchema = preparedAction("world-chat-sheet-restore", SheetRestoreModelActionSchema);
export const WorldChatArtDirectionActionSchema = preparedAction("world-chat-art-direction", ArtDirectionModelActionSchema);
export const WorldChatArtDirectionRestoreActionSchema = preparedAction("world-chat-art-direction-restore", ArtDirectionRestoreModelActionSchema);
export const WorldChatArtifactImportActionSchema = preparedAction("world-chat-artifact-import", ModelWorldChatActionSchema.options[9]);
export const WorldChatArtifactMetadataActionSchema = preparedAction("world-chat-artifact-metadata", ModelWorldChatActionSchema.options[10]);
export const WorldChatArtifactExtractionActionSchema = preparedAction("world-chat-artifact-extraction", ModelWorldChatActionSchema.options[11]);
export const WorldChatArtifactExtractionStopActionSchema = preparedAction("world-chat-artifact-extraction-stop", ModelWorldChatActionSchema.options[12]);
export const WorldChatArtifactExtractionReviewActionSchema = preparedAction("world-chat-artifact-extraction-review", ModelWorldChatActionSchema.options[13]);
export const WorldChatArtifactReferenceActionSchema = preparedAction("world-chat-artifact-reference", ModelWorldChatActionSchema.options[14]);
export const WorldChatReferenceImportActionSchema = preparedAction("world-chat-reference-import", ReferenceImportActionSchema);
export const WorldChatReferenceResultUseActionSchema = preparedAction("world-chat-reference-result-use", ReferenceResultUseActionSchema);
export const WorldChatReferenceReviewActionSchema = preparedAction("world-chat-reference-review", ReferenceReviewActionSchema);
export const WorldChatReferenceChangeActionSchema = preparedAction("world-chat-reference-change", ReferenceChangeActionSchema);
export const WorldChatReferenceTileLockActionSchema = preparedAction("world-chat-reference-tile-lock", ReferenceTileLockActionSchema);
export const WorldChatReferenceCompileActionSchema = preparedAction("world-chat-reference-compile", ReferenceCompileActionSchema);
export const WorldChatReferenceStyleActionSchema = preparedAction("world-chat-reference-style", ReferenceStyleActionSchema);
export const WorldChatReferenceGenerationActionSchema = preparedAction("world-chat-reference-generation", ReferenceGenerationActionSchema);
export const WorldChatReferenceImageImportActionSchema = preparedAction("world-chat-reference-image-import", ReferenceImageImportActionSchema);
export const WorldChatReferenceWorldImageResultUseActionSchema = preparedAction("world-chat-reference-world-image-result-use", ReferenceWorldImageResultUseActionSchema);
export const WorldChatReferenceMasterLookResultUseActionSchema = preparedAction("world-chat-reference-master-look-result-use", ReferenceMasterLookResultUseActionSchema);
export const WorldChatReferenceImageDiscardActionSchema = preparedAction("world-chat-reference-image-discard", ReferenceImageDiscardActionSchema);
export const WorldChatVoiceAssignmentActionSchema = preparedAction("world-chat-voice-assignment", ModelWorldChatActionSchema.options[27]);
export const WorldChatVoiceAuditionActionSchema = preparedAction("world-chat-voice-audition", ModelWorldChatActionSchema.options[28]);
export const WorldChatVoiceCloneActionSchema = preparedAction("world-chat-voice-clone", ModelWorldChatActionSchema.options[29]);
export const WorldChatVoiceClipReviewActionSchema = preparedAction("world-chat-voice-clip-review", VoiceClipReviewActionSchema);
export const WorldChatWorldArchiveActionSchema = preparedAction("world-chat-world-archive", ModelWorldChatActionSchema.options[31]);
export const WorldChatWorldExportActionSchema = preparedAction("world-chat-world-export", ModelWorldChatActionSchema.options[32]);
export const ProductionCreationPlanSchema = z
  .object({
    production: ProductionSchema,
    initialSeason: SeasonSchema.nullable(),
    series: z.discriminatedUnion("operation", [
      z.object({ operation: z.literal("none") }).strict(),
      z.object({ operation: z.literal("create"), record: SeriesSchema }).strict(),
      z.object({ operation: z.literal("join"), record: SeriesSchema }).strict(),
    ]),
  })
  .strict();
export type ProductionCreationPlan = z.infer<typeof ProductionCreationPlanSchema>;

export const WorldChatProductionCreateActionSchema = z
  .object({
    kind: z.literal("world-chat-production-create"),
    worldId: UlidSchema,
    action: ProductionCreateModelActionSchema,
    plan: ProductionCreationPlanSchema,
  })
  .strict();
export const WorldChatProductionMetadataActionSchema = preparedAction("world-chat-production-metadata", ProductionMetadataModelActionSchema);
export const WorldChatProductionModelActionSchema = preparedAction("world-chat-production-model", ProductionModelModelActionSchema);
export const WorldChatProductionSeriesActionSchema = preparedAction("world-chat-production-series", ProductionSeriesModelActionSchema);
export const WorldChatProductionOverviewActionSchema = preparedAction("world-chat-production-overview", ProductionOverviewModelActionSchema);
export const WorldChatProductionProseStyleActionSchema = preparedAction("world-chat-production-prose-style", ProductionProseStyleModelActionSchema);
export const WorldChatProductionSeasonActionSchema = preparedAction("world-chat-production-season", ProductionSeasonModelActionSchema);
export const WorldChatProductionEpisodeActionSchema = preparedAction("world-chat-production-episode", ProductionEpisodeModelActionSchema);
export const WorldChatProductionChapterActionSchema = preparedAction("world-chat-production-chapter", ProductionChapterModelActionSchema);
export const WorldChatProductionSceneActionSchema = preparedAction("world-chat-production-scene", ProductionSceneModelActionSchema);
export const WorldChatProductionEpisodeOrderActionSchema = preparedAction("world-chat-production-episode-order", ProductionEpisodeOrderModelActionSchema);
export const WorldChatProductionChapterOrderActionSchema = preparedAction("world-chat-production-chapter-order", ProductionChapterOrderModelActionSchema);
export const WorldChatProductionSceneOrderActionSchema = preparedAction("world-chat-production-scene-order", ProductionSceneOrderModelActionSchema);
export const WorldChatProductionSceneDeleteActionSchema = preparedAction("world-chat-production-scene-delete", ProductionSceneDeleteModelActionSchema);
export const WorldChatProductionSceneRestoreActionSchema = preparedAction("world-chat-production-scene-restore", ProductionSceneRestoreModelActionSchema);
export const WorldChatProductionStyleActionSchema = preparedAction("world-chat-production-style", ProductionStyleModelActionSchema);
export const WorldChatProductionSceneCommandActionSchema = preparedAction("world-chat-production-scene-command", ProductionSceneCommandModelActionSchema);
export const WorldChatProductionBoardCompileActionSchema = preparedAction("world-chat-production-board-compile", ProductionBoardCompileModelActionSchema);
export const WorldChatProductionBoardExportActionSchema = preparedAction("world-chat-production-board-export", ProductionBoardExportModelActionSchema);
export const WorldChatProductionTakeImportActionSchema = preparedAction("world-chat-production-take-import", ProductionTakeImportModelActionSchema);
export const WorldChatProductionTakeGenerationActionSchema = preparedAction("world-chat-production-take-generation", ProductionTakeGenerationModelActionSchema);
export const WorldChatProductionTakeReviewActionSchema = preparedAction("world-chat-production-take-review", ProductionTakeReviewModelActionSchema);
export const WorldChatProductionTakeTrimActionSchema = preparedAction("world-chat-production-take-trim", ProductionTakeTrimModelActionSchema);
export const WorldChatProductionStageConstructActionSchema = preparedAction("world-chat-production-stage-construct", ProductionStageConstructModelActionSchema);
export const WorldChatProductionStagePlayblastActionSchema = preparedAction("world-chat-production-stage-playblast", ProductionStagePlayblastModelActionSchema);
export const WorldChatAudioSpineActionSchema = preparedAction("world-chat-audio-spine-command", AudioSpineModelActionSchema);
export const WorldChatProductionRoutingActionSchema = preparedAction("world-chat-production-routing", ProductionRoutingModelActionSchema);
export const WorldChatProductionTraversalActionSchema = preparedAction("world-chat-production-routing-traversal", ProductionTraversalModelActionSchema);
export const WorldChatProductionBranchCanonActionSchema = preparedAction("world-chat-production-branch-canon", ProductionBranchCanonModelActionSchema);
export const WorldChatProductionInteractiveExportActionSchema = preparedAction("world-chat-production-interactive-export", ProductionInteractiveExportModelActionSchema);
export const WorldChatProductionCutExportActionSchema = preparedAction("world-chat-production-cut-export", ProductionCutExportModelActionSchema);
export const WorldChatProductionExportCancelActionSchema = preparedAction("world-chat-production-export-cancel", ProductionExportCancelModelActionSchema);
export const WorldChatBenchGenerationActionSchema = preparedAction("world-chat-bench-generation", BenchGenerationModelActionSchema);

export type WorldChatWorldMetadataAction = z.infer<typeof WorldChatWorldMetadataActionSchema>;
export type WorldChatCanonAction = z.infer<typeof WorldChatCanonActionSchema>;
export type WorldChatCanonRetireAction = z.infer<typeof WorldChatCanonRetireActionSchema>;
export type WorldChatCanonRestoreAction = z.infer<typeof WorldChatCanonRestoreActionSchema>;
export type WorldChatSheetAction = z.infer<typeof WorldChatSheetActionSchema>;
export type WorldChatSheetRetireAction = z.infer<typeof WorldChatSheetRetireActionSchema>;
export type WorldChatSheetRestoreAction = z.infer<typeof WorldChatSheetRestoreActionSchema>;
export type WorldChatArtDirectionAction = z.infer<typeof WorldChatArtDirectionActionSchema>;
export type WorldChatArtDirectionRestoreAction = z.infer<typeof WorldChatArtDirectionRestoreActionSchema>;
export type WorldChatArtifactImportAction = z.infer<typeof WorldChatArtifactImportActionSchema>;
export type WorldChatArtifactMetadataAction = z.infer<typeof WorldChatArtifactMetadataActionSchema>;
export type WorldChatArtifactExtractionAction = z.infer<typeof WorldChatArtifactExtractionActionSchema>;
export type WorldChatArtifactExtractionStopAction = z.infer<typeof WorldChatArtifactExtractionStopActionSchema>;
export type WorldChatArtifactExtractionReviewAction = z.infer<typeof WorldChatArtifactExtractionReviewActionSchema>;
export type WorldChatArtifactReferenceAction = z.infer<typeof WorldChatArtifactReferenceActionSchema>;
export type WorldChatReferenceImportAction = z.infer<typeof WorldChatReferenceImportActionSchema>;
export type WorldChatReferenceResultUseAction = z.infer<typeof WorldChatReferenceResultUseActionSchema>;
export type WorldChatReferenceReviewAction = z.infer<typeof WorldChatReferenceReviewActionSchema>;
export type WorldChatReferenceChangeAction = z.infer<typeof WorldChatReferenceChangeActionSchema>;
export type WorldChatReferenceTileLockAction = z.infer<typeof WorldChatReferenceTileLockActionSchema>;
export type WorldChatReferenceCompileAction = z.infer<typeof WorldChatReferenceCompileActionSchema>;
export type WorldChatReferenceStyleAction = z.infer<typeof WorldChatReferenceStyleActionSchema>;
export type WorldChatReferenceGenerationAction = z.infer<typeof WorldChatReferenceGenerationActionSchema>;
export type WorldChatReferenceImageImportAction = z.infer<typeof WorldChatReferenceImageImportActionSchema>;
export type WorldChatReferenceWorldImageResultUseAction = z.infer<typeof WorldChatReferenceWorldImageResultUseActionSchema>;
export type WorldChatReferenceMasterLookResultUseAction = z.infer<typeof WorldChatReferenceMasterLookResultUseActionSchema>;
export type WorldChatReferenceImageDiscardAction = z.infer<typeof WorldChatReferenceImageDiscardActionSchema>;
export type WorldChatVoiceAssignmentAction = z.infer<typeof WorldChatVoiceAssignmentActionSchema>;
export type WorldChatVoiceAuditionAction = z.infer<typeof WorldChatVoiceAuditionActionSchema>;
export type WorldChatVoiceCloneAction = z.infer<typeof WorldChatVoiceCloneActionSchema>;
export type WorldChatVoiceClipReviewAction = z.infer<typeof WorldChatVoiceClipReviewActionSchema>;
export type WorldChatWorldArchiveAction = z.infer<typeof WorldChatWorldArchiveActionSchema>;
export type WorldChatWorldExportAction = z.infer<typeof WorldChatWorldExportActionSchema>;
export type WorldChatProductionCreateAction = z.infer<typeof WorldChatProductionCreateActionSchema>;
export type WorldChatProductionMetadataAction = z.infer<typeof WorldChatProductionMetadataActionSchema>;
export type WorldChatProductionModelAction = z.infer<typeof WorldChatProductionModelActionSchema>;
export type WorldChatProductionSeriesAction = z.infer<typeof WorldChatProductionSeriesActionSchema>;
export type WorldChatProductionOverviewAction = z.infer<typeof WorldChatProductionOverviewActionSchema>;
export type WorldChatProductionProseStyleAction = z.infer<typeof WorldChatProductionProseStyleActionSchema>;
export type WorldChatProductionSeasonAction = z.infer<typeof WorldChatProductionSeasonActionSchema>;
export type WorldChatProductionEpisodeAction = z.infer<typeof WorldChatProductionEpisodeActionSchema>;
export type WorldChatProductionChapterAction = z.infer<typeof WorldChatProductionChapterActionSchema>;
export type WorldChatProductionSceneAction = z.infer<typeof WorldChatProductionSceneActionSchema>;
export type WorldChatProductionEpisodeOrderAction = z.infer<typeof WorldChatProductionEpisodeOrderActionSchema>;
export type WorldChatProductionChapterOrderAction = z.infer<typeof WorldChatProductionChapterOrderActionSchema>;
export type WorldChatProductionSceneOrderAction = z.infer<typeof WorldChatProductionSceneOrderActionSchema>;
export type WorldChatProductionSceneDeleteAction = z.infer<typeof WorldChatProductionSceneDeleteActionSchema>;
export type WorldChatProductionSceneRestoreAction = z.infer<typeof WorldChatProductionSceneRestoreActionSchema>;
export type WorldChatProductionStyleAction = z.infer<typeof WorldChatProductionStyleActionSchema>;
export type WorldChatProductionSceneCommandAction = z.infer<typeof WorldChatProductionSceneCommandActionSchema>;
export type WorldChatProductionBoardCompileAction = z.infer<typeof WorldChatProductionBoardCompileActionSchema>;
export type WorldChatProductionBoardExportAction = z.infer<typeof WorldChatProductionBoardExportActionSchema>;
export type WorldChatProductionTakeImportAction = z.infer<typeof WorldChatProductionTakeImportActionSchema>;
export type WorldChatProductionTakeGenerationAction = z.infer<typeof WorldChatProductionTakeGenerationActionSchema>;
export type WorldChatProductionTakeReviewAction = z.infer<typeof WorldChatProductionTakeReviewActionSchema>;
export type WorldChatProductionTakeTrimAction = z.infer<typeof WorldChatProductionTakeTrimActionSchema>;
export type WorldChatProductionStagePlayblastAction = z.infer<typeof WorldChatProductionStagePlayblastActionSchema>;
export type WorldChatAudioSpineAction = z.infer<typeof WorldChatAudioSpineActionSchema>;
export type WorldChatProductionRoutingAction = z.infer<typeof WorldChatProductionRoutingActionSchema>;
export type WorldChatProductionTraversalAction = z.infer<typeof WorldChatProductionTraversalActionSchema>;
export type WorldChatProductionBranchCanonAction = z.infer<typeof WorldChatProductionBranchCanonActionSchema>;
export type WorldChatProductionInteractiveExportAction = z.infer<typeof WorldChatProductionInteractiveExportActionSchema>;
export type WorldChatProductionCutExportAction = z.infer<typeof WorldChatProductionCutExportActionSchema>;
export type WorldChatProductionExportCancelAction = z.infer<typeof WorldChatProductionExportCancelActionSchema>;
export type WorldChatBenchGenerationAction = z.infer<typeof WorldChatBenchGenerationActionSchema>;

/** Existing World Chat outputs after coordinator validation, before an authority prepares them. */
export const WorldChatProposalActionSchema = z
  .object({
    kind: z.literal("world-chat-proposal"),
    worldId: UlidSchema,
    candidate: CandidateRevisionSchema,
    members: z.array(CandidateRevisionSchema).min(1),
  })
  .strict();
export type WorldChatProposalAction = z.infer<typeof WorldChatProposalActionSchema>;

export const WorldChatBibleActionSchema = z
  .object({
    kind: z.literal("world-chat-bible-edit"),
    worldId: UlidSchema,
    baseVersion: z.number().int().min(1),
    edits: z.array(BibleEditSchema).min(1),
  })
  .strict();
export type WorldChatBibleAction = z.infer<typeof WorldChatBibleActionSchema>;

export const WorldChatSceneActionSchema = z
  .object({
    kind: z.literal("world-chat-scene-edit"),
    worldId: UlidSchema,
    productionId: SlugSchema,
    sceneId: z.string().min(1),
    baseVersion: z.number().int().min(1),
    edit: ModelSceneEditSchema,
  })
  .strict();
export type WorldChatSceneAction = z.infer<typeof WorldChatSceneActionSchema>;

export const WorldChatEditorRequestActionSchema = z
  .object({
    kind: z.literal("world-chat-editor-request"),
    worldId: UlidSchema,
    productionId: SlugSchema,
    request: ModelEditorRequestSchema,
  })
  .strict();
export type WorldChatEditorRequestAction = z.infer<typeof WorldChatEditorRequestActionSchema>;

export const WorldChatPreparedActionSchema = z.discriminatedUnion("kind", [
  WorldChatProposalActionSchema,
  WorldChatBibleActionSchema,
  WorldChatSceneActionSchema,
  WorldChatEditorRequestActionSchema,
  WorldChatWorldMetadataActionSchema,
  WorldChatCanonActionSchema,
  WorldChatCanonRetireActionSchema,
  WorldChatCanonRestoreActionSchema,
  WorldChatSheetActionSchema,
  WorldChatSheetRetireActionSchema,
  WorldChatSheetRestoreActionSchema,
  WorldChatArtDirectionActionSchema,
  WorldChatArtDirectionRestoreActionSchema,
  WorldChatArtifactImportActionSchema,
  WorldChatArtifactMetadataActionSchema,
  WorldChatArtifactExtractionActionSchema,
  WorldChatArtifactExtractionStopActionSchema,
  WorldChatArtifactExtractionReviewActionSchema,
  WorldChatArtifactReferenceActionSchema,
  WorldChatReferenceImportActionSchema,
  WorldChatReferenceResultUseActionSchema,
  WorldChatReferenceReviewActionSchema,
  WorldChatReferenceChangeActionSchema,
  WorldChatReferenceTileLockActionSchema,
  WorldChatReferenceCompileActionSchema,
  WorldChatReferenceStyleActionSchema,
  WorldChatReferenceGenerationActionSchema,
  WorldChatReferenceImageImportActionSchema,
  WorldChatReferenceWorldImageResultUseActionSchema,
  WorldChatReferenceMasterLookResultUseActionSchema,
  WorldChatReferenceImageDiscardActionSchema,
  WorldChatVoiceAssignmentActionSchema,
  WorldChatVoiceAuditionActionSchema,
  WorldChatVoiceCloneActionSchema,
  WorldChatVoiceClipReviewActionSchema,
  WorldChatWorldArchiveActionSchema,
  WorldChatWorldExportActionSchema,
  WorldChatProductionCreateActionSchema,
  WorldChatProductionMetadataActionSchema,
  WorldChatProductionModelActionSchema,
  WorldChatProductionSeriesActionSchema,
  WorldChatProductionOverviewActionSchema,
  WorldChatProductionProseStyleActionSchema,
  WorldChatProductionSeasonActionSchema,
  WorldChatProductionEpisodeActionSchema,
  WorldChatProductionChapterActionSchema,
  WorldChatProductionSceneActionSchema,
  WorldChatProductionEpisodeOrderActionSchema,
  WorldChatProductionChapterOrderActionSchema,
  WorldChatProductionSceneOrderActionSchema,
  WorldChatProductionSceneDeleteActionSchema,
  WorldChatProductionSceneRestoreActionSchema,
  WorldChatProductionStyleActionSchema,
  WorldChatProductionSceneCommandActionSchema,
  WorldChatProductionBoardCompileActionSchema,
  WorldChatProductionBoardExportActionSchema,
  WorldChatProductionTakeImportActionSchema,
  WorldChatProductionTakeGenerationActionSchema,
  WorldChatProductionTakeReviewActionSchema,
  WorldChatProductionTakeTrimActionSchema,
  WorldChatProductionStagePlayblastActionSchema,
  WorldChatProductionStageConstructActionSchema,
  WorldChatAudioSpineActionSchema,
  WorldChatProductionRoutingActionSchema,
  WorldChatProductionTraversalActionSchema,
  WorldChatProductionBranchCanonActionSchema,
  WorldChatProductionInteractiveExportActionSchema,
  WorldChatProductionCutExportActionSchema,
  WorldChatProductionExportCancelActionSchema,
  WorldChatBenchGenerationActionSchema,
]);
export type WorldChatPreparedAction = z.infer<typeof WorldChatPreparedActionSchema>;
