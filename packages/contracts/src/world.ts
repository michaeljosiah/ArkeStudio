import { z } from "zod";
import { CanonIdSchema, IsoDateSchema, IsoDateTimeSchema, SlugSchema, UlidSchema } from "./ids.js";

/**
 * The world entity model (master spec §2). Prose lives in Markdown with YAML frontmatter,
 * structure in JSON; these schemas are the parsed shapes. Round-tripping is at the object
 * level: parse → schema → serialise must not lose or invent a field.
 */

// ---------------------------------------------------------------------------
// world.json (§2.3.1)
// ---------------------------------------------------------------------------

export const WorldMetaSchema = z
  .object({
    /** ULID, never the slug — global records (queue, ledger) key on it (§2.3.1). */
    worldId: UlidSchema,
    slug: SlugSchema,
    schemaVersion: z.number().int().min(1),
    name: z.string().min(1),
    logline: z.string().optional(),
    tone: z.string().optional(),
    genre: z.string().optional(),
    /** One monotonic world-level canon revision (§2.4). */
    canonRevision: z.number().int().min(0),
    /** Persisted allocation counter — canon ids are never reused (§2.3.1, R-CANON-4). */
    nextCanonId: z.number().int().min(1),
    created: IsoDateTimeSchema,
    updated: IsoDateTimeSchema,
  })
  .strict();
export type WorldMeta = z.infer<typeof WorldMetaSchema>;

// ---------------------------------------------------------------------------
// Sheets — characters/, locations/, factions/ (§2.3.2)
// ---------------------------------------------------------------------------

export const SheetKindSchema = z.enum(["character", "location", "faction"]);
export type SheetKind = z.infer<typeof SheetKindSchema>;

export const SheetStatusSchema = z.enum(["sketch", "locked"]);
export type SheetStatus = z.infer<typeof SheetStatusSchema>;

/** A voice assignment recorded on a character sheet (§7.2). */
export const VoiceAssignmentSchema = z
  .object({
    provider: z.string().min(1), // "elevenlabs" | "openai" | "voxa" | …
    voiceId: z.string().min(1),
    label: z.string().optional(),
    assignedAtVersion: z.number().int().min(1),
  })
  .strict();
export type VoiceAssignment = z.infer<typeof VoiceAssignmentSchema>;

/** One prose section of a sheet body, in authored order (`## Essence`, `## Appearance`, …). */
export const SheetSectionSchema = z
  .object({
    heading: z.string().min(1),
    body: z.string(),
  })
  .strict();
export type SheetSection = z.infer<typeof SheetSectionSchema>;

export const SheetSchema = z
  .object({
    id: SlugSchema,
    /** Frontmatter key is `type` (§2.3.2). */
    type: SheetKindSchema,
    name: z.string().min(1),
    /** Characters: e.g. "Tide-caller". */
    role: z.string().optional(),
    /** Characters: e.g. "lead" | "support". Display vocabulary, not an enum the gate owns. */
    billing: z.string().optional(),
    /** Locations only. */
    region: z.string().optional(),
    /** Own monotonic version, independent of canon and of every other sheet (§2.4). */
    version: z.number().int().min(1),
    status: SheetStatusSchema,
    /** Retired entities stay on disk and resolvable so citations keep meaning (SPEC-002 R-26). */
    retired: z.boolean().optional(),
    /** Duplication origin — a record at copy time, never a live dependency (SPEC-007 R-12, D9). */
    origin: z
      .object({ sheet: SlugSchema, version: z.number().int().min(1) })
      .strict()
      .optional(),
    voice: VoiceAssignmentSchema.optional(),
    /** References only — the rules themselves are owned by canon, not the sheet (§2.3.2). */
    canonRules: z.array(CanonIdSchema),
    links: z.array(SlugSchema),
    created: IsoDateSchema,
    updated: IsoDateSchema,
    sections: z.array(SheetSectionSchema),
  })
  .strict();
export type Sheet = z.infer<typeof SheetSchema>;

// ---------------------------------------------------------------------------
// Canon entries — canon/CANON-nnn.md (§2.3.3)
// ---------------------------------------------------------------------------

export const CanonEntryTypeSchema = z.enum(["rule", "lore", "location", "faction", "timeline", "tone", "thread"]);
export type CanonEntryType = z.infer<typeof CanonEntryTypeSchema>;

export const CanonEntryStatusSchema = z.enum(["proposed", "settled", "open"]);
export type CanonEntryStatus = z.infer<typeof CanonEntryStatusSchema>;

export const CanonEntrySchema = z
  .object({
    id: CanonIdSchema,
    type: CanonEntryTypeSchema,
    title: z.string().min(1),
    status: CanonEntryStatusSchema,
    /** Canon revisions at which each lifecycle step landed (§2.4): "settled v12 · amended v42". */
    introducedAt: z.number().int().min(0),
    settledAt: z.number().int().min(0).optional(),
    amendedAt: z.number().int().min(0).optional(),
    /** Retired entries keep their id and stay resolvable (SPEC-002 R-26, R-CANON-4). */
    retired: z.boolean().optional(),
    /** Sheet slugs and CANON ids this entry links. */
    links: z.array(z.union([SlugSchema, CanonIdSchema])),
    /** The statement itself — the Markdown body below the frontmatter. */
    body: z.string(),
  })
  .strict();
export type CanonEntry = z.infer<typeof CanonEntrySchema>;

// ---------------------------------------------------------------------------
// Productions (§8)
// ---------------------------------------------------------------------------

export const ProductionFormatSchema = z.enum(["story", "video", "stills"]);
export type ProductionFormat = z.infer<typeof ProductionFormatSchema>;

export const ProductionSchema = z
  .object({
    /** The production's directory slug within the world. */
    id: SlugSchema,
    format: ProductionFormatSchema,
    title: z.string().min(1),
    logline: z.string().optional(),
    /** Display vocabulary ("in-progress", "cutting", …) — unversioned, change-logged only (§2.4.1). */
    status: z.string().min(1),
    created: IsoDateTimeSchema,
    updated: IsoDateTimeSchema,
  })
  .strict();
export type Production = z.infer<typeof ProductionSchema>;

/** story.json — the authored overview a story production drafts against (§8.3). Versioned. */
export const StoryOverviewSchema = z
  .object({
    version: z.number().int().min(1),
    logline: z.string().optional(),
    spine: z.string().optional(),
    acts: z.array(z.object({ title: z.string().min(1), summary: z.string().optional() }).strict()).optional(),
    targetLength: z.string().optional(),
  })
  .strict();
export type StoryOverview = z.infer<typeof StoryOverviewSchema>;

/** A chapter's frontmatter (§8.3); prose is the body and is not carried on the summary. */
export const ChapterSummarySchema = z
  .object({
    id: SlugSchema,
    number: z.number().int().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    version: z.number().int().min(1),
    words: z.number().int().min(0).optional(),
    draws: z
      .object({
        sheets: z.array(SlugSchema),
        canon: z.array(CanonIdSchema),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ChapterSummary = z.infer<typeof ChapterSummarySchema>;
