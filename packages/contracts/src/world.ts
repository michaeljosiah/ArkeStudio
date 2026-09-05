import { z } from "zod";
import { CanonIdSchema, EpisodeIdSchema, IsoDateSchema, IsoDateTimeSchema, SceneIdSchema, SlugSchema, UlidSchema } from "./ids.js";
// The same bound the world's list uses, shared rather than restated: two copies of one
// constraint is how a list and its copy come to disagree (issue 243's finalization bug).
import { FailureModesSchema } from "./art-direction.js";
import { CapabilitySchema } from "./provider.js";

/**
 * The world entity model (master spec §2). Prose lives in Markdown with YAML frontmatter,
 * structure in JSON; these schemas are the parsed shapes. Round-tripping is at the object
 * level: parse → schema → serialise must not lose or invent a field.
 */

// ---------------------------------------------------------------------------
// world.json (§2.3.1)
// ---------------------------------------------------------------------------

/** The world-scoped prose fields an author may change without changing world identity. */
export const WorldAuthoredFieldsSchema = z
  .object({
    name: z.string().trim().min(1),
    logline: z.string().trim().min(1).optional(),
    tone: z.string().trim().min(1).optional(),
    genre: z.string().trim().min(1).optional(),
  })
  .strict();
export type WorldAuthoredFields = z.infer<typeof WorldAuthoredFieldsSchema>;

