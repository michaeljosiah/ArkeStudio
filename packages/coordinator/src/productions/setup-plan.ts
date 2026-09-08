import {
  EpisodeSchema, ProductionCreationPlanSchema, ProductionNarrativeSchema,
  ProductionSetupDraftSchema, SceneRecordSchema, SeasonSchema, SeriesSchema,
  migrateLegacyScene, normalizeAspect, pickableSheets, productionSetupProblems,
  type ProductionCreationPlan, type ProductionSetupDraft, type WorldBundle,
} from "@arke-studio/contracts";
import { stableJson } from "../arke-actions/digest.js";
import { sha256 } from "../world/text-files.js";
import { planProductionCreation } from "./ops.js";

/** Full relevant records, not a windowed search or just version numbers. */
export function setupSourceDigest(bundle: WorldBundle): string {
  return sha256(stableJson({
    worldId: bundle.meta.worldId,
    canon: bundle.canon,
    bible: bundle.bible,
    sheets: pickableSheets(bundle.sheets, undefined),
    productions: bundle.productions.map(production => production.meta.id).sort(),
    series: bundle.series,
  }));
}

export function planProductionSetup(bundle: WorldBundle, raw: ProductionSetupDraft, at: string): ProductionCreationPlan {
  const draft = ProductionSetupDraftSchema.parse(raw);
  if (draft.worldId !== bundle.meta.worldId) throw new Error("This setup belongs to another world.");
  const problems = productionSetupProblems(draft, bundle.sheets);
  if (problems.length) throw new Error(problems.join("\n"));
  if (!normalizeAspect(draft.aspect)) throw new Error("Choose a valid aspect, such as 16:9 or 9:16.");
  const base = planProductionCreation(bundle, {
    title: draft.title, medium: "video", ...(draft.kind !== "other" ? { productionKind: draft.kind } : {}),
    aspect: draft.aspect, frameRate: draft.frameRate,
    ...(draft.logline !== undefined ? { logline: draft.logline } : {}),
    ...(draft.defaults ? { defaults: draft.defaults } : {}),
    ...(draft.series ? { seriesTitle: draft.series.title } : {}),
  }, at);
  // Keys, not titles, select stable ids and stems. Renaming an item changes no membership.
  const sceneId = (key: string) => `sc_${key}`;
  const episodeId = (key: string) => `ep_${key}`;
  const scenes = draft.scenes.map((scene, index) => ({
    stem: scene.key,
    record: SceneRecordSchema.parse({
      ...migrateLegacyScene({
        id: sceneId(scene.key), number: index + 1, order: index + 1, slug: scene.key,
        title: scene.title, status: "draft", version: 1, shots: [],
      }),
      ...(scene.synopsis !== undefined ? { synopsis: scene.synopsis } : {}),
      ...(scene.inherits ? { inherits: scene.inherits } : {}),
      ...(scene.scriptBlocks ? { script: { blocks: scene.scriptBlocks } } : {}),
    }),
  }));
  const episodes = draft.episodes.map((episode, index) => ({
    stem: episode.key,
    record: EpisodeSchema.parse({
      id: episodeId(episode.key), version: 1, order: index + 1, title: episode.title,
      ...(episode.promise ? { promise: episode.promise } : {}),
      scenes: episode.scenes.map(sceneId),
    }),
  }));
  if (base.initialSeason) {
    const { arcNotes: _arcNotes, ...narrative } = draft.narrative;
    base.initialSeason = SeasonSchema.parse({
      ...base.initialSeason, ...narrative,
      arcs: draft.arcs.map(arc => ({
        ...arc,
        ...(arc.setup ? { setup: episodeId(arc.setup) } : {}),
        ...(arc.turn ? { turn: episodeId(arc.turn) } : {}),
        ...(arc.payoff ? { payoff: episodeId(arc.payoff) } : {}),
      })),
    });
  }
  if (base.series.operation !== "none" && draft.series) {
    base.series.record = SeriesSchema.parse({
      ...base.series.record,
      ...(draft.series.engine !== undefined ? { engine: draft.series.engine } : {}),
      ...(draft.series.continuity !== undefined ? { continuity: draft.series.continuity } : {}),
    });
  }
  return ProductionCreationPlanSchema.parse({
    ...base,
    initialContent: {
      worldId: draft.worldId, setupId: draft.setupId, revision: draft.revision,
      narrative: base.initialSeason || Object.keys(draft.narrative).length === 0
        ? null : ProductionNarrativeSchema.parse({ version: 1, ...draft.narrative }),
      episodes, scenes,
    },
  });
}

