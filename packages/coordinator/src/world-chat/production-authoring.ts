import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChapterFrontmatterSchema,
  EpisodeSchema,
  SceneRecordSchema,
  SeasonSchema,
  SeriesSchema,
  StoryOverviewSchema,
  isGraphScene,
  migrateLegacyScene,
  productionShape,
  type ConversationActionPrepareIntent,
  type Proposal,
  type WorldChatProductionChapterAction,
  type WorldChatProductionEpisodeAction,
  type WorldChatProductionOverviewAction,
  type WorldChatProductionSceneAction,
  type WorldChatProductionSeasonAction,
  type WorldChatProductionSeriesAction,
} from "@arke-studio/contracts";
import type { ProposalManager } from "../gate/proposals.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { slugify, uniqueSlug } from "../world/slug.js";
import { MarkdownFile } from "../world/text-files.js";
import type { WorldStatePrecondition, WorldStore } from "../world/store.js";

export type WorldChatProductionAuthoredAction =
  | WorldChatProductionSeriesAction
  | WorldChatProductionOverviewAction
  | WorldChatProductionSeasonAction
  | WorldChatProductionEpisodeAction
  | WorldChatProductionChapterAction
  | WorldChatProductionSceneAction;

function proposalContext(intent: Pick<ConversationActionPrepareIntent, "actionId" | "conversationId">) {
  return {
    source: `world-chat-action:${intent.actionId}`,
    origin: {
      surface: "world-chat",
      gesture: "conversation-action",
      conversationId: intent.conversationId,
    },
    decision: {
      mode: "attended" as const,
      owner: { kind: "world-chat" as const, conversationId: intent.conversationId },
    },
  };
}

async function readLive(store: WorldStore, path: string): Promise<string> {
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8").catch(() => null);
  if (raw === null) throw new Error(`${path} does not exist`);
  return raw;
}