/** Optional authored fields may be cleared; later registered fields inherit set support by default. */
export const WorldAuthoredFieldChangesSchema = WorldAuthoredFieldsSchema
  .partial()
  .extend({
    logline: z.string().trim().min(1).nullable().optional(),
    tone: z.string().trim().min(1).nullable().optional(),
    genre: z.string().trim().min(1).nullable().optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "a world metadata action must change at least one field");
export type WorldAuthoredFieldChanges = z.infer<typeof WorldAuthoredFieldChangesSchema>;

export const WorldMetaSchema = z
  .object({
    /** ULID, never the slug — global records (queue, ledger) key on it (§2.3.1). */
    worldId: UlidSchema,
    slug: SlugSchema,
    schemaVersion: z.number().int().min(1),
    // Persisted worlds predate authored-field write validation. Keep this read path permissive;
    // the narrower schema above governs new World Chat writes without hiding an older world.
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
    /** Concrete TTS model. Optional only for assignments written before SPEC-028. */
    model: z.string().min(1).optional(),
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

/** The audience-facing classification (SPEC-023 R-1): what the audience receives. */
export const ProductionMediumSchema = z.enum(["story", "video", "interactive-video"]);
export type ProductionMedium = z.infer<typeof ProductionMediumSchema>;

export const FrameRateSchema = z.union([z.literal(24), z.literal(25), z.literal(30)]);
export type FrameRate = z.infer<typeof FrameRateSchema>;
export const DEFAULT_FRAME_RATE: FrameRate = 24;

/** Existing production files have no clock field and continue to mean 24 fps without being rewritten. */
export function productionFrameRate(production: { frameRate?: FrameRate }): FrameRate {
  return production.frameRate ?? DEFAULT_FRAME_RATE;
}

export const ProductionSchema = z
  .object({
    /** The production's directory slug within the world. */
    id: SlugSchema,
    /**
     * The legacy discriminator, frozen (SPEC-023 R-1): always written, set to the value the
     * medium maps back to, so a reader that predates `medium` is never lied to. It is only
     * consulted when `medium` is absent.
     */
    format: ProductionFormatSchema,
    /**
     * Optional on read and resolved from `format` when absent (`story → story`,
     * `video → video`, `stills → video`); written only when it differs from that resolve, so
     * a plain creation keeps the world openable by older builds (SPEC-023 R-1/R-23).
     */
    medium: ProductionMediumSchema.optional(),
    /**
     * The named format beneath the medium (SPEC-023 R-2), e.g. `microdrama`. Free on read —
     * an unknown kind resolves to the medium's default behaviour rather than deleting the
     * production; the create dialog is where the vocabulary is enforced.
     */
    kind: z.string().min(1).optional(),
    title: z.string().min(1),
    logline: z.string().optional(),
    /** Display vocabulary ("in-progress", "cutting", …) — unversioned, change-logged only (§2.4.1). */
    status: z.string().min(1),
    /** The production's whole-frame clock (SPEC-037 R-6). Absent legacy records resolve to 24 fps. */
    frameRate: FrameRateSchema.optional(),
    /** Optional production-specific visual language; the world surface names this exception. */
    styleOverride: z.string().min(1).optional(),
    /**
     * The aspect this production delivers in, e.g. "16:9" (SPEC-019 R-36, D29; issue 389).
     *
     * On the production and not on art direction, which is one world-level record: a world
     * routinely holds a 16:9 film and a 9:16 cut of the same material, and a world-scoped aspect
     * cannot express both without one production silently changing the other's. Absent means
     * DEFAULT_PRODUCTION_ASPECT (16:9 — the landscape every pre-aspect production actually
     * rendered); there is deliberately no world-level default. Normalized W:H at every write.
     */
    aspect: z.string().min(1).optional(),
    /**
     * Strengthen the world's music policy, never relax it (#244, design turn 59).
     *
     * One optional literal rather than the world's two-valued enum, because that is the whole
     * rule: the only thing a production may say is "stricter than the world". Absent means
     * inherit. There is deliberately no way to express `allow-model-score` here — a production
     * able to relax the world's policy would make the world's policy a suggestion, and the
     * schema is a better place to make that impossible than a screen is.
     */
    musicPolicy: z.literal("environmental-only").optional(),
    /**
     * Which model this production reaches for, per capability (SPEC-033 §1.12, R-74..R-76).
     *
     * A **concrete model reference**, never the word `local` or `cloud`. With two local video
     * models installed, `local` does not say which seeds the dispatch, and migrating an existing
     * routing default under that spelling would discard the model id it already had. The
     * local/cloud presentation is derived from the referenced model's locality, never stored as
     * a second fact that can disagree with it.
     *
     * On the production and not in app settings: production ids are world-scoped rather than
     * installation-global, so an installation-level store collides across two copies of a world
     * and loses the choice when the world moves to another machine. It is a production field and
     * takes the path every production field takes — versioned and gated like the rest.
     *
     * It seeds the dispatch picker and does not lock it: the per-dispatch override is unchanged,
     * and a choice that cannot be honoured is stated at dispatch rather than silently swapped.
     */
    models: z.record(CapabilitySchema, z.string().min(1)).optional(),
    /** Added to the world's failure modes at dispatch, never instead of them. */
    failureModes: FailureModesSchema,
    created: IsoDateTimeSchema,
    updated: IsoDateTimeSchema,
  })
  .strict();
export type Production = z.infer<typeof ProductionSchema>;

/**
 * series/<slug>.json — the thin Series record (SPEC-023 R-9). Thin means thin: a Series that
 * describes characters becomes a second place a character exists, which is the drift SPEC-012
 * D1 exists to prevent. Living inside the world folder is the world reference. Versioned on
 * the `series` track.
 */
export const SeriesSchema = z
  .object({
    id: SlugSchema,
    version: z.number().int().min(1),
    title: z.string().min(1),
    /** The repeatable premise or story engine — prose, authored later if not at creation. */
    engine: z.string().optional(),
    /** Ordered season production slugs; a dangling slug is a named world problem. */
    seasons: z.array(SlugSchema),
    /** Only continuity that is genuinely not world canon. */
    continuity: z.string().optional(),
    created: IsoDateTimeSchema,
    updated: IsoDateTimeSchema,
  })
  .strict();
export type Series = z.infer<typeof SeriesSchema>;

/**
 * productions/<p>/season.json — the season beside its production (SPEC-023 R-10). Top-level
 * `ending` is the season's own authored resolution; `defaults.episodeEnding` is the
 * per-episode ending policy — two facts, two fields. Arc lanes live here; a missing payoff is
 * worked out at render, not stored. Versioned on the `season` track.
 */
export const SeasonSchema = z
  .object({
    version: z.number().int().min(1),
    question: z.string().optional(),
    ending: z.string().optional(),
    direction: z.string().optional(),
    arcs: z
      .array(
        z
          .object({
            id: SlugSchema,
            title: z.string().min(1),
            note: z.string().optional(),
            /**
             * The three cells an arc lane marks (turn 48: SETUP, TURN, PAYOFF — in words as
             * well as colour). Each names the episode where it lands; a lane with no payoff is
             * called out at render, worked out rather than stored.
             */
            setup: EpisodeIdSchema.optional(),
            turn: EpisodeIdSchema.optional(),
            payoff: EpisodeIdSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    /** Editable defaults, never invariants (SPEC-023 R-16). */
    defaults: z
      .object({
        episodeCount: z.number().int().min(1).optional(),
        episodeSecondsMin: z.number().positive().optional(),
        episodeSecondsMax: z.number().positive().optional(),
        hookWindowSec: z.number().positive().optional(),
        episodeEnding: z.string().min(1).optional(),
        exportPreset: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Season = z.infer<typeof SeasonSchema>;

/**
 * productions/<p>/episodes/<stem>.json — one file per episode (SPEC-023 R-12). The stem and id
 * are stable at creation; `order` alone places the episode, and the ordered `scenes` array is
 * the single membership and within-episode order authority — scene files carry no episode
 * field, so membership can never disagree with itself. Versioned on the `episode` track.
 */
export const EpisodeSchema = z
  .object({
    id: EpisodeIdSchema,
    version: z.number().int().min(1),
    order: z.number().int().min(1),
    title: z.string().min(1),
    /** Turn 53: an episode is its promise and its scenes — how it opens, where it turns, how it closes. */
    promise: z
      .object({
        opens: z.string().optional(),
        turn: z.string().optional(),
        closes: z.string().optional(),
      })
      .strict()
      .optional(),
    scenes: z.array(SceneIdSchema),
    /** A boundary-crossing moment is two linked scenes; this records the pairing (SPEC-023 R-12). */
    linked: z
      .object({
        closesInto: EpisodeIdSchema.optional(),
        opensFrom: EpisodeIdSchema.optional(),
      })
      .strict()
      .optional(),
    /** The release record an episode deliverable owns (SPEC-023 R-15); export work is #396. */
    release: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        thumbnailTakeId: z.string().optional(),
        tags: z.array(z.string().min(1)).optional(),
        recap: z.string().optional(),
        teaser: z.string().optional(),
        crops: z.array(z.object({ label: z.string().min(1), aspect: z.string().min(1) }).strict()).optional(),
        metadata: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Episode = z.infer<typeof EpisodeSchema>;

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

/**
 * A chapter's frontmatter as read off disk (§8.3; SPEC-012 R-4/D3). `order` is the one order
 * authority; `number` is the legacy shipped shape, read only when `order` is absent. Neither is
 * required — a chapter whose order cannot be resolved still parses and falls back to filename
 * order at scan, deterministically, rather than vanishing from the bundle. The committer stamps
 * `version` and `updated` on every chapter write, and creation stamps `created`, so all three are
 * legal keys here even though only `version` is required.
 */
export const ChapterFrontmatterSchema = z
  .object({
    id: SlugSchema,
    order: z.number().optional(),
    number: z.number().optional(),
    title: z.string().min(1),
    status: z.string().min(1).optional(),
    version: z.number().int().min(1),
    words: z.number().int().min(0).optional(),
    draws: z
      .object({
        sheets: z.array(SlugSchema),
        canon: z.array(CanonIdSchema),
      })
      .strict()
      .optional(),
    created: z.string().optional(),
    updated: z.string().optional(),
  })
  .strict();
export type ChapterFrontmatter = z.infer<typeof ChapterFrontmatterSchema>;

/**
 * What the bundle carries per chapter. `order` is the resolved dense sequence (1..n) after the
 * scan sort — display surfaces read it and nothing else. `file` is the filename stem the
 * save/draft/reorder commands address the chapter file by; `id` is authored frontmatter and does
 * not have to match it (fixture chapters are `01-neap.md` with `id: neap`). Prose is the body and
 * is not carried on the summary.
 */
export const ChapterSummarySchema = z
  .object({
    id: SlugSchema,
    file: z.string().min(1),
    order: z.number().int().min(1),
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
