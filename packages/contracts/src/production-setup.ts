import { z } from "zod";
import { ConversationIdSchema, SlugSchema, UlidSchema, Sha256Schema, TurnIdSchema } from "./ids.js";
import { FrameRateSchema, SeasonSchema, pickableSheets, type Sheet } from "./world.js";
import { ScriptBlockSchema } from "./scene.js";
import { NarrativeFieldsSchema } from "./production-narrative.js";
import { ProductionCreationPlanSchema } from "./production-creation.js";

export const PRODUCTION_SETUP_BOUNDS = {
  episodes: 50, scenes: 300, arcs: 50, blocks: 200, references: 100, questions: 100,
  title: 160, prose: 20_000, question: 2_000, bytes: 1_048_576,
} as const;
const Key = SlugSchema.max(80);
const Title = z.string().trim().min(1).max(PRODUCTION_SETUP_BOUNDS.title);
const Prose = z.string().max(PRODUCTION_SETUP_BOUNDS.prose);
const Keys = z.array(Key).max(PRODUCTION_SETUP_BOUNDS.scenes);
export const SetupKindSchema = z.enum(["microdrama", "film", "music-video", "other"]);
export const SetupEpisodeSchema = z.object({
  key: Key,
  title: Title,
  promise: z.object({ opens: Prose.optional(), turn: Prose.optional(), closes: Prose.optional() }).strict().optional(),
  scenes: Keys,
}).strict();
export const SetupSceneSchema = z.object({
  key: Key,
  title: Title,
  synopsis: Prose.optional(),
  inherits: z.object({ location: SlugSchema.optional(), timeOfDay: Prose.optional(), tone: Prose.optional() }).strict().optional(),
  scriptBlocks: z.array(ScriptBlockSchema.extend({ text: Prose.min(1) }).strict()).max(PRODUCTION_SETUP_BOUNDS.blocks).optional(),
}).strict();
const SetupArcSchema = z.object({
  id: Key, title: Title, note: Prose.optional(),
  setup: Key.optional(), turn: Key.optional(), payoff: Key.optional(),
}).strict();
const SetupFieldsSchema = z.object({
  title: z.string().trim().max(PRODUCTION_SETUP_BOUNDS.title),
  logline: Prose.optional(),
  kind: SetupKindSchema,
  aspect: z.string().min(1).max(40),
  frameRate: FrameRateSchema,
  defaults: SeasonSchema.shape.defaults,
  series: z.object({ title: Title, engine: Prose.optional(), continuity: Prose.optional() }).strict().optional(),
  narrative: NarrativeFieldsSchema,
  arcs: z.array(SetupArcSchema).max(PRODUCTION_SETUP_BOUNDS.arcs),
  references: z.array(SlugSchema).max(PRODUCTION_SETUP_BOUNDS.references),
  openQuestions: z.array(z.string().min(1).max(PRODUCTION_SETUP_BOUNDS.question)).max(PRODUCTION_SETUP_BOUNDS.questions),
}).strict();
export const ProductionSetupDraftSchema = SetupFieldsSchema.extend({
  schemaVersion: z.literal(1),
  setupId: ConversationIdSchema,
  worldId: UlidSchema,
  revision: z.number().int().min(1),
  episodes: z.array(SetupEpisodeSchema).max(PRODUCTION_SETUP_BOUNDS.episodes),
  scenes: z.array(SetupSceneSchema).max(PRODUCTION_SETUP_BOUNDS.scenes),
}).strict().superRefine((draft, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(draft)).length > PRODUCTION_SETUP_BOUNDS.bytes) {
    ctx.addIssue({ code: "custom", message: "Production so far exceeds the 1 MiB draft limit." });
  }
  for (const field of ["episodes", "scenes"] as const) {
    const seen = new Set<string>();
    draft[field].forEach((item, index) => {
      if (seen.has(item.key)) ctx.addIssue({ code: "custom", path: [field, index, "key"], message: "This outline key is already in use." });
      seen.add(item.key);
    });
  }
});
export type ProductionSetupDraft = z.infer<typeof ProductionSetupDraftSchema>;

