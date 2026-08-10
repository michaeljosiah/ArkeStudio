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

/**
 * How long a character's `role` may be when it is *written* (SPEC-007 §2.3.1).
 *
 * The world hub draws the cast as fixed-height cards, and the role is the single 15px line
 * under the name. 28 is the width budget of that 147px line at 11px in the sans face, measured
 * at the average letter density of real roles — "Keeper of the drowned verse" is 27 and fits
 * with room to spare. It is a budget for authoring, not a guarantee: 28 wide capitals would
 * still overrun, which is why the card clips to one line regardless.
 *
 * Deliberately NOT enforced by `SheetSchema`. That schema is the *read* path — `scan.ts` drops
 * any sheet it rejects — so a max here would make a character with a longer role disappear from
 * a world that already opened fine. Authoring paths enforce it; reading stays permissive.
 */
export const CHARACTER_ROLE_MAX = 28;

export const SheetSchema = z
  .object({
    id: SlugSchema,
    /** Frontmatter key is `type` (§2.3.2). */
    type: SheetKindSchema,
    name: z.string().min(1),
    /** Characters: e.g. "Tide-caller". Authored within `CHARACTER_ROLE_MAX`; read unbounded. */
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
    /**
     * The production that owns this sheet — a *guest* (SPEC-020 R-1). Absent means the world
     * owns it, which is every sheet written before SPEC-020 and most sheets after it.
     *
     * Ownership decides where the sheet is *shown* and nothing else. A guest versions, gates,
     * snapshots, is cited, is retired, takes a reference kit and takes a voice exactly as a
     * world sheet does (R-3) — the field is read by surfaces and by one dispatch warning, never
     * by a mechanism that could fail on it.
     *
     * Deliberately not validated against the productions that exist. A sheet naming a production
     * that has been renamed away still parses and still resolves (R-4); the alternative is a
     * scan that drops a character because a directory moved.
     */
    production: SlugSchema.optional(),
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

/**
 * Scope predicates (SPEC-020). Every surface that has to answer "does this sheet belong here?"
 * asks through these rather than reading `production` directly, so the answer is written once
 * and the three world-level surfaces cannot drift apart.
 */

/** A guest — owned by a production rather than by the world (R-1). */
export function isGuest(sheet: Sheet): boolean {
  return sheet.production !== undefined;
}

/** The world's own cast: what the hub's fan, its counts and its ledgers draw (R-8). */
export function worldSheets(sheets: Sheet[]): Sheet[] {
  return sheets.filter((sheet) => !isGuest(sheet));
}

/** Just this production's guests, for the group drawn beside the world cast (R-9). */
export function guestsOf(sheets: Sheet[], productionId: string): Sheet[] {
  return sheets.filter((sheet) => sheet.production === productionId);
}

/**
 * What a picker inside a production may offer: the world's cast plus this production's guests
 * (R-7). Another production's guests are absent — an offer is not a record, and narrowing it
 * costs nothing. Resolution deliberately does NOT use this (R-5): a mention that already names a
 * foreign guest still resolves, and the problem surfaces at dispatch instead.
 */
export function pickableSheets(sheets: Sheet[], productionId: string | undefined): Sheet[] {
  return sheets.filter((sheet) => !isGuest(sheet) || sheet.production === productionId);
}

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
    /** Optional production-specific visual language; the world surface names this exception. */
    styleOverride: z.string().min(1).optional(),
    /**
     * The aspect this production delivers in, e.g. "16:9" (SPEC-019 R-36, D29).
     *
     * On the production and not on art direction, which is one world-level record: a world
     * routinely holds a 16:9 film and a 9:16 cut of the same material, and a world-scoped aspect
     * cannot express both without one production silently changing the other's. Absent means the
     * world's default applies.
     */
    aspect: z.string().min(1).optional(),
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
