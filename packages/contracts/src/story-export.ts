import { z } from "zod";
import { STORY_KINDS, STORY_SHAPES } from "./world-package.js";

/**
 * Export → Arke Player for an interactive movie or a visual novel (design turn 245, SPEC-058 R-89):
 * what the sheet counts before anything is made, what stands in the way, and what a made package
 * says it holds. The coordinator reads the production the way the export will, so the sheet's rows
 * and blockers are the export's own (245a – 245c), and Make package waits until none is left.
 */

const Count = z.number().int().min(0);

/**
 * One thing that keeps the package from being made (245c): a clause, and what clears it — `Go to`
 * the scene, or `Show` the route that reaches the state at fault (SPEC-063 R-16's witness).
 */
export const StoryExportBlockerSchema = z
  .object({
    /** One clause, as the sheet says it: `Under the pier · no clip`. */
    detail: z.string().min(1).max(2000),
    /** The row it counts against: the story itself, or a scene's clips or pictures. */
    row: z.enum(["story", "media"]),
    /** The scene `Go to` opens. */
    sceneId: z.string().min(1).max(128).optional(),
    /** The route `Show` plays, as choice ids from the start. */
    route: z.array(z.string().min(1).max(128)).max(2048).optional(),
  })
  .strict();
export type StoryExportBlocker = z.infer<typeof StoryExportBlockerSchema>;

/** What the package would hold (245a, 245b), counted as the export counts it. */
export const StoryExportStateSchema = z
  .object({
    kind: z.enum(STORY_KINDS),
    shape: z.enum(STORY_SHAPES),
    /** The scenes a route reaches, and the choices leaving them. */
    scenes: Count,
    choices: Count,
    facts: Count,
    endings: Count,
    /**
     * Choices closed in some state a route reaches (SPEC-063 R-11), and how many carry the author's
     * reason; the rest are hidden, never a blocker (turn 245, call 3).
     */
    closed: z.object({ count: Count, reasoned: Count }).strict(),
    /** A movie's clips, one a scene: how many there are of the scenes, how long they play, their size, and how many are re-encoded. */
    clips: z.object({ count: Count, of: Count, ms: Count, width: Count.optional(), height: Count.optional(), reencoded: Count }).strict().optional(),
    /** A novel's beats: those with a picture, those with a Tall too (R-87), and how many there are. */
    pictures: z.object({ beats: Count, wide: Count, tall: Count, files: Count }).strict().optional(),
    /** A novel's lines, and how many of them are voiced; the rest play as text. */
    voices: z.object({ lines: Count, voiced: Count }).strict().optional(),
    /** The estimate: the package's bytes, and how long this machine takes to make it. */
    bytes: Count,
    seconds: Count,
    blockers: z.array(StoryExportBlockerSchema).max(1000),
  })
  .strict();
export type StoryExportState = z.infer<typeof StoryExportStateSchema>;

/**
 * A made story package (245d): its kind, its scenes, the routes the read-back replayed through the
 * compiled document and whether that was every route, and its endings.
 */
export const StoryExportMadeSchema = z
  .object({
    kind: z.enum(STORY_KINDS),
    scenes: Count,
    routes: Count,
    /** False when the walk stopped at its bound, so `routes` is not every route (SPEC-063 R-6 allows loops). */
    complete: z.boolean(),
    endings: Count,
  })
  .strict();
export type StoryExportMade = z.infer<typeof StoryExportMadeSchema>;

/** The read-back line (245d): `37 of 37 routes · 2 endings`. */
export function storyReadBackLine(made: StoryExportMade): string {
  const endings = `${made.endings} ending${made.endings === 1 ? "" : "s"}`;
  return made.complete ? `${made.routes} of ${made.routes} route${made.routes === 1 ? "" : "s"} · ${endings}` : `${made.routes} routes · more past the bound · ${endings}`;
}
