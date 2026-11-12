import { z } from "zod";

export const STORAGE_CATEGORIES = ["artifacts", "takes", "publications", "models", "downloads", "temporary", "other"] as const;
export type StorageCategory = typeof STORAGE_CATEGORIES[number];
export const STORAGE_CATEGORY_LABELS: Record<StorageCategory, string> = {
  artifacts: "Artifacts", takes: "Generated takes", publications: "Published outputs", models: "Models",
  downloads: "Downloads", temporary: "Temporary files", other: "Other or unmeasured",
};
const count = z.number().int().nonnegative().safe();
/** Scoped logical sizes, never allocated/reclaimable bytes or cleanup authority (SPEC-062 R-2). */
export const StorageInventorySchema = z.object({
  scanning: z.boolean(),
  categories: z.array(z.object({
    category: z.enum(STORAGE_CATEGORIES), state: z.enum(["unmeasured", "measured", "partial"]),
    logicalBytes: count.nullable(), files: count.nullable(), measuredAt: count.nullable(),
  }).strict()).length(STORAGE_CATEGORIES.length).refine(rows => new Set(rows.map(row => row.category)).size === STORAGE_CATEGORIES.length),
  allocatedBytes: z.null(), reclaimableBytes: z.null(),
}).strict();
export type StorageInventory = z.infer<typeof StorageInventorySchema>;
