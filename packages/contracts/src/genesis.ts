import { z } from "zod";

/**
 * The blueprint a founding conversation maintains in its sandbox (SPEC-031 §1.3).
 *
 * `draft.json` keeps identity, look, bible, threads and the key-art brief; each character,
 * place and faction gets its own small file under `draft/`. A turn about one character
 * rewrites one file, so nothing the conversation is not currently discussing is at risk from
 * a turn that goes badly, and the rescue turn narrows from "restate the world" to "restate
 * this one file" (§2.2).
 *
 * Every schema here is deliberately tolerant — fields optional, unknown keys stripped —
 * because an agent's enthusiasm should degrade to a smaller record, never to a parse failure.
 */

// ---------------------------------------------------------------------------
// Visual briefs (R-5)
// ---------------------------------------------------------------------------

/**
 * The subject facts a generation needs and only the conversation knows. No style, treatment,
 * medium, lens, or phrasing aimed at a model — those are compiled at build time against the
 * resolved art direction and the route (R-6, §2.3).
 */
export const GenesisCharacterBriefSchema = z
  .object({
    apparentAge: z.string().min(1).max(120).optional(),
    build: z.string().min(1).max(200).optional(),
    colouring: z.string().min(1).max(200).optional(),
    hair: z.string().min(1).max(200).optional(),
    wardrobe: z.string().min(1).max(300).optional(),
    bearing: z.string().min(1).max(200).optional(),
    defaultExpression: z.string().min(1).max(200).optional(),
  })
  .strip();
export type GenesisCharacterBrief = z.infer<typeof GenesisCharacterBriefSchema>;

export const GenesisLocationBriefSchema = z
  .object({
    /** What an establishing view holds — the one picture that says where this is. */
    establishingView: z.string().min(1).max(500).optional(),
    hour: z.string().min(1).max(120).optional(),
    weather: z.string().min(1).max(120).optional(),
    season: z.string().min(1).max(120).optional(),
  })
  .strip();
export type GenesisLocationBrief = z.infer<typeof GenesisLocationBriefSchema>;

/**
 * What one image should hold to stand for the whole world (R-5). It belongs to no entity
 * file, so it lives on `draft.json` beside the look it will be rendered in. `characters`
 * names the cast members the image should carry, in the order the surplus is dropped when a
 * route offers fewer identity slots than the brief names (R-60).
 */
export const GenesisKeyArtBriefSchema = z
  .object({
    subject: z.string().min(1).max(500).optional(),
    moment: z.string().min(1).max(500).optional(),
    stakes: z.string().min(1).max(500).optional(),
    characters: z.array(z.string().min(1).max(120)).max(8).default([]),
    location: z.string().min(1).max(120).optional(),
  })
  .strip();
export type GenesisKeyArtBrief = z.infer<typeof GenesisKeyArtBriefSchema>;

/** A key-art brief that settles nothing is no brief: the item is not dispatched (R-5). */
export function keyArtBriefSettled(brief: GenesisKeyArtBrief | undefined): boolean {
  return brief !== undefined && (brief.subject !== undefined || brief.moment !== undefined);
}

// ---------------------------------------------------------------------------
// draft.json (R-3)
// ---------------------------------------------------------------------------

/**
 * The genesis draft as the world-author agent maintains it in the sandbox's draft.json.
 *
 * Identity, look, bible, threads and the key-art brief. The `characters` and `locations`
 * arrays are the pre-blueprint shape, still read so an older sandbox folds instead of going
 * blank — new conversations keep entities in the `draft/` directory (R-1).
 */
export const GenesisDraftSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    logline: z.string().min(1).max(500).optional(),
    tone: z.string().min(1).max(120).optional(),
    genre: z.string().min(1).max(120).optional(),
    /**
     * The art direction in the conversation's own words, proposed by the agent from the
     * tone, genre and bible it has already settled (R-3). The preset picker remains as an
     * override; this is the way in that heard the conversation.
     */
    look: z.string().min(1).max(2000).optional(),
    characters: z
      .array(z.object({ name: z.string().min(1).max(120), line: z.string().min(1).max(300) }).strip())
      .max(8)
      .default([]),
    locations: z
      .array(z.object({ name: z.string().min(1).max(120), line: z.string().min(1).max(300) }).strip())
      .max(8)
      .default([]),
    threads: z.array(z.string().min(1).max(300)).max(8).default([]),
    /**
     * The through-line, in prose, as the conversation settled it (SPEC-022, 2026-08-22).
     *
     * The other fields are the world's furniture — who is in it, where it happens, what is
     * unresolved. None of them hold the reason any of it is worth telling, so a world door that
     * talked for twenty minutes handed over a cast and lost the argument that produced it. This
     * is the argument, and it becomes `bible.md` at v1. Longer than the rest on purpose: it is
     * the only field meant to be read as writing rather than looked up.
     */
    bible: z.string().min(1).max(8000).optional(),
    keyArt: GenesisKeyArtBriefSchema.optional(),
  })
  .strip();
