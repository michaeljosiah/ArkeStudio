import { z } from "zod";
import { IsoDateTimeSchema, SlugSchema } from "./ids.js";

export const ShotCharacterPresentationSchema = z.enum([
  "face-front",
  "face-three-quarter",
  "face-profile",
  "turned-away",
  "back-of-head",
  "body-only",
  "unknown",
]);

export const ShotVisualCharacterFactSchema = z
  .object({
    characterId: SlugSchema,
    presentation: ShotCharacterPresentationSchema,
    depth: z.enum(["foreground", "midground", "background"]),
  })
  .strict();

export const ShotVisualFactsSchema = z
  .object({
    /** Explicit authored on-screen cast, never inferred or detected. */
    onScreenCharacters: z
      .array(ShotVisualCharacterFactSchema)
      .superRefine((characters, ctx) => {
        const seen = new Set<string>();
        for (const [index, character] of characters.entries()) {
          if (seen.has(character.characterId)) {
            ctx.addIssue({
              code: "custom",
              path: [index, "characterId"],
              message: "character appears more than once",
            });
          }
          seen.add(character.characterId);
        }
      }),
    composition: z.enum([
      "single",
      "two-shot",
      "group",
      "over-the-shoulder",
      "wide",
      "other",
    ]),
    confirmedAt: IsoDateTimeSchema,
  })
  .strict();

export type ShotVisualFacts = z.infer<typeof ShotVisualFactsSchema>;
