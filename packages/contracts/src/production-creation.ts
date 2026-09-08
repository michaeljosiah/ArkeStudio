import { z } from "zod";
import { ConversationIdSchema, SlugSchema, UlidSchema } from "./ids.js";
import { EpisodeSchema, ProductionSchema, SeasonSchema, SeriesSchema } from "./world.js";
import { SceneRecordSchema, validateSceneFlow } from "./scene-flow.js";
import { ProductionNarrativeSchema } from "./production-narrative.js";

/** Journalled operational association; discussion remains in the private conversation log. */
export const ProductionSetupOriginSchema = z.object({
  worldId: UlidSchema, setupId: ConversationIdSchema, revision: z.number().int().min(1),
  productionId: SlugSchema, requestId: UlidSchema,
}).strict();

/** Every id and record is frozen before review; paths are derived only by the coordinator. */
export const ProductionCreationPlanSchema = z.object({
  production: ProductionSchema,
  initialSeason: SeasonSchema.nullable(),
  series: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("none") }).strict(),
    z.object({ operation: z.literal("create"), record: SeriesSchema }).strict(),
    z.object({ operation: z.literal("join"), record: SeriesSchema }).strict(),
  ]),
  initialContent: z.object({
    worldId: UlidSchema,
    setupId: ConversationIdSchema,
    revision: z.number().int().min(1),
    narrative: ProductionNarrativeSchema.nullable(),
    episodes: z.array(z.object({ stem: SlugSchema, record: EpisodeSchema }).strict()).max(50),
    scenes: z.array(z.object({ stem: SlugSchema, record: SceneRecordSchema }).strict()).max(300),
  }).strict().optional(),
}).strict();
export type ProductionCreationPlan = z.infer<typeof ProductionCreationPlanSchema>;

/** Even internal prepared plans are checked at the common creation boundary. */
export function validateInitialContent(plan: ProductionCreationPlan): void {
  const content = plan.initialContent;
  if (!content) return;
  if (!plan.initialSeason && (content.episodes.length || plan.series.operation !== "none")) {
    throw new Error("A film cannot contain season episodes.");
  }
  if (plan.initialSeason && content.narrative) throw new Error("A season cannot contain a film narrative.");
  for (const entries of [content.episodes, content.scenes]) {
    if (new Set(entries.map(entry => entry.stem)).size !== entries.length ||
        new Set(entries.map(entry => entry.record.id)).size !== entries.length) throw new Error("The creation plan repeats an id or filename.");
  }
  const scenes = new Set(content.scenes.map(scene => scene.record.id));
  const episodes = new Set(content.episodes.map(episode => episode.record.id));
  const membership = new Set<string>();
  for (const episode of content.episodes) for (const id of episode.record.scenes) {
    if (!scenes.has(id) || membership.has(id)) throw new Error("The creation plan has invalid episode membership.");
    membership.add(id);
  }
  if (plan.initialSeason && membership.size !== scenes.size) throw new Error("Every season scene needs an episode.");
  for (const arc of plan.initialSeason?.arcs ?? []) for (const part of ["setup", "turn", "payoff"] as const) {
    if (arc[part] && !episodes.has(arc[part])) throw new Error("A season arc names an episode outside the plan.");
  }
  for (const { record } of content.scenes) {
    if (!("flow" in record) || validateSceneFlow(record.flow).length) throw new Error("Setup scenes must use a valid current graph.");
  }
}