/** Omitted items survive a turn. Removal and ordering must be intentional. */
export const ProductionSetupUpdateSchema = z.object({
  expectedRevision: z.number().int().min(1),
  fields: SetupFieldsSchema.partial().extend({
    series: SetupFieldsSchema.shape.series.nullable(),
    defaults: SetupFieldsSchema.shape.defaults.nullable(),
  }).strict().optional(),
  episodes: z.array(SetupEpisodeSchema.partial().extend({ key: Key }).strict()).max(PRODUCTION_SETUP_BOUNDS.episodes).optional(),
  scenes: z.array(SetupSceneSchema.partial().extend({
    key: Key,
    inherits: z.object({
      location: SlugSchema.nullable().optional(), timeOfDay: Prose.nullable().optional(), tone: Prose.nullable().optional(),
    }).strict().nullable().optional(),
  }).strict()).max(PRODUCTION_SETUP_BOUNDS.scenes).optional(),
  removeEpisodes: z.array(Key).max(PRODUCTION_SETUP_BOUNDS.episodes).optional(),
  removeScenes: Keys.optional(),
  episodeOrder: z.array(Key).max(PRODUCTION_SETUP_BOUNDS.episodes).optional(),
  sceneOrder: Keys.optional(),
}).strict();
export type ProductionSetupUpdate = z.infer<typeof ProductionSetupUpdateSchema>;

function items<T extends { key: string }>(current: T[], replacements: Array<Partial<T> & { key: string }> = [], removed: string[] = [], order?: string[]): T[] {
  if (new Set(replacements.map(item => item.key)).size !== replacements.length) throw new Error("An update repeats an outline key.");
  if (removed.some(key => replacements.some(item => item.key === key))) throw new Error("An outline item cannot be removed and revised together.");
  if (removed.some(key => !current.some(item => item.key === key))) throw new Error("The outline item to remove no longer exists.");
  const byKey = new Map(current.filter(item => !removed.includes(item.key)).map(item => [item.key, item]));
  for (const item of replacements) byKey.set(item.key, { ...byKey.get(item.key), ...item } as T);
  if (!order) return [...byKey.values()];
  if (order.length !== byKey.size || new Set(order).size !== order.length || order.some(key => !byKey.has(key))) {
    throw new Error("An outline order must name every remaining item exactly once.");
  }
  return order.map(key => byKey.get(key)!);
}

export function applyProductionSetupUpdate(draft: ProductionSetupDraft, raw: ProductionSetupUpdate): ProductionSetupDraft {
  const update = ProductionSetupUpdateSchema.parse(raw);
  if (draft.revision !== update.expectedRevision) throw new Error("Production so far changed. Read the current draft before editing it.");

  return ProductionSetupDraftSchema.parse({
    ...draft, ...update.fields, revision: draft.revision + 1,
    narrative: { ...draft.narrative, ...update.fields?.narrative },
    series: update.fields?.series === null ? undefined : update.fields?.series
      ? { ...draft.series, ...update.fields.series } : draft.series,
    defaults: update.fields?.defaults === null ? undefined : update.fields?.defaults
      ? { ...draft.defaults, ...update.fields.defaults } : draft.defaults,
    episodes: items(draft.episodes, update.episodes?.map(episode => ({ ...episode,
      ...(episode.promise ? { promise: { ...draft.episodes.find(item => item.key === episode.key)?.promise, ...episode.promise } } : {}),
    })), update.removeEpisodes, update.episodeOrder),
    scenes: items(draft.scenes, update.scenes?.map(scene => {
      const { inherits, ...fields } = scene;
      return { ...fields, ...(inherits === undefined ? {} : {
        inherits: inherits === null ? undefined : Object.fromEntries(Object.entries({
          ...draft.scenes.find(item => item.key === scene.key)?.inherits, ...inherits,
        }).filter(([, value]) => value !== null)),
      }) };
    }), update.removeScenes, update.sceneOrder),
  });
}

