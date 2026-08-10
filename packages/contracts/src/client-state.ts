import { z } from "zod";
import { WorldChatSummarySchema, WorldChatWorkspaceSchema } from "./world-chat.js";
import { ArtifactSidecarSchema } from "./artifact.js";
import { ArtDirectionRecordSchema, ResolvedArtDirectionSchema } from "./art-direction.js";
import { ChangeRecordSchema } from "./change.js";
import { HealthStatusSchema } from "./events.js";
import { IsoDateTimeSchema, SlugSchema, UlidSchema } from "./ids.js";
import { JobSchema, LedgerEntrySchema, QueueStatusSchema } from "./job.js";
import { ModelManifestSchema } from "./manifest.js";
import { ProposalSchema, RipplePreviewSchema } from "./proposal.js";
import { ProviderStatusSchema, ProviderToolStatusSchema } from "./provider.js";
import {
  LocalRuntimeStatusSchema,
  AppearanceSettingsSchema,
  BackgroundNotificationPreferenceSchema,
  ManifestDriftSchema,
  RoutingDefaultsSchema,
  ModelAvailabilitySchema,
  RoutingFaultSchema,
  SpendStatusSchema,
} from "./settings.js";
import { SetupStatusSchema } from "./setup.js";
import { ReferenceKitSchema } from "./reference.js";
import { SceneSchema, SelectionsSchema } from "./scene.js";
import { ReviewDecisionSchema, TakeSchema } from "./take.js";
import { VoiceRuntimeStatusSchema } from "./voice.js";
import { IDLE_UPDATE_STATE, UpdateStateSchema } from "./update.js";
import { sheetDir } from "./sheet-shapes.js";
import {
  CanonEntrySchema,
  ChapterSummarySchema,
  ProductionSchema,
  SheetSchema,
  StoryOverviewSchema,
  WorldMetaSchema,
  type SheetKind,
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
    /**
     * What this proposal would change, field by field (#70 §11.5).
     *
     * Computed from the captured base and the proposed files, so the screen shows what will
     * happen rather than what a summary claims will happen.
     */
    review: z
      .object({
        targets: z.array(
          z
            .object({
              path: z.string().min(1),
              label: z.string(),
              kind: z.string(),
              action: z.enum(["create", "amend"]),
              fields: z.array(
                z
                  .object({
                    field: z.string().min(1),
                    before: z.string().nullable(),
                    proposed: z.string().nullable(),
                  })
                  .strict(),
              ),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
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
    referenceTakes: z.array(TakeSchema).default([]),
    referenceReviews: z.array(ReviewDecisionSchema).default([]),
    /** Unaccepted main-photo candidates found on disk, grouped by sheet id. */
    referenceCandidates: z.record(SlugSchema, z.array(z.string())).default({}),
    artifacts: z.array(ArtifactSidecarSchema),
    productions: z.array(ProductionBundleSchema),
    proposals: z.array(StagedProposalSchema),
    /**
     * Conversation rows only — never transcripts. Opening a world must not cost every
     * conversation ever had, so the full workspace is loaded by id when one is chosen.
     */
    conversations: z.array(WorldChatSummarySchema).default([]),
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
    /** Whether accepted key art (world-art.png) exists — the disk is the truth here too. */
    hasKeyArt: z.boolean().default(false),
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
        /**
         * Providers whose credential lives in a tool we drive rather than in `credentials.dat`
         * (issue #137). Empty until something is discovered, so a build with no such provider
         * carries nothing.
         */
        providerTools: z.array(ProviderToolStatusSchema).default([]),
        /** The shipped model manifest, whole: pickers and estimates read it locally (R-15). */
        manifest: ModelManifestSchema.nullable().default(null),
        routing: z
          .object({ defaults: RoutingDefaultsSchema, faults: z.array(RoutingFaultSchema) })
          .strict()
          .default({ defaults: {}, faults: [] }),
        /**
         * Which models this studio offers. Stored as the exceptions, so an empty list means the
         * whole manifest is on — the state a fresh install and an untouched settings file share.
         */
        models: ModelAvailabilitySchema.default({ disabled: [] }),
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
        backgroundNotifications: BackgroundNotificationPreferenceSchema.default("issues-only"),
        appearance: AppearanceSettingsSchema.default({ theme: "system" }),
        runtime: LocalRuntimeStatusSchema.nullable().default(null),
        voiceRuntime: VoiceRuntimeStatusSchema.nullable().default(null),
        drift: z.array(ManifestDriftSchema).default([]),
        /** Per-provider queue state: pauses with reasons, held counts (SPEC-009 R-8, R-11). */
        queues: z.array(QueueStatusSchema).default([]),
        /** Local-runtime setup: what is being fetched onto this machine, and how far along. */
        setup: SetupStatusSchema.nullable().default(null),
        /** Desktop-owned update lifecycle, retained so reloads cannot lose an install-ready update. */
        update: UpdateStateSchema.default(IDLE_UPDATE_STATE),
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
        /**
         * The sample world this build carries (SPEC-016 R-6). In the snapshot for the same
         * reason `env` is: whether there is one to install is settled at start-up, so a
         * Settings pane opened long afterwards can say what it knows instead of asking.
         */
        sampleWorld: z
          .object({
            available: z.boolean(),
            installing: z.boolean(),
            /** What the last attempt did, in words. Null until one has been made. */
            note: z.object({ text: z.string().min(1), refused: z.boolean() }).strict().nullable(),
          })
          .strict()
          .default({ available: false, installing: false, note: null }),
      })
      .strict(),
    worlds: z.array(WorldSummarySchema),
    /** Null until a world is opened. */
    world: WorldBundleSchema.nullable(),
    /**
     * The one conversation currently open, or null.
     *
     * Deliberately singular. A creator reads one conversation at a time, and holding every
     * transcript a world has ever had would make opening the world cost more the longer they use
     * it — the same reason the world snapshot carries conversation rows and not their contents.
     */
    worldChat: WorldChatWorkspaceSchema.nullable().default(null),
  })
  .strict();
export type ClientState = z.infer<typeof ClientStateSchema>;

// ---------------------------------------------------------------------------
// Work that has been asked for and has not landed (issue 228)
// ---------------------------------------------------------------------------

/**
 * A sheet the studio was asked to draft, between the asking and the arrival.
 *
 * The gap is real and it is long: staging the skeleton takes milliseconds, but the agent that
 * writes the sheet runs for seconds to minutes. Through all of it the sheet is in `.proposals/`
 * and not in `world.sheets`, so every list that reads `world.sheets` — Cast, Locations,
 * Factions, the hub fan — correctly showed nothing, and therefore showed its *empty state*. A
 * submitted action looked like a failed one, and the obvious response was to submit it again.
 *
 * Nothing new is recorded to fix that. The proposal is already in the snapshot the moment the
 * request lands; this reads the pending sheets back out of it.
 */
export interface PendingSheet {
  proposalId: string;
  /** What it will be called, taken from the staged file rather than from the request. */
  name: string;
  /** Where it will live once accepted, world-relative. */
  path: string;
}

/** "New location: The Bell Market" → "The Bell Market". */
function nameFromSummary(summary: string): string | null {
  const at = summary.indexOf(": ");
  const tail = at > 0 ? summary.slice(at + 2).trim() : "";
  return tail.length > 0 ? tail : null;
}

/** "locations/the-bell-market.md" → "the bell market". The last resort, never the first. */
function nameFromPath(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/i, "").replace(/-/g, " ");
}

/**
 * The sheets of one kind that are on their way (issue 228).
 *
 * Matched on the target path, because that is what decides which list a sheet lands in — the
 * summary is display copy and the slug is not a type.
 *
 * Two kinds of proposal can bring a sheet into being, and they are read differently. A
 * `new-sheet` is a creation by definition — the form staged one skeleton — so its target counts
 * even when the review could not be computed; a file that will not parse is exactly when
 * someone most needs to see that something is there, and the name degrades through the summary
 * to the slug rather than the row disappearing. A `worldbuilding` proposal is the several
 * changes one World Chat turned into, and it mixes creations with amendments freely, so only a
 * target the review calls a create counts. Without a review there is no way to tell those
 * apart, and inventing a drafting card for an edit to a sheet already in the list would double
 * it on screen.
 */
export function pendingSheets(proposals: readonly StagedProposal[], kind: SheetKind): PendingSheet[] {
  const prefix = `${sheetDir(kind)}/`;
  const pending: PendingSheet[] = [];
  for (const staged of proposals) {
    const creation = staged.proposal.kind === "new-sheet";
    if (!creation && staged.proposal.kind !== "worldbuilding") continue;
    for (const target of staged.proposal.targets) {
      if (!target.path.startsWith(prefix)) continue;
      const reviewed = staged.review?.targets.find((candidate) => candidate.path === target.path);
      if (reviewed ? reviewed.action !== "create" : !creation) continue;
      pending.push({
        proposalId: staged.proposal.id,
        name: reviewed?.label ?? nameFromSummary(staged.proposal.summary) ?? nameFromPath(target.path),
        path: target.path,
      });
    }
  }
  return pending;
}