export type GenesisDraft = z.infer<typeof GenesisDraftSchema>;

// ---------------------------------------------------------------------------
// Entity files (R-1, R-2, R-4)
// ---------------------------------------------------------------------------

/**
 * One file under `draft/characters/`, `draft/locations/` or `draft/factions/`. The file's
 * name is the entity's stable identity: renaming the character changes `name` and keeps the
 * file, so the rename neither creates a second entity nor loses the first (R-2). Withdrawal
 * is representable — `"withdrawn": true`, or deleting the file — and a withdrawn entity is
 * removed from the fold and never built.
 */
const entityFileBase = {
  name: z.string().min(1).max(120),
  line: z.string().min(1).max(300).optional(),
  description: z.string().min(1).max(4000).optional(),
  withdrawn: z.boolean().optional(),
};

export const GenesisCharacterFileSchema = z
  .object({ ...entityFileBase, brief: GenesisCharacterBriefSchema.optional() })
  .strip();
export type GenesisCharacterFile = z.infer<typeof GenesisCharacterFileSchema>;

export const GenesisLocationFileSchema = z
  .object({ ...entityFileBase, brief: GenesisLocationBriefSchema.optional() })
  .strip();
export type GenesisLocationFile = z.infer<typeof GenesisLocationFileSchema>;

export const GenesisFactionFileSchema = z.object({ ...entityFileBase }).strip();
export type GenesisFactionFile = z.infer<typeof GenesisFactionFileSchema>;

// ---------------------------------------------------------------------------
// The folded blueprint aggregate (R-2)
// ---------------------------------------------------------------------------

/** A folded entity: the file's contents under the identity its filename carries. */
export const BlueprintCharacterSchema = z
  .object({
    slug: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    line: z.string().min(1).max(300).optional(),
    description: z.string().min(1).max(4000).optional(),
    brief: GenesisCharacterBriefSchema.optional(),
  })
  .strict();
export type BlueprintCharacter = z.infer<typeof BlueprintCharacterSchema>;

export const BlueprintLocationSchema = z
  .object({
    slug: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    line: z.string().min(1).max(300).optional(),
    description: z.string().min(1).max(4000).optional(),
    brief: GenesisLocationBriefSchema.optional(),
  })
  .strict();
export type BlueprintLocation = z.infer<typeof BlueprintLocationSchema>;

export const BlueprintFactionSchema = z
  .object({
    slug: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
    line: z.string().min(1).max(300).optional(),
    description: z.string().min(1).max(4000).optional(),
  })
  .strict();
export type BlueprintFaction = z.infer<typeof BlueprintFactionSchema>;

/**
 * The whole plan, folded from the directory on read (R-2). A file that fails to parse is
 * dropped from the fold rather than failing it, and named in `dropped` so the review screen
 * can state it before the build starts (§4 row 9). Withdrawn entities are simply absent.
 */
export const GenesisBlueprintSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    logline: z.string().min(1).max(500).optional(),
    tone: z.string().min(1).max(120).optional(),
    genre: z.string().min(1).max(120).optional(),
    look: z.string().min(1).max(2000).optional(),
    bible: z.string().min(1).max(8000).optional(),
    threads: z.array(z.string().min(1).max(300)).default([]),
    keyArt: GenesisKeyArtBriefSchema.optional(),
    characters: z.array(BlueprintCharacterSchema).default([]),
    locations: z.array(BlueprintLocationSchema).default([]),
    factions: z.array(BlueprintFactionSchema).default([]),
    /** Sandbox-relative paths of files that failed to parse — stated, never silent (R-8). */
    dropped: z.array(z.string()).default([]),
  })
  .strict();
export type GenesisBlueprint = z.infer<typeof GenesisBlueprintSchema>;

// ---------------------------------------------------------------------------
// Coverage (R-7)
// ---------------------------------------------------------------------------

/**
 * What the conversation has covered and what is still open, as the rail shows it: labels and
 * counts across premise, cast, places, the through-line, the look and the world's one image.
 * The last is on the list so a missing key-art brief is visible while it can still be
 * answered, rather than arriving as a line on the completion notice.
 */
export interface GenesisCoverage {
  premise: boolean;
  cast: number;
  places: number;
  factions: number;
  throughLine: boolean;
  look: boolean;
  keyArt: boolean;
}

export function blueprintCoverage(blueprint: GenesisBlueprint): GenesisCoverage {
  return {
    premise: blueprint.logline !== undefined,
    cast: blueprint.characters.length,
    places: blueprint.locations.length,
    factions: blueprint.factions.length,
    throughLine: blueprint.bible !== undefined,
    look: blueprint.look !== undefined,
    keyArt: keyArtBriefSettled(blueprint.keyArt),
  };
}
