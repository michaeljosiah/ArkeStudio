import { z } from "zod";
import { ArkeReadRequirementSchema, ConversationActionSemanticIdSchema } from "./arke-actions.js";

/** The complete target reads available only through a run-scoped World Chat lease. */
export const ArkeTargetReadToolSchema = z.enum([
  "get_world_metadata",
  "list_world_index",
  "list_canon",
  "list_sheets",
  "get_bible",
  "get_art_direction",
  "list_references",
  "list_artifacts",
  "list_voices",
  "list_productions",
  "list_series",
  "get_production_metadata",
  "get_story",
  "get_season",
  "list_episodes",
  "list_chapters",
  "get_chapter",
  "list_scenes",
  "get_scene",
  "get_scene_script",
  "get_scene_shots",
  "get_scene_stage",
  "get_scene_boards",
  "list_takes",
  "get_timeline",
  "get_spine",
  "get_routing",
  "list_plans",
  "list_jobs",
  "list_exports",
]);
export type ArkeTargetReadTool = z.infer<typeof ArkeTargetReadToolSchema>;

/** Semantic identity of the authority observed by a target read; never a host path. */
export const ArkeReadTargetSchema = z
  .object({
    requirement: ArkeReadRequirementSchema,
    id: ConversationActionSemanticIdSchema,
  })
  .strict();
export type ArkeReadTarget = z.infer<typeof ArkeReadTargetSchema>;

/** Uniform result envelope for bounded target reads. */
export const ArkeTargetReadPageSchema = z
  .object({
    target: ArkeReadTargetSchema,
    observedRevisionOrDigest: z.string().min(1).max(200),
    items: z.array(z.unknown()),
    total: z.number().int().min(0),
    nextCursor: z.string().min(1).max(2_000).nullable(),
    complete: z.boolean(),
  })
  .strict();
export type ArkeTargetReadPage = z.infer<typeof ArkeTargetReadPageSchema>;
