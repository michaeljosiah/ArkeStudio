import { z } from "zod";
import { SlugSchema, UlidSchema } from "./ids.js";
import { ActualCostSourceSchema } from "./take.js";
import type { BenchRequestSnapshot } from "./bench.js";

const Money = z.number().int().min(0).safe();
export const SpendCoverageSchema = z.enum(["empty", "complete", "partial", "unavailable"]);
export const SpendSourceSchema = z.union([ActualCostSourceSchema, z.enum(["estimated", "unknown-actual", "unavailable"])]);
export const ProductionWorkSchema = z.object({
  productionId: SlugSchema,
  sceneId: z.string().min(1),
  kind: z.enum(["video", "frame"]),
  shots: z.array(z.object({ shotId: z.string().min(1), durationSec: z.number().finite().positive(), takeId: z.string().min(1) }).strict()).min(1),
}).strict();
export type ProductionWork = z.infer<typeof ProductionWorkSchema>;

/** Frozen before enqueue, so deleted Bench sessions cannot erase an attempt's ownership (#250). */
export function benchProductionWork(request: BenchRequestSnapshot): ProductionWork | null {
  const filing = request.filing;
  if (!filing || (request.mode !== "image" && request.mode !== "video")) return null;
  return {
    productionId: filing.productionId, sceneId: filing.sceneId,
    kind: request.mode === "video" ? "video" : "frame",
    shots: filing.kind === "board"
      ? filing.members.map(member => ({ shotId: member.shotId, durationSec: member.endSec - member.startSec, takeId: member.takeId }))
      : [{ shotId: filing.shotId, durationSec: 1, takeId: filing.productionTakeId }],
  };
}

export const SpendProblemSchema = z.enum(["ledger-unreadable", "history-unreadable", "history-incomplete", "bench-incomplete", "allocation-missing", "counts-incomplete", "amount-overflow"]);
export const ProductionSpendSummarySchema = z.object({
  spentMicroUsd: Money.nullable(),
  unallocatedMicroUsd: Money,
  coverage: SpendCoverageSchema,
  generated: z.number().int().min(0),
  selected: z.number().int().min(0),
  countsPartial: z.boolean(),
  localRuns: z.number().int().min(0),
  sources: z.array(z.object({ source: SpendSourceSchema, entries: z.number().int().min(0), microUsd: Money }).strict()),
  problems: z.array(SpendProblemSchema),
}).strict();
export type ProductionSpendSummary = z.infer<typeof ProductionSpendSummarySchema>;

export const ProductionSpendReceiptSchema = z.object({
  jobId: z.string().min(1),
  sceneId: z.string().optional(),
  kind: z.enum(["video", "frame", "unknown"]),
  provider: z.string(), model: z.string(),
  outcome: z.enum(["succeeded", "failed", "cancelled", "pending", "unknown"]),
  source: SpendSourceSchema,
  /** Additional billed money only; null means no authoritative amount is available. */
  microUsd: Money.nullable(),
  /** The original amount remains separate for allowance records. */
  recordedMicroUsd: Money.nullable(),
  shots: z.array(z.object({ shotId: z.string(), durationSec: z.number().finite().positive(), microUsd: Money.nullable() }).strict()),
  unallocatedMicroUsd: Money,
}).strict();
export type ProductionSpendReceipt = z.infer<typeof ProductionSpendReceiptSchema>;
export const ProductionSpendRollupSchema = z.object({
  total: ProductionSpendSummarySchema,
  scenes: z.record(z.string(), ProductionSpendSummarySchema),
  shots: z.record(z.string(), ProductionSpendSummarySchema),
  receipts: z.array(ProductionSpendReceiptSchema),
}).strict();
export type ProductionSpendRollup = z.infer<typeof ProductionSpendRollupSchema>;
export const ProductionSpendProjectionSchema = z.object({
  worldId: UlidSchema,
  productions: z.record(SlugSchema, ProductionSpendRollupSchema),
}).strict();
export type ProductionSpendProjection = z.infer<typeof ProductionSpendProjectionSchema>;
