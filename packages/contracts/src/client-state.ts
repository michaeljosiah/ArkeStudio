import { z } from "zod";
import { ArtifactSidecarSchema } from "./artifact.js";
import { ChangeRecordSchema } from "./change.js";
import { HealthStatusSchema } from "./events.js";
import { IsoDateTimeSchema, SlugSchema, UlidSchema } from "./ids.js";
import { JobSchema, LedgerEntrySchema } from "./job.js";
import { ModelManifestSchema } from "./manifest.js";
import { ProposalSchema, RipplePreviewSchema } from "./proposal.js";
import { ProviderStatusSchema } from "./provider.js";
import {
  LocalRuntimeStatusSchema,
  ManifestDriftSchema,
  RoutingDefaultsSchema,
  RoutingFaultSchema,
  SpendStatusSchema,
} from "./settings.js";
import { ReferenceKitSchema } from "./reference.js";
import { SceneSchema, SelectionsSchema } from "./scene.js";
import { ReviewDecisionSchema, TakeSchema } from "./take.js";
import {
  CanonEntrySchema,
  ChapterSummarySchema,
  ProductionSchema,
  SheetSchema,
  StoryOverviewSchema,
  WorldMetaSchema,
} from "./world.js";

/**
 * The read model the client renders (SPEC-001 §2.6). One snapshot shape; events fold into it.
 * View state (which tab, which panel) never lives here — this is world and app state only.
 */

export const ComponentHealthSchema = z
  .object({
    status: HealthStatusSchema,
    reason: z.string().optional(),
  })
  .strict();
export type ComponentHealth = z.infer<typeof ComponentHealthSchema>;

export const AppHealthSchema = z
  .object({
    coordinator: ComponentHealthSchema,
    harness: ComponentHealthSchema,
    voice: ComponentHealthSchema,
  })
  .strict();
export type AppHealth = z.infer<typeof AppHealthSchema>;

/** What the world picker lists without loading the full bundle. */
export const WorldSummarySchema = z
  .object({
    worldId: UlidSchema,
    slug: SlugSchema,
    name: z.string().min(1),
    logline: z.string().optional(),
    counts: z
      .object({
        characters: z.number().int().min(0),
        locations: z.number().int().min(0),
        factions: z.number().int().min(0),
        canonEntries: z.number().int().min(0),
        productions: z.number().int().min(0),
      })
      .strict(),
    updated: IsoDateTimeSchema,
  })
  .strict();
export type WorldSummary = z.infer<typeof WorldSummarySchema>;

/** A production with everything its screens render. */
export const ProductionBundleSchema = z
  .object({
    meta: ProductionSchema,
    story: StoryOverviewSchema.nullable(),
    /** story.md — freeform treatment / script prose, per format (§2.2). */
    treatment: z.string().nullable(),
    chapters: z.array(ChapterSummarySchema),
    scenes: z.array(SceneSchema),
    takes: z.array(TakeSchema),
    reviews: z.array(ReviewDecisionSchema),
    selections: SelectionsSchema,
  })
  .strict();
export type ProductionBundle = z.infer<typeof ProductionBundleSchema>;

/** A staged proposal plus its advisory ripple preview, as the panel renders it. */
export const StagedProposalSchema = z
  .object({
    proposal: ProposalSchema,
    ripple: RipplePreviewSchema.nullable(),
  })
  .strict();
export type StagedProposal = z.infer<typeof StagedProposalSchema>;

/** A file that failed to parse — the world still opens; the failure is named (SPEC-002 R-2). */
export const WorldProblemSchema = z
  .object({
    path: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type WorldProblem = z.infer<typeof WorldProblemSchema>;

/** A file changed while the world was closed, awaiting explicit reconciliation (SPEC-002 R-28). */
export const ExternalEditSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["modified", "created", "deleted"]),
  })
  .strict();
export type ExternalEdit = z.infer<typeof ExternalEditSchema>;

/** The open world, in full — a world is small enough to send whole (SPEC-001 D4). */
export const WorldBundleSchema = z
  .object({
    meta: WorldMetaSchema,
    sheets: z.array(SheetSchema),
    canon: z.array(CanonEntrySchema),
    referenceKits: z.array(ReferenceKitSchema),
    artifacts: z.array(ArtifactSidecarSchema),
    productions: z.array(ProductionBundleSchema),
    proposals: z.array(StagedProposalSchema),
    /** Recent tail of changes.jsonl, newest last. */
    changes: z.array(ChangeRecordSchema),
    /** Files that failed to parse; the valid entities are still usable (SPEC-002 R-2). */
    problems: z.array(WorldProblemSchema).default([]),
    /** Closed-world edits awaiting reconciliation (SPEC-002 R-28). */
    externalEdits: z.array(ExternalEditSchema).default([]),
    /** Set when another program changed files while the world was open (SPEC-002 R-23). */
    stale: z.boolean().default(false),
  })
  .strict();
export type WorldBundle = z.infer<typeof WorldBundleSchema>;

export const ClientStateSchema = z
  .object({
    app: z
      .object({
        version: z.string(),
        health: AppHealthSchema,
        jobs: z.array(JobSchema),
        ledger: z.array(LedgerEntrySchema),
        /** Provider configuration as Settings renders it — never key material (SPEC-008 R-6). */
        providers: z.array(ProviderStatusSchema).default([]),
        /** The shipped model manifest, whole: pickers and estimates read it locally (R-15). */
        manifest: ModelManifestSchema.nullable().default(null),
        routing: z
          .object({ defaults: RoutingDefaultsSchema, faults: z.array(RoutingFaultSchema) })
          .strict()
          .default({ defaults: {}, faults: [] }),
        spend: SpendStatusSchema.nullable().default(null),
        runtime: LocalRuntimeStatusSchema.nullable().default(null),
        drift: z.array(ManifestDriftSchema).default([]),
      })
      .strict(),
    worlds: z.array(WorldSummarySchema),
    /** Null until a world is opened. */
    world: WorldBundleSchema.nullable(),
  })
  .strict();
export type ClientState = z.infer<typeof ClientStateSchema>;
