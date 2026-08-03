import { z } from "zod";
import { ArtifactSidecarSchema } from "./artifact.js";
import { ArtDirectionRecordSchema, ResolvedArtDirectionSchema } from "./art-direction.js";
import { ChangeRecordSchema } from "./change.js";
import { HealthStatusSchema } from "./events.js";
import { IsoDateTimeSchema, SlugSchema, UlidSchema } from "./ids.js";
import { JobSchema, LedgerEntrySchema, QueueStatusSchema } from "./job.js";
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
import { SetupStatusSchema } from "./setup.js";
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
    /**
     * Needs-you counts for a CLOSED world (SPEC-014 R-7, D4): computed when the world last
     * passed through, labelled as-of that time, never presented as current. The open world's
     * items are precise and come from its bundle instead.
     */
    attention: z
      .object({
        unreviewedTakes: z.number().int().min(0),
        openProposals: z.number().int().min(0),
        asOf: IsoDateTimeSchema,
      })
      .strict()
      .optional(),
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
    /** Present for art-direction proposals so review renders the proposed record, not a guess. */
    artDirection: ArtDirectionRecordSchema.optional(),
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
    artDirection: ResolvedArtDirectionSchema,
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
    /**
     * A generated key image waiting for a yes, world-relative. Read from the disk, because the
     * disk is the truth: deriving it from the job record made the offer come back on every
     * visit, over a file that had already been used or thrown away.
     */
    keyArtCandidate: z.string().nullable().default(null),
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
        /**
         * The agent roster as it will actually run: the shipped brief, the user's override if
         * there is one, and the model each will use. The screen never has to guess which of the
         * two is in force, because both are here.
         */
        agents: z
          .array(
            z
              .object({
                name: z.string().min(1),
                description: z.string().min(1),
                shippedBrief: z.string().min(1),
                brief: z.string().min(1),
                /** Absent → whatever the harness is configured with. */
                model: z.string().min(1).optional(),
                edited: z.boolean(),
              })
              .strict(),
          )
          .default([]),
        /** What the harness says it can run, when it has been asked. Empty until then. */
        harnessModels: z
          .array(
            z
              .object({
                id: z.string(),
                provider: z.string(),
                displayName: z.string().optional(),
                isDefault: z.boolean().optional(),
              })
              .strict(),
          )
          .default([]),
        spend: SpendStatusSchema.nullable().default(null),
        runtime: LocalRuntimeStatusSchema.nullable().default(null),
        drift: z.array(ManifestDriftSchema).default([]),
        /** Per-provider queue state: pauses with reasons, held counts (SPEC-009 R-8, R-11). */
        queues: z.array(QueueStatusSchema).default([]),
        /** Local-runtime setup: what is being fetched onto this machine, and how far along. */
        setup: SetupStatusSchema.nullable().default(null),
        /**
         * First-run environment verification (SPEC-016 R-2). It lives in the snapshot, not only
         * in its event: the check runs once at start-up — before the window exists in a packaged
         * build — so a client that connects afterwards would otherwise never learn the outcome.
         */
        env: z
          .object({
            pathBudgetOk: z.boolean(),
            pathBudgetDetail: z.string().nullable(),
            diskFreeMb: z.number().nullable(),
            nativeIndexOk: z.boolean(),
            nativeIndexDetail: z.string().nullable(),
          })
          .strict()
          .nullable()
          .default(null),
      })
      .strict(),
    worlds: z.array(WorldSummarySchema),
    /** Null until a world is opened. */
    world: WorldBundleSchema.nullable(),
  })
  .strict();
export type ClientState = z.infer<typeof ClientStateSchema>;
