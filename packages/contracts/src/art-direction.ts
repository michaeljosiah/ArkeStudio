import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import type { WorldMeta } from "./world.js";

/** One accepted look that is no longer current. Its image remains where that version put it. */
export const ArtDirectionHistoryEntrySchema = z
  .object({
    version: z.number().int().min(1),
    description: z.string().trim().min(1),
    masterLook: z.string().min(1).optional(),
    acceptedAt: IsoDateTimeSchema,
  })
  .strict();
export type ArtDirectionHistoryEntry = z.infer<typeof ArtDirectionHistoryEntrySchema>;

/** `art-direction/art-direction.json`: the world's accepted visual default. */
export const ArtDirectionRecordSchema = z
  .object({
    version: z.number().int().min(1),
    description: z.string().trim().min(1),
    masterLook: z.string().min(1).optional(),
    acceptedAt: IsoDateTimeSchema,
    history: z.array(ArtDirectionHistoryEntrySchema).default([]),
  })
  .strict()
  .superRefine((record, ctx) => {
    const versions = new Set<number>();
    for (const entry of record.history) {
      if (entry.version >= record.version) {
        ctx.addIssue({
          code: "custom",
          path: ["history"],
          message: `history version ${entry.version} must precede current v${record.version}`,
        });
      }
      if (versions.has(entry.version)) {
        ctx.addIssue({
          code: "custom",
          path: ["history"],
          message: `history contains v${entry.version} more than once`,
        });
      }
      versions.add(entry.version);
    }
  });
export type ArtDirectionRecord = z.infer<typeof ArtDirectionRecordSchema>;

export const ArtDirectionReachSchema = z
  .object({
    visualAssets: z.number().int().min(0),
    referenceKits: z.number().int().min(0),
    productions: z.number().int().min(0),
    earlierAcceptedTakes: z.number().int().min(0),
  })
  .strict();
export type ArtDirectionReach = z.infer<typeof ArtDirectionReachSchema>;

export const ArtDirectionOverrideSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["character", "location", "faction", "production"]),
    description: z.string().min(1),
  })
  .strict();
export type ArtDirectionOverride = z.infer<typeof ArtDirectionOverrideSchema>;

/** The resolved, never-blank record plus facts computed from the open world. */
export const ResolvedArtDirectionSchema = z
  .object({
    version: z.number().int().min(1),
    description: z.string().trim().min(1),
    masterLook: z.string().min(1).optional(),
    acceptedAt: IsoDateTimeSchema.optional(),
    history: z.array(ArtDirectionHistoryEntrySchema),
    derived: z.boolean(),
    reach: ArtDirectionReachSchema,
    overrides: z.array(ArtDirectionOverrideSchema),
  })
  .strict();
export type ResolvedArtDirection = z.infer<typeof ResolvedArtDirectionSchema>;

/** Worlds without a record preserve today's tone/genre behavior and still resolve non-blank. */
export function deriveArtDirectionDescription(meta: WorldMeta): string {
  const tone = meta.tone?.trim();
  const genre = meta.genre?.trim();
  const inherited = [tone, genre].filter((value): value is string => Boolean(value));
  if (inherited.length > 0) {
    return `${meta.name} should feel ${inherited.join(" and ")}. Keep every image coherent with that inherited tone and genre.`;
  }
  if (meta.logline?.trim()) return `A coherent visual language for ${meta.name}. ${meta.logline.trim()}`;
  return `A coherent visual language for ${meta.name}.`;
}

export function resolveArtDirection(
  meta: WorldMeta,
  record: ArtDirectionRecord | null,
): Omit<ResolvedArtDirection, "reach" | "overrides"> {
  if (record) return { ...record, derived: false };
  return {
    version: 1,
    description: deriveArtDirectionDescription(meta),
    history: [],
    derived: true,
  };
}
