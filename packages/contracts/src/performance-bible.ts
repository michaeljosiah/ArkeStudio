import { z } from "zod";
import { IsoDateTimeSchema, SlugSchema } from "./ids.js";
import { FullSha256Schema } from "./audio.js";
import { PerformanceIdSchema } from "./performance.js";
import { PerformanceDeliverySchema } from "./voice.js";
export const PerformanceReferenceRoleSchema = z.enum(["cadence", "identity", "both"]);
const base = { slotId: SlugSchema, revision: z.number().int().positive(), at: IsoDateTimeSchema };
export const PerformanceBibleEventSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("designate"), label: z.string().trim().min(1).max(80), delivery: PerformanceDeliverySchema,
    role: PerformanceReferenceRoleSchema, productionId: SlugSchema, performanceId: PerformanceIdSchema,
    performanceHash: FullSha256Schema, acceptedReviewAt: IsoDateTimeSchema }).strict(),
  z.object({ ...base, action: z.literal("clear") }).strict(),
]);
export type PerformanceBibleEvent = z.infer<typeof PerformanceBibleEventSchema>;
export const PerformanceBibleStateSchema = z.object({ sheetId: SlugSchema, events: z.array(PerformanceBibleEventSchema), hash: z.string().nullable(), problem: z.string().optional() }).strict();
export function foldPerformanceBible(events: readonly PerformanceBibleEvent[]) {
  const slots = new Map<string, PerformanceBibleEvent>();
  for (const event of events) {
    const previous = slots.get(event.slotId);
    if (event.revision !== (previous?.revision ?? 0) + 1) throw new Error("Performance bible has conflicting revisions.");
    slots.set(event.slotId, event);
  }
  return [...slots.values()].sort((a, b) => a.slotId.localeCompare(b.slotId));
}
/** Eligibility is supplied by the current QC/rights/source resolver, never inferred from a slot label. */
export function recommendPerformanceBible(events: readonly PerformanceBibleEvent[], delivery: string | undefined, eligibleSlotIds: readonly string[]) {
  if (!delivery) return [];
  return foldPerformanceBible(events).filter(event => event.action === "designate" && event.delivery === delivery && eligibleSlotIds.includes(event.slotId));
}
