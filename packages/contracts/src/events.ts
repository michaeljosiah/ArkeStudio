import { z } from "zod";
import { AskCandidateSchema, AskResultSchema } from "./ask.js";
import { ChangeRecordSchema } from "./change.js";
import { IsoDateTimeSchema, ProposalIdSchema, ShotIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { JobSchema, LedgerEntrySchema } from "./job.js";
import { ProviderStatusSchema } from "./provider.js";
import { ShotSelectionSchema } from "./scene.js";
import {
  LocalRuntimeStatusSchema,
  ManifestDriftSchema,
  RoutingDefaultsSchema,
  RoutingFaultSchema,
  SpendStatusSchema,
} from "./settings.js";
import { ReviewDecisionSchema, TakeSchema } from "./take.js";

/**
 * The normalised domain-event union (SPEC-001 R-2, R-3). Everything the coordinator pushes to
 * clients after the snapshot is one of these, schema-validated at the boundary — a malformed
 * event fails loudly rather than propagating a partial object.
 */

export const HealthComponentSchema = z.enum(["coordinator", "harness", "voice"]);
export type HealthComponent = z.infer<typeof HealthComponentSchema>;

export const HealthStatusSchema = z.enum(["starting", "healthy", "unhealthy", "unavailable"]);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

const base = { at: IsoDateTimeSchema };

export const DomainEventSchema = z.discriminatedUnion("type", [
  /** A world was opened into the coordinator; the follow-up snapshot carries its bundle. */
  z.object({ ...base, type: z.literal("world.opened"), worldId: UlidSchema }).strict(),
  z.object({ ...base, type: z.literal("world.closed"), worldId: UlidSchema }).strict(),

  /** Mirror of a changes.jsonl append — an accepted mutation to a world entity (§2.5). */
  z
    .object({ ...base, type: z.literal("entity.changed"), worldId: UlidSchema, change: ChangeRecordSchema })
    .strict(),

  /** The world canon revision advanced (accepting any canon change increments once, §2.4). */
  z
    .object({ ...base, type: z.literal("canon.revision.advanced"), worldId: UlidSchema, revision: z.number().int() })
    .strict(),

  z
    .object({
      ...base,
      type: z.literal("proposal.staged"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("proposal.resolved"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
      outcome: z.enum(["accepted", "discarded"]),
    })
    .strict(),

  /** An accept did not land; the reason is stated and the client decides what to offer (SPEC-004). */
  z
    .object({
      ...base,
      type: z.literal("proposal.blocked"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
      reason: z.enum(["stale", "needs-reconfirm", "no-op", "pending-review", "unresolved-conflicts", "target-retired"]),
      detail: z.string().optional(),
      /** On needs-reconfirm: the authoritative set and its signature to echo back (R-10). */
      authoritativeSignature: z.string().optional(),
    })
    .strict(),

  /** Full row on every transition — jobs are small and the client never patches by hand. */
  z.object({ ...base, type: z.literal("job.updated"), job: JobSchema }).strict(),

  z
    .object({
      ...base,
      type: z.literal("take.recorded"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      take: TakeSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("review.recorded"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      review: ReviewDecisionSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("selection.changed"),
      worldId: UlidSchema,
      productionId: SlugSchema,
      shotId: ShotIdSchema,
      selection: ShotSelectionSchema,
    })
    .strict(),

  z.object({ ...base, type: z.literal("ledger.appended"), entry: LedgerEntrySchema }).strict(),

  /** Provider configuration or validation changed — the full set, never a patch (SPEC-008 R-2, R-3). */
  z.object({ ...base, type: z.literal("provider.status"), providers: z.array(ProviderStatusSchema) }).strict(),
  /** Routing defaults or their faults changed (SPEC-008 R-20, §2.7). */
  z
    .object({
      ...base,
      type: z.literal("routing.changed"),
      routing: RoutingDefaultsSchema,
      faults: z.array(RoutingFaultSchema),
    })
    .strict(),
  /** Rolling spend re-evaluated on a ledger append or a settings change (SPEC-008 R-19, D10). */
  z.object({ ...base, type: z.literal("spend.status"), spend: SpendStatusSchema }).strict(),
  /** Local runtime detection completed (SPEC-008 R-22, D12). */
  z.object({ ...base, type: z.literal("runtime.status"), runtime: LocalRuntimeStatusSchema }).strict(),
  /** Estimate-versus-actual divergence crossed the drift threshold (SPEC-008 R-13, §2.11). */
  z.object({ ...base, type: z.literal("manifest.drift"), reports: z.array(ManifestDriftSchema) }).strict(),

  /** Another program changed world files while open — reload required, never merged (SPEC-002 R-23). */
  z.object({ ...base, type: z.literal("world.stale"), worldId: UlidSchema }).strict(),

  /** Agent progress in product language: canon checks, drafting steps (SPEC-005 R-15). */
  z
    .object({
      ...base,
      type: z.literal("authoring.progress"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
      line: z.string().min(1),
    })
    .strict(),
  /** Authoring session lifecycle over a proposal — endings always carry a reason (SPEC-005 R-13). */
  z
    .object({
      ...base,
      type: z.literal("authoring.status"),
      worldId: UlidSchema,
      proposalId: ProposalIdSchema,
      status: z.enum(["running", "completed", "cancelled", "timeout", "budget-exceeded", "failed"]),
      detail: z.string().optional(),
    })
    .strict(),

  /** A grounded answer, a refusal with receipts, or honest unavailability (SPEC-006). */
  z
    .object({
      ...base,
      type: z.literal("canon.answer"),
      worldId: UlidSchema,
      askId: z.string().min(1),
      result: AskResultSchema,
    })
    .strict(),
  /** List-search results over the same retrieval path (SPEC-006 R-18). */
  z
    .object({
      ...base,
      type: z.literal("canon.search"),
      worldId: UlidSchema,
      searchId: z.string().min(1),
      searched: z.number().int().min(0),
      floorCleared: z.boolean(),
      candidates: z.array(AskCandidateSchema),
    })
    .strict(),
  /** An entry's computed detail: cited-by and speculative ripples (SPEC-006 §2.5). */
  z
    .object({
      ...base,
      type: z.literal("canon.refs"),
      worldId: UlidSchema,
      entryId: z.string().min(1),
      citedBy: z.object({
        sheets: z.array(z.object({ id: z.string(), atVersion: z.number().nullable() }).strict()),
        entries: z.array(z.string()),
        productions: z.array(z.string()),
      }).strict(),
      ripples: z.array(z.object({ kind: z.string(), summary: z.string(), targets: z.array(z.string()) }).strict()),
    })
    .strict(),

  /** A sheet's computed detail: refs, versions cited, incoming links (SPEC-007 R-4, R-16). */
  z
    .object({
      ...base,
      type: z.literal("sheet.refs"),
      worldId: UlidSchema,
      sheetId: z.string().min(1),
      tiles: z.number().int().min(0),
      productions: z.array(z.string()),
      artifacts: z.array(z.string()),
      scenes: z.array(z.string()),
      takesByVersion: z.record(z.string(), z.number().int()),
      /** Sheets that link here — reverse lookup from the index, never a second stored edge. */
      incomingLinks: z.array(z.string()),
    })
    .strict(),

  /** A harness permission backstop prompt, in Studio's language (SPEC-005 R-16, R-17). */
  z
    .object({
      ...base,
      type: z.literal("permission.pending"),
      permissionId: z.string().min(1),
      /** What the agent is asking to do, already translated for the user. */
      description: z.string().min(1),
      actionClass: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("permission.settled"),
      permissionId: z.string().min(1),
      decision: z.enum(["once", "always", "reject"]),
      /** True when a remembered grant answered without prompting; recorded, revocable. */
      remembered: z.boolean(),
    })
    .strict(),

  /** Supervised-child and harness health — what powers degraded mode (SPEC-001 R-6). */
  z
    .object({
      ...base,
      type: z.literal("health.changed"),
      component: HealthComponentSchema,
      status: HealthStatusSchema,
      reason: z.string().optional(),
    })
    .strict(),
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