/** Structural problems stay visible while discussing an unfinished or retracted outline. */
export function productionSetupProblems(draft: ProductionSetupDraft, sheets: Sheet[]): string[] {
  const problems: string[] = [];
  if (!draft.title.trim()) problems.push("Give the production a working title.");
  const episodic = draft.kind === "microdrama";
  if (!episodic && (draft.episodes.length || draft.arcs.length)) problems.push("This format owns scenes directly. Remove the episodes and season arcs, or choose Micro drama.");
  if (!episodic && draft.series) problems.push("This format does not belong to a Series. Clear the Series or choose Micro drama.");
  if (episodic && draft.narrative.arcNotes) problems.push("Move the film arc notes into season direction or named season arcs.");
  const sceneKeys = new Set(draft.scenes.map(scene => scene.key));
  const episodeKeys = new Set(draft.episodes.map(episode => episode.key));
  const membership = new Map<string, string>();
  for (const episode of draft.episodes) for (const key of episode.scenes) {
    if (!sceneKeys.has(key)) problems.push(`“${episode.title}” names a scene that was removed: ${key}.`);
    if (membership.has(key)) problems.push(`Scene ${key} belongs to more than one episode or appears twice.`);
    membership.set(key, episode.key);
  }
  if (episodic) for (const scene of draft.scenes) {
    if (!membership.has(scene.key)) problems.push(`Choose an episode for “${scene.title}”.`);
  }
  const arcIds = new Set<string>();
  for (const arc of draft.arcs) {
    if (arcIds.has(arc.id)) problems.push(`The arc key ${arc.id} is repeated.`);
    arcIds.add(arc.id);
    for (const part of ["setup", "turn", "payoff"] as const) {
      if (arc[part] && !episodeKeys.has(arc[part])) problems.push(`“${arc.title}” names a removed episode for its ${part}.`);
    }
  }
  const eligible = pickableSheets(sheets, undefined).filter(sheet => !sheet.retired);
  const has = (id: string, type?: string) => eligible.some(sheet => sheet.id === id && (!type || sheet.type === type));
  for (const id of draft.references) if (!has(id)) problems.push(`World reference ${id} is unavailable. Resolve it or keep it as an open question.`);
  for (const scene of draft.scenes) {
    if (scene.inherits?.location && !has(scene.inherits.location, "location")) problems.push(`Resolve the location in “${scene.title}”.`);
    const blockIds = new Set<string>();
    for (const block of scene.scriptBlocks ?? []) {
      if (blockIds.has(block.id)) problems.push(`“${scene.title}” repeats script block ${block.id}.`);
      blockIds.add(block.id);
      if ((block.kind === "dialogue" && !block.speaker) || (block.speaker && !has(block.speaker, "character"))) {
        problems.push(`Resolve the speaker in “${scene.title}”, block ${block.id}.`);
      }
    }
  }
  const defaults = draft.defaults;
  if (defaults?.episodeSecondsMin && defaults.episodeSecondsMax && defaults.episodeSecondsMin > defaults.episodeSecondsMax) {
    problems.push("Episode minimum duration exceeds its maximum.");
  }
  return problems;
}

export const ProductionSetupReviewSchema = z.object({
  id: UlidSchema,
  plan: ProductionCreationPlanSchema,
  /** Digest of complete relevant world records, rechecked inside the commit write gate. */
  sourceDigest: Sha256Schema,
}).strict();
export const ProductionSetupStateSchema = z.object({
  draft: ProductionSetupDraftSchema,
  status: z.enum(["draft", "reviewed", "creating", "created", "discarded"]),
  review: ProductionSetupReviewSchema.nullable(),
  productionId: SlugSchema.optional(),
  problem: z.string().optional(),
}).strict();
export type ProductionSetupState = z.infer<typeof ProductionSetupStateSchema>;

export const ProductionSetupCommandSchema = z.object({
  kind: z.literal("production-setup"),
  worldId: UlidSchema,
  setupId: ConversationIdSchema,
  requestId: UlidSchema,
  action: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("start") }).strict(),
    z.object({ operation: z.literal("update"), update: ProductionSetupUpdateSchema }).strict(),
    z.object({ operation: z.literal("review"), expectedRevision: z.number().int().min(1) }).strict(),
    z.object({ operation: z.literal("create"), expectedRevision: z.number().int().min(1), reviewId: UlidSchema }).strict(),
    z.object({ operation: z.literal("discard") }).strict(),
    z.object({ operation: z.literal("resume") }).strict(),
    z.object({ operation: z.literal("send"), text: z.string().trim().min(1).max(100_000), modelId: z.string().min(1).optional() }).strict(),
    z.object({ operation: z.literal("cancel") }).strict(),
    z.object({ operation: z.literal("retry"), turnId: TurnIdSchema }).strict(),
  ]),
}).strict();
export type ProductionSetupCommand = z.infer<typeof ProductionSetupCommandSchema>;
