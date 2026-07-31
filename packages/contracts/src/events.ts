import { z } from "zod";
import { ChangeRecordSchema } from "./change.js";
import { IsoDateTimeSchema, ProposalIdSchema, ShotIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { JobSchema, LedgerEntrySchema } from "./job.js";
import { ShotSelectionSchema } from "./scene.js";
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