function withoutCleared<T extends Record<string, unknown>>(
  current: T,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function requireProduction(store: WorldStore, productionId: string) {
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
  if (!production) throw new Error(`production ${productionId} is not in this world`);
  return production;
}

function requireProductionIds(store: WorldStore, productionIds: readonly string[]): void {
  const ids = new Set(store.getBundle().productions.map((production) => production.meta.id));
  const missing = productionIds.find((id) => !ids.has(id));
  if (missing) throw new Error(`production ${missing} is not in this world`);
}

function requireSceneIds(production: ReturnType<typeof requireProduction>, sceneIds: readonly string[]): void {
  const ids = new Set(production.scenes.map((scene) => scene.id));
  const missing = sceneIds.find((id) => !ids.has(id));
  if (missing) throw new Error(`scene ${missing} is not in ${production.meta.id}`);
}

function requireEpisodeIds(production: ReturnType<typeof requireProduction>, episodeIds: readonly string[]): void {
  const ids = new Set(production.episodes.map((episode) => episode.id));
  const missing = episodeIds.find((id) => !ids.has(id));
  if (missing) throw new Error(`episode ${missing} is not in ${production.meta.id}`);
}

function requireEpisodeReferences(
  production: ReturnType<typeof requireProduction>,
  linked: { closesInto?: string; opensFrom?: string } | null | undefined,
  thumbnailTakeId?: string,
): void {
  if (linked) requireEpisodeIds(production, [linked.closesInto, linked.opensFrom].filter((id): id is string => id !== undefined));
  if (thumbnailTakeId && !production.takes.some((take) => take.id === thumbnailTakeId)) {
    throw new Error(`take ${thumbnailTakeId} is not in ${production.meta.id}`);
  }
}

function requireDraws(
  store: WorldStore,
  draws: { sheets: readonly string[]; canon: readonly string[] } | null | undefined,
): void {
  if (!draws) return;
  const sheets = new Set(store.getBundle().sheets.map((sheet) => sheet.id));
  const canon = new Set(store.getBundle().canon.map((entry) => entry.id));
  const missingSheet = draws.sheets.find((id) => !sheets.has(id));
  if (missingSheet) throw new Error(`sheet ${missingSheet} is not in this world`);
  const missingCanon = draws.canon.find((id) => !canon.has(id));
  if (missingCanon) throw new Error(`Canon entry ${missingCanon} is not in this world`);
}

function requireSceneLocation(store: WorldStore, locationId: string | undefined): void {
  if (locationId === undefined) return;
  const location = store.getBundle().sheets.find((sheet) => sheet.id === locationId && sheet.type === "location");
  if (!location) throw new Error(`location ${locationId} is not in this world`);
}

function proposedTargetStems(store: WorldStore, pattern: RegExp): string[] {
  return store.getBundle().proposals.flatMap((staged) =>
    staged.proposal.targets.flatMap((target) => pattern.exec(target.path)?.[1] ?? []));
}

/** Materialise one typed Production Chat authored change into ProposalManager. */
export async function stageWorldChatProductionAuthoredAction(
  store: WorldStore,
  gate: ProposalManager,
  intent: Pick<ConversationActionPrepareIntent, "actionId" | "conversationId">,
  payload: WorldChatProductionAuthoredAction,
  precondition?: WorldStatePrecondition,
): Promise<Proposal> {
  const production = requireProduction(store, payload.action.productionId);
  const context = proposalContext(intent);

  if (payload.kind === "world-chat-production-series") {
    const change = payload.action.change;
    if (change.operation === "create") {
      if (!productionShape(production.meta).isEpisodic) {
        throw new Error(`${production.meta.title} is not an episodic production`);
      }
      const existingSeries = store.getBundle().series.find((series) => series.seasons.includes(production.meta.id));
      if (existingSeries) {
        throw new Error(`${production.meta.title} already belongs to Series ${existingSeries.title}`);
      }
      if (change.seasons.some((id) => id !== production.meta.id)) {
        throw new Error("A new Series begins with the current production; other seasons join through their own metadata action.");
      }
      const seasons = [production.meta.id];
      requireProductionIds(store, seasons);
      const id = uniqueSlug(change.title, "series", [
        ...store.getBundle().series.map((series) => series.id),
        ...proposedTargetStems(store, /^series\/([^/]+)\.json$/),
      ]);
      const record = SeriesSchema.parse({
        id,
        version: 1,
        title: change.title,
        ...(change.engine !== undefined ? { engine: change.engine } : {}),
        ...(change.continuity !== undefined ? { continuity: change.continuity } : {}),
        seasons,
        created: store.now(),
        updated: store.now(),
      });
      return gate.stage({
        kind: "series-edit",
        summary: `New Series: ${record.title}`,
        ...context,
        targets: [{ path: `series/${record.id}.json`, content: `${JSON.stringify(record, null, 2)}\n` }],
      }, precondition);
    }
    const current = store.getBundle().series.find((series) => series.id === change.seriesId);
    if (!current) throw new Error(`series ${change.seriesId} is not in this world`);
    if (!current.seasons.includes(production.meta.id)) {
      throw new Error(`Series ${current.title} does not belong to ${production.meta.title}`);
    }
    if (change.changes.seasons) {
      requireProductionIds(store, change.changes.seasons);
      if (
        change.changes.seasons.length !== current.seasons.length ||
        new Set(change.changes.seasons).size !== change.changes.seasons.length ||
        change.changes.seasons.some((id) => !current.seasons.includes(id))
      ) throw new Error("Series ordering must contain every current season exactly once; association changes through production metadata.");
    }
    const record = SeriesSchema.parse(withoutCleared(current, {
      ...change.changes,
      updated: store.now(),
    }));
    return gate.stage({
      kind: "series-edit",
      summary: `Edit Series: ${current.title}`,
      ...context,
      targets: [{ path: `series/${current.id}.json`, content: `${JSON.stringify(record, null, 2)}\n` }],
    }, precondition);
  }

  if (payload.kind === "world-chat-production-overview") {
    const current = production.story ?? { version: 1 };
    const record = StoryOverviewSchema.parse(withoutCleared(current, payload.action.changes));
    return gate.stage({
      kind: "story-overview",
      summary: `Story overview: ${production.meta.title}`,
      ...context,
      targets: [{
        path: `productions/${production.meta.id}/story.json`,
        content: `${JSON.stringify(record, null, 2)}\n`,
      }],
    }, precondition);
  }

  if (payload.kind === "world-chat-production-season") {
    if (!productionShape(production.meta).isEpisodic) {
      throw new Error(`${production.meta.title} is not an episodic production`);
    }
    for (const arc of payload.action.changes.arcs ?? []) {
      requireEpisodeIds(production, [arc.setup, arc.turn, arc.payoff].filter((id): id is string => id !== undefined));
    }
    const current = production.season ?? { version: 1 };
    const record = SeasonSchema.parse(withoutCleared(current, payload.action.changes));
    return gate.stage({
      kind: "season-edit",
      summary: `Season: ${production.meta.title}`,
      ...context,
      targets: [{
        path: `productions/${production.meta.id}/season.json`,
        content: `${JSON.stringify(record, null, 2)}\n`,
      }],
    }, precondition);
  }

  if (payload.kind === "world-chat-production-episode") {
    const change = payload.action.change;
    if (!productionShape(production.meta).isEpisodic) {
      throw new Error(`${production.meta.title} is not an episodic production`);
    }
    if (change.operation === "create") {
      requireSceneIds(production, change.scenes);
      requireEpisodeReferences(production, change.linked, change.release?.thumbnailTakeId);
      const base = slugify(change.title).slice(0, 60) || "episode";
      const takenIds = new Set(production.episodes.map((episode) => episode.id));
      const takenStems = new Set([
        ...Object.values(production.episodeFiles),
        ...proposedTargetStems(store, new RegExp(`^productions/${production.meta.id}/episodes/([^/]+)\\.json$`)),
      ]);
      let id = `ep_${base}`;
      let stem = base;
      for (let n = 2; takenIds.has(id) || takenStems.has(stem); n++) {
        id = `ep_${base}-${n}`;
        stem = `${base}-${n}`;
      }
      const orders = production.episodes.map((episode) => episode.order);
      // Distinct pending files can all be accepted, so each also reserves its place in the season.
      for (const staged of store.getBundle().proposals) {
        for (const target of staged.proposal.targets) {
          if (target.baseHash !== null || !target.path.startsWith(`productions/${production.meta.id}/episodes/`)) continue;
          const raw = await readFile(toExtendedLength(join(store.dir, ".proposals", staged.proposal.id, fromPortable(target.path))), "utf8");
          orders.push(EpisodeSchema.parse(JSON.parse(raw)).order);
        }
      }
      const record = EpisodeSchema.parse({
        id,
        version: 1,
        order: change.order ?? Math.max(0, ...orders) + 1,
        title: change.title,
        ...(change.promise !== undefined ? { promise: change.promise } : {}),
        scenes: change.scenes,
        ...(change.linked !== undefined ? { linked: change.linked } : {}),
        ...(change.release !== undefined ? { release: change.release } : {}),
      });
      return gate.stage({
        kind: "episode-edit",
        summary: `New episode: ${record.title}`,
        ...context,
        targets: [{
          path: `productions/${production.meta.id}/episodes/${stem}.json`,
          content: `${JSON.stringify(record, null, 2)}\n`,
        }],
      }, precondition);
    }
    const current = production.episodes.find((episode) => episode.id === change.episodeId);
    const stem = production.episodeFiles[change.episodeId];
    if (!current || !stem) throw new Error(`episode ${change.episodeId} is not in ${production.meta.id}`);
    if (change.changes.scenes) requireSceneIds(production, change.changes.scenes);
    requireEpisodeReferences(production, change.changes.linked, change.changes.release?.thumbnailTakeId);
    const record = EpisodeSchema.parse(withoutCleared(current, change.changes));
    return gate.stage({
      kind: "episode-edit",
      summary: `Edit episode: ${current.title}`,
      ...context,
      targets: [{
        path: `productions/${production.meta.id}/episodes/${stem}.json`,
        content: `${JSON.stringify(record, null, 2)}\n`,
      }],
    }, precondition);
  }

  if (payload.kind === "world-chat-production-chapter") {
    if (!productionShape(production.meta).hasChapters) {
      throw new Error(`${production.meta.title} does not use chapters`);
    }
    const change = payload.action.change;
    if (change.operation === "create") {
      requireDraws(store, change.draws);
      const stem = uniqueSlug(change.title, "chapter", [
        ...production.chapters.map((chapter) => chapter.file),
        ...proposedTargetStems(store, new RegExp(`^productions/${production.meta.id}/chapters/([^/]+)\\.md$`)),
      ]);
      const body = change.body;
      const doc = MarkdownFile.create({
        id: stem,
        title: change.title,
        order: change.order,
        status: change.status,
        version: 1,
        words: body.trim() === "" ? 0 : body.trim().split(/\s+/).length,
        ...(change.draws ? { draws: change.draws } : {}),
        created: store.now().slice(0, 10),
        updated: store.now().slice(0, 10),
      }, body);
      ChapterFrontmatterSchema.parse(doc.data);
      return gate.stage({
        kind: "chapter-draft",
        summary: `New chapter: ${change.title}`,
        ...context,
        targets: [{ path: `productions/${production.meta.id}/chapters/${stem}.md`, content: doc.serialize() }],
      }, precondition);
    }
    const chapter = production.chapters.find((candidate) =>
      candidate.id === change.chapterId || candidate.file === change.chapterId);
    if (!chapter) throw new Error(`chapter ${change.chapterId} is not in ${production.meta.id}`);
    requireDraws(store, change.changes.draws);
    const path = `productions/${production.meta.id}/chapters/${chapter.file}.md`;
    const doc = MarkdownFile.parse(await readLive(store, path));
    const changes = change.changes;
    doc.setData({
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.draws !== undefined ? { draws: changes.draws ?? undefined } : {}),
      ...(changes.body !== undefined
        ? { words: changes.body.trim() === "" ? 0 : changes.body.trim().split(/\s+/).length }
        : {}),
    });
    if (changes.body !== undefined) doc.setBody(changes.body);
    ChapterFrontmatterSchema.parse(doc.data);
    return gate.stage({
      kind: "chapter-draft",
      summary: `Edit chapter: ${chapter.title}`,
      ...context,
      targets: [{ path, content: doc.serialize() }],
    }, precondition);
  }

  const change = payload.action.change;
  if (!productionShape(production.meta).hasScenes) {
    throw new Error(`${production.meta.title} does not use scenes`);
  }
  if (change.operation === "create") {
    requireSceneLocation(store, change.inherits?.location);
    const episode = change.episodeId === undefined
      ? undefined
      : production.episodes.find((candidate) => candidate.id === change.episodeId);
    const episodeStem = episode ? production.episodeFiles[episode.id] : undefined;
    if (change.episodeId !== undefined && (!episode || !episodeStem)) {
      throw new Error(`episode ${change.episodeId} is not in ${production.meta.id}`);
    }
    const claimedStems = proposedTargetStems(
      store,
      new RegExp(`^productions/${production.meta.id}/scenes/([^/]+)\\.json$`),
    );
    const base = slugify(change.title).slice(0, 40) || "scene";
    const ids = new Set(production.scenes.map((scene) => scene.id));
    const stems = new Set([...Object.values(production.sceneFiles), ...claimedStems]);
    let id = `sc_${base}`;
    let stem = base;
    for (let n = 2; ids.has(id) || stems.has(stem); n++) {
      id = `sc_${base}-${n}`;
      stem = `${base}-${n}`;
    }
    const number = production.scenes.reduce((highest, scene) => Math.max(highest, scene.number), 0) + claimedStems.length + 1;
    const record = SceneRecordSchema.parse({
      ...migrateLegacyScene({
        id,
        number,
        order: number,
        slug: stem,
        title: change.title,
        status: change.status,
        version: 1,
        shots: [],
      }),
      ...(change.synopsis !== undefined ? { synopsis: change.synopsis } : {}),
      ...(change.inherits !== undefined ? { inherits: change.inherits } : {}),
      ...(change.defaults !== undefined ? { defaults: change.defaults } : {}),
      ...(change.scriptBlocks !== undefined ? { script: { blocks: change.scriptBlocks } } : {}),
    });
    const targets = [{
      path: `productions/${production.meta.id}/scenes/${stem}.json`,
      content: `${JSON.stringify(record, null, 2)}\n`,
    }];
    if (episode && episodeStem) {
      targets.push({
        path: `productions/${production.meta.id}/episodes/${episodeStem}.json`,
        content: `${JSON.stringify(EpisodeSchema.parse({
          ...episode,
          scenes: [...episode.scenes.filter((sceneId) => sceneId !== id), id],
        }), null, 2)}\n`,
      });
    }
    return gate.stage({
      kind: "scene-edit",
      summary: `New scene: ${change.title}`,
      ...context,
      targets,
    }, precondition);
  }
  const current = production.scenes.find((scene) => scene.id === change.sceneId);
  const stem = production.sceneFiles[change.sceneId];
  if (!current || !stem) throw new Error(`scene ${change.sceneId} is not in ${production.meta.id}`);
  const graph = isGraphScene(current) ? current : migrateLegacyScene(current);
  if (change.operation === "edit") requireSceneLocation(store, change.changes.inherits?.location);
  if (change.operation === "replace-script") {
    const oldBlocks = graph.script?.blocks ?? [];
    const oldIds = new Set(oldBlocks.map((block) => block.id));
    const nextIds = new Set(change.blocks.map((block) => block.id));
    for (const block of change.blocks) {
      if (oldIds.has(block.id)) continue;
      const reminted = oldBlocks.find((existing) =>
        existing.kind === block.kind && existing.speaker === block.speaker && existing.text === block.text);
      if (reminted) {
        throw new Error(`unchanged script block ${reminted.id} must keep its stable id`);
      }
    }
    for (const [index, oldBlock] of oldBlocks.entries()) {
      const nextBlock = change.blocks[index];
      if (
        nextBlock &&
        !nextIds.has(oldBlock.id) &&
        !oldIds.has(nextBlock.id) &&
        nextBlock.kind === oldBlock.kind &&
        nextBlock.speaker === oldBlock.speaker
      ) throw new Error(`edited script block ${oldBlock.id} must keep its stable id`);
    }
  }
  const record = change.operation === "replace-script"
    ? SceneRecordSchema.parse({ ...graph, script: { blocks: change.blocks } })
    : SceneRecordSchema.parse(withoutCleared(graph, change.changes));
  return gate.stage({
    kind: "scene-edit",
    summary: change.operation === "replace-script" ? `Scene script: ${current.title}` : `Edit scene: ${current.title}`,
    ...context,
    targets: [{
      path: `productions/${production.meta.id}/scenes/${stem}.json`,
      content: `${JSON.stringify(record, null, 2)}\n`,
    }],
  }, precondition);
}
