import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import type { WorldMeta } from "./world.js";

/**
 * What a generation must obey, beyond how it should look (#244, design turn 59).
 *
 * Music is here because a video model returns one mixed track: score it added cannot be
 * separated from dialogue or environmental sound afterwards, so the only moment the decision can
 * be made is before the request. Subtitles has one value in v1 and is still written down rather
 * than assumed — Arke's cut owns titles, and burned-in text cannot be moved, translated or
 * removed, so `never` is a policy the prompt states rather than a default nobody recorded.
 */
export const AudioPolicySchema = z
  .object({
    music: z.enum(["environmental-only", "allow-model-score"]),
    subtitles: z.literal("never"),
  })
  .strict();
export type AudioPolicy = z.infer<typeof AudioPolicySchema>;

export const DEFAULT_AUDIO_POLICY: AudioPolicy = {
  music: "environmental-only",
  subtitles: "never",
};

/**
 * Standing failures worth saying every time — "do not drift the Polaroid", "hands stay whole".
 *
 * Bounded at 20 because a constraint block longer than the shot it constrains stops being read,
 * by a model or a person; and at 300 characters each because a failure mode that needs a
 * paragraph is a scene note wearing a rule's clothes.
 */
export const FailureModesSchema = z.array(z.string().trim().min(1).max(300)).max(20).default([]);

/** What the world's one representative image should contain, separate from how it should look. */
export const KeyArtIntentSchema = z
  .object({
    subject: z.string().min(1).max(500).optional(),
    moment: z.string().min(1).max(500).optional(),
    stakes: z.string().min(1).max(500).optional(),
    characters: z.array(z.string().min(1).max(120)).max(8).default([]),
    location: z.string().min(1).max(120).optional(),
  })
  .strict();
export type KeyArtIntent = z.infer<typeof KeyArtIntentSchema>;

/** One accepted look that is no longer current. Its image remains where that version put it. */
export const ArtDirectionHistoryEntrySchema = z
  .object({
    version: z.number().int().min(1),
    description: z.string().trim().min(1),
    masterLook: z.string().min(1).optional(),
    /** Absent predates authored intent; null explicitly suppresses the legacy build brief. */
    keyArtIntent: KeyArtIntentSchema.nullable().optional(),
    acceptedAt: IsoDateTimeSchema,
    // On history too, not only on the current record: a take made under v3 was made under v3's
    // policy, and answering "why does this clip have music in it" a month later means being able
    // to read what was in force then rather than what is in force now.
    audio: AudioPolicySchema.default(DEFAULT_AUDIO_POLICY),
    failureModes: FailureModesSchema,
  })
  .strict();
export type ArtDirectionHistoryEntry = z.infer<typeof ArtDirectionHistoryEntrySchema>;

/**
 * Where the world's look lives, spelled once.
 *
 * Five places knew this string and each spelled it out. It is the only proposal target that is
 * not Markdown, so it is also the path every generic file path has to recognise as an exception —
 * a typo in any one of them fails open, quietly, as the wrong kind of file.
 */
export const ART_DIRECTION_PATH = "art-direction/art-direction.json";

/** `art-direction/art-direction.json`: the world's accepted visual default. */
export const ArtDirectionRecordSchema = z
  .object({
    version: z.number().int().min(1),
    description: z.string().trim().min(1),
    masterLook: z.string().min(1).optional(),
    /** Absent falls back to a founding brief; null means the author deliberately cleared it. */
    keyArtIntent: KeyArtIntentSchema.nullable().optional(),
    acceptedAt: IsoDateTimeSchema,
    /**
     * Defaults are the read-compatibility policy, not a migration. A record written before this
     * existed resolves to environmental-only, never and no failure modes in memory; merely
     * opening that world neither rewrites its file nor bumps its version.
     */
    audio: AudioPolicySchema.default(DEFAULT_AUDIO_POLICY),
    failureModes: FailureModesSchema,
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
    /**
     * Accepted takes made under the look as it stands.
     *
     * Distinct from `earlierAcceptedTakes`, which counts what is already behind. The moment a
     * change to the look lands, these join them — so this is the number a proposal's ripple has
     * to add in when it says how much work stays pinned to the look it is replacing. Counting
     * only what was already old told somebody the consequence of the *last* change rather than
     * of the one in front of them.
     *
     * Optional because reach is derived at scan and also hand-built in fixtures: absent means
     * nobody counted, which reads as zero, rather than forcing every constructed world to state
     * a number it does not have.
     */
    acceptedTakesAtCurrentVersion: z.number().int().min(0).optional(),
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
    keyArtIntent: KeyArtIntentSchema.nullable().optional(),
    acceptedAt: IsoDateTimeSchema.optional(),
    audio: AudioPolicySchema.default(DEFAULT_AUDIO_POLICY),
    failureModes: FailureModesSchema,
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
  // A world with no record still has a policy: the defaults. Resolving to "no policy" would
  // make the absence of a file mean something different from the presence of an unedited one.
  return {
    version: 1,
    description: deriveArtDirectionDescription(meta),
    audio: DEFAULT_AUDIO_POLICY,
    failureModes: [],
    history: [],
    derived: true,
  };
}
