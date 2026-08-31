import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  compilePasses,
  normalizeAspect,
  legacyFormatFor,
  migrateLegacyScene,
  planScene,
  pickableSheets,
  productionShape,
  sceneDeleteBlockers,
  resolveMedium,
  ulid,
  type ArtifactSidecar,
  type ManifestModel,
  type ProductionBundle,
  type ProductionFormat,
  type ProductionMedium,
  type ProposalSkill,
  EpisodeSchema,
  SeasonSchema,
  StoryOverviewSchema,
  type Episode,
  type Scene,
  type ScenePlan,
  type Season,
  type Series,
  type StoryOverview,
  type SceneRecord,
  type WorldBundle,
  type Capability,
  orderedShots,
} from "@arke-studio/contracts";
import { decodePng, drawScaled, encodePng, solidImage, type RgbaImage } from "../references/png.js";
import { posterNameFor } from "../takes/poster.js";
import { atomicWriteFile } from "../world/atomic.js";
import { readChanges } from "../world/change-writer.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { slugify, uniqueSlug } from "../world/slug.js";
import { JsonFile, MarkdownFile, sha256 } from "../world/text-files.js";
import { CommitStaleError, type CommitFileInput } from "../world/commit.js";
import { readSceneRecord } from "./scene-record.js";
import type { WorldStore } from "../world/store.js";
import type { EnqueueInput } from "../queue/dispatcher.js";

/**
 * Production operations (SPEC-012): a production is a lens, not a container (D1) — nothing
 * here copies a world entity; scenes and chapters cite by id and read through at dispatch.
 */

// ---------------------------------------------------------------------------
// Creation (R-1, R-2)
// ---------------------------------------------------------------------------

export interface CreateProductionInput {
  title: string;
  /** Legacy discriminator; consulted only when `medium` is absent (SPEC-023 R-1). */
  format?: ProductionFormat;
  medium?: ProductionMedium;
  /** The named format beneath the medium (SPEC-023 R-2), e.g. "microdrama". */
  productionKind?: string;
  /** The Series the first episodic season creates or joins (SPEC-023 R-9). */
  seriesTitle?: string;
  /** Delivery-profile values — concrete fields, never a discriminator (SPEC-023 R-3). */
  aspect?: string;
  defaults?: Season["defaults"];
  logline?: string;
  /** Stamped on the commit's change lines so a redelivered request finds its commit (#384). */
  requestId?: string;
}

export async function createProduction(store: WorldStore, input: CreateProductionInput): Promise<string> {
  // Concurrent creates race between reading the bundle and committing: two requests can pick
  // the same slug, and the loser's `create` refuses as stale. The commit itself is the arbiter
  // (never merged, R-27) — the loser recomputes against the fresh bundle and takes the next
  // slug, so distinct requests always get distinct productions (#384).
  for (let attempt = 0; ; attempt++) {
    try {
      return await createProductionOnce(store, input);
    } catch (err) {
      if (err instanceof CommitStaleError && attempt < 3) continue;
      throw err;
    }
  }
}

async function createProductionOnce(store: WorldStore, input: CreateProductionInput): Promise<string> {
  const bundle = store.getBundle();
  const taken = bundle.productions.map((p) => p.meta.id);
  const slug = uniqueSlug(input.title, "production", taken);
  // Normalized at the single write boundary (issue 389): " 9 : 16 " and "9:16" must be one
  // shape, and a string no route can parse is refused here rather than stored to fail later.
  const aspect = input.aspect !== undefined ? normalizeAspect(input.aspect) : undefined;
  if (input.aspect !== undefined && aspect === null) {
    throw new Error(`"${input.aspect}" is not an aspect — two numbers around a colon, like 9:16`);
  }
  // Always through the resolve (review 2026-08-22): a caller still sending the retired
  // `interactive-video` medium otherwise wrote it verbatim into a brand-new world.
  const medium: ProductionMedium = resolveMedium({
    format: input.format ?? "video",
    ...(input.medium !== undefined ? { medium: input.medium } : {}),
  });
  const legacyFormat: ProductionFormat = input.medium === undefined ? (input.format ?? "video") : legacyFormatFor(medium);
  // Write the new-model fields only where they say something the legacy field cannot
  // (SPEC-023 R-1): a plain creation keeps the world openable by builds that predate them.
  const plainShape = productionShape({ format: legacyFormat });
  /*
   * The retired medium was the interactivity (turn 100): resolving it to plain video and
   * writing nothing else silently made the production a film — the branching a caller asked
   * for dropped on the floor. What that input means now is the video medium carrying the
   * interactive kind, so that is what lands on disk.
   */
  const kind = input.productionKind ?? (input.medium === "interactive-video" ? "interactive" : undefined);
  const carriesNewModel =
    medium !== plainShape.medium || (kind !== undefined && kind !== plainShape.kind);
  const shape = productionShape({ format: legacyFormat, ...(carriesNewModel ? { medium, kind } : {}) });
  const meta = {
    id: slug,
    format: legacyFormat,
    ...(carriesNewModel ? { medium } : {}),
    ...(carriesNewModel && kind !== undefined ? { kind } : {}),
    title: input.title,
    ...(input.logline !== undefined ? { logline: input.logline } : {}),
    status: "in-progress",
    ...(aspect !== undefined && aspect !== null ? { aspect } : {}),
    created: store.now(),
    updated: store.now(),
  };
  const files: CommitFileInput[] = [
    {
      path: `productions/${slug}/production.json`,
      action: "create",
      content: JSON.stringify(meta, null, 2) + "\n",
      baseHash: null,
    },
  ];
  // An episodic creation makes its season — and, the first time, its Series — in the same
  // commit (turn 47: "Create Series and open day one" names both things it makes).
  if (shape.isEpisodic) {
    const season: Season = { version: 1, ...(input.defaults ? { defaults: input.defaults } : {}) };
    files.push({
      path: `productions/${slug}/season.json`,
      action: "create" as const,
      content: JSON.stringify(season, null, 2) + "\n",
      baseHash: null,
    });
    const seriesTitle = input.seriesTitle ?? input.title;
    const existing = bundle.series.find((s) => s.title === seriesTitle || s.id === slugify(seriesTitle));
    if (existing) {
      const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(`series/${existing.id}.json`))), "utf8");
      const doc = JsonFile.parse(raw);
      doc.set({ seasons: [...existing.seasons, slug] });
      files.push({
        path: `series/${existing.id}.json`,
        action: "replace" as const,
        content: doc.serialize(),
        baseHash: sha256(raw),
      });
    } else {
      const seriesId = uniqueSlug(seriesTitle, "series", bundle.series.map((s) => s.id));
      const series: Series = {
        id: seriesId,
        version: 1,
        title: seriesTitle,
        seasons: [slug],
        created: store.now(),
        updated: store.now(),
      };
      files.push({
        path: `series/${seriesId}.json`,
        action: "create" as const,
        content: JSON.stringify(series, null, 2) + "\n",
        baseHash: null,
      });
    }
  }
  await store.commit({
    kind: "production-create",
    source: "form",
    files,
    // Any new-model write crosses the schema boundary (SPEC-023 R-23) so older builds refuse
    // this world by name instead of silently dropping the production from the bundle.
    ...(carriesNewModel || shape.isEpisodic ? { raiseSchemaVersion: 2 } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  });
  return slug;
}

/**
 * The production a request id already created, or null (#384). Reads the whole change log
 * rather than the bundle's windowed tail, so redelivery stays idempotent however much has
 * happened since the first commit landed.
 */
export async function productionCreatedBy(worldDir: string, requestId: string): Promise<string | null> {
  const lines = await readChanges(join(worldDir, "changes.jsonl"));
  for (const line of lines) {
    const c = line as { requestId?: string; entity?: string };
    if (c.requestId !== requestId || typeof c.entity !== "string") continue;
    const m = /^productions\/([a-z0-9-]+)\/production$/.exec(c.entity);
    if (m) return m[1]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The story overview (issue #385): authored through the gate, steering drafting
// ---------------------------------------------------------------------------

/**
 * The accepted overview's contribution to a drafting instruction, or "" when none exists. One
 * helper so scene drafting and chapter drafting steer from the same accepted facts — the UI
 * says the overview steers drafting, and this is where that claim is made true.
 */
export function overviewSteer(story: StoryOverview | null | undefined): string {
  if (!story) return "";
  const lines = [
    ...(story.logline !== undefined ? [`- logline: ${story.logline}`] : []),
    ...(story.spine !== undefined ? [`- spine: ${story.spine}`] : []),
    ...(story.acts ?? []).map(
      (act, i) => `- act ${i + 1} · ${act.title}${act.summary !== undefined ? `: ${act.summary}` : ""}`,
    ),
    ...(story.targetLength !== undefined ? [`- target length: ${story.targetLength}`] : []),
  ];
  if (lines.length === 0) return "";
  return `\n\nThe accepted story overview (v${story.version}) steers this draft — keep it consistent:\n${lines.join("\n")}`;
}

/**
 * Stage the structured overview as a story-overview proposal (issue #385). Nothing is written
 * live: the gate validates the shape before a proposal directory exists, review projects every
 * field, and acceptance versions story.json with its history snapshot like any other accept.
 */
export async function proposeStoryOverview(
  store: WorldStore,
  gate: {
    stage(input: {
      kind: "story-overview";
      summary: string;
      source: string;
      targets: Array<{ path: string; content: string }>;
    }): Promise<{ id: string }>;
  },
  input: {
    productionId: string;
    source: string;
    overview: Omit<StoryOverview, "version">;
  },
): Promise<{ proposalId: string; path: string }> {
  const path = `productions/${input.productionId}/story.json`;
  const live = store.getBundle().productions.find((p) => p.meta.id === input.productionId)?.story ?? null;
  // The committer stamps the accepted version; the staged one carries the live version so the
  // review reads honestly ("against vN") and the plan verifies cleanly.
  const content =
    JSON.stringify(StoryOverviewSchema.parse({ ...input.overview, version: live?.version ?? 1 }), null, 2) + "\n";
  const proposal = await gate.stage({
    kind: "story-overview",
    summary: `Story overview · ${input.productionId}`,
    source: input.source,
    targets: [{ path, content }],
  });
  return { proposalId: proposal.id, path };
}

/**
 * Stage the season record as a season-edit proposal (SPEC-023 R-10, issue #397). The draft is
 * merged onto what is live; the gate validates, reviews field by field, and versions on accept.
 */
export async function proposeSeason(
  store: WorldStore,
  gate: {
    stage(input: {
      kind: "season-edit";
      summary: string;
      source: string;
      targets: Array<{ path: string; content: string }>;
    }): Promise<{ id: string }>;
  },
  input: { productionId: string; source: string; season: Omit<Season, "version"> },
): Promise<{ proposalId: string; path: string }> {
  const path = `productions/${input.productionId}/season.json`;
  const live = store.getBundle().productions.find((p) => p.meta.id === input.productionId)?.season ?? null;
  const content =
    JSON.stringify(SeasonSchema.parse({ ...live, ...input.season, version: live?.version ?? 1 }), null, 2) + "\n";
  const proposal = await gate.stage({
    kind: "season-edit",
    summary: `Season · ${input.productionId}`,
    source: input.source,
    targets: [{ path, content }],
  });
  return { proposalId: proposal.id, path };
}

/**
 * Stage one episode as an episode-edit proposal (SPEC-023 R-12, issue #397): a create mints a
 * stem-stable identity from the title; an amend merges onto the live record at its stored stem.
 */
export async function proposeEpisode(
  store: WorldStore,
  gate: {
    stage(input: {
      kind: "episode-edit";
      summary: string;
      source: string;
      targets: Array<{ path: string; content: string }>;
    }): Promise<{ id: string }>;
  },
  input: {
    productionId: string;
    source: string;
    episodeId?: string;
    episode: Partial<Omit<Episode, "id" | "version">> & { title?: string };
  },
): Promise<{ proposalId: string; path: string }> {
  const production = store.getBundle().productions.find((p) => p.meta.id === input.productionId);
  if (!production) throw new Error(`production ${input.productionId} is not in this world`);
  if (input.episodeId !== undefined) {
    const live = production.episodes.find((e) => e.id === input.episodeId);
    const stem = production.episodeFiles[input.episodeId];
    if (!live || stem === undefined) throw new Error(`episode ${input.episodeId} is not in ${input.productionId}`);
    const path = `productions/${input.productionId}/episodes/${stem}.json`;
    const content = JSON.stringify(EpisodeSchema.parse({ ...live, ...input.episode }), null, 2) + "\n";
    const proposal = await gate.stage({
      kind: "episode-edit",
      summary: `Episode · ${live.title}`,
      source: input.source,
      targets: [{ path, content }],
    });
    return { proposalId: proposal.id, path };
  }
  const title = input.episode.title;
  if (title === undefined) throw new Error("a new episode needs a title");
  const slug = slugify(title).slice(0, 60) || "episode";
  const takenIds = new Set(production.episodes.map((e) => e.id));
  const takenStems = new Set(Object.values(production.episodeFiles));
  let id = `ep_${slug}`;
  let stem = slug;
  for (let n = 2; takenIds.has(id) || takenStems.has(stem); n++) {
    id = `ep_${slug}-${n}`;
    stem = `${slug}-${n}`;
  }
  const path = `productions/${input.productionId}/episodes/${stem}.json`;
  const content =
    JSON.stringify(
      EpisodeSchema.parse({
        id,
        version: 1,
        order: input.episode.order ?? production.episodes.length + 1,
        title,
        ...(input.episode.promise !== undefined ? { promise: input.episode.promise } : {}),
        scenes: input.episode.scenes ?? [],
        ...(input.episode.linked !== undefined ? { linked: input.episode.linked } : {}),
        ...(input.episode.release !== undefined ? { release: input.episode.release } : {}),
      }),
      null,
      2,
    ) + "\n";
  const proposal = await gate.stage({
    kind: "episode-edit",
    summary: `New episode · ${title}`,
    source: input.source,
    targets: [{ path, content }],
  });
  return { proposalId: proposal.id, path };
}

/** Reorder episodes: order fields only — no rename, no version cut (SPEC-023 R-12). */
export async function reorderEpisodes(store: WorldStore, productionId: string, orderedIds: string[]): Promise<void> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) return;
  const files: CommitFileInput[] = [];
  for (const [index, episodeId] of orderedIds.entries()) {
    const stem = production.episodeFiles[episodeId];
    if (stem === undefined) continue;
    const path = `productions/${productionId}/episodes/${stem}.json`;
    const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
    const doc = JsonFile.parse(live);
    if ((doc.value["order"] as number | undefined) === index + 1) continue;
    doc.set({ order: index + 1 });
    files.push({ path, action: "replace", content: doc.serialize(), baseHash: sha256(live), preserveVersion: true });
  }
  if (files.length === 0) return;
  await store.commit({ kind: "episode-reorder", source: "form", files });
}

// ---------------------------------------------------------------------------
// Chapters (R-4, R-5, D3): order in frontmatter, direct saves cut no version
// ---------------------------------------------------------------------------

export async function createChapter(
  store: WorldStore,
  productionId: string,
  input: { title: string; order: number },
): Promise<string> {
  const slug = slugify(input.title) || `chapter-${input.order}`;
  const doc = MarkdownFile.create(
    {
      id: slug,
      title: input.title,
      order: input.order,
      status: "planned",
      version: 1,
      created: store.now().slice(0, 10),
      updated: store.now().slice(0, 10),
    },
    "",
  );
  await store.commit({
    kind: "chapter-create",
    // A chapter born with `order` and no legacy `number` is a version-2 shape (SPEC-023 R-23):
    // an older build's scanner silently drops it rather than refusing the world by name.
    raiseSchemaVersion: 2,
    source: "form",
    files: [
      { path: `productions/${productionId}/chapters/${slug}.md`, action: "create", content: doc.serialize(), baseHash: null },
    ],
  });
  return slug;
}

/** Direct authoring: saves in place, no proposal, no version cut (R-5). */
export async function saveChapter(
  store: WorldStore,
  productionId: string,
  chapterFile: string,
  body: string,
): Promise<void> {
  const path = `productions/${productionId}/chapters/${chapterFile}.md`;
  const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  const doc = MarkdownFile.parse(live);
  doc.setBody(body);
  // The summary's word count follows the prose it summarises: every surface that reads
  // `words` (the chapter tree, the story dashboard) would otherwise report the count the
  // chapter had when it was last stamped by hand, indefinitely.
  doc.setData({ words: body.trim() === "" ? 0 : body.trim().split(/\s+/).length });
  await store.commit({
    kind: "chapter-save",
    source: "editor",
    files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live), preserveVersion: true }],
  });
}

/** Reorder: frontmatter only — no file renamed, no history path moved (R-4, D3). */
export async function reorderChapters(
  store: WorldStore,
  productionId: string,
  orderedFiles: string[],
): Promise<void> {
  const files = [];
  for (const [index, file] of orderedFiles.entries()) {
    const path = `productions/${productionId}/chapters/${file}.md`;
    const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
    const doc = MarkdownFile.parse(live);
    if ((doc.data["order"] as number) === index + 1) continue;
    doc.setData({ order: index + 1 });
    files.push({ path, action: "replace" as const, content: doc.serialize(), baseHash: sha256(live), preserveVersion: true });
  }
  if (files.length === 0) return;
  // Reordering writes explicit `order` fields — a version-2 shape (SPEC-023 R-23).
  await store.commit({ kind: "chapter-reorder", source: "form", files, raiseSchemaVersion: 2 });
}

/**
 * Reorder scenes: order fields only — no file renamed, no version cut, no history path moved
 * (issue #387, the SPEC-012 D3 rule applied to scenes). Ids the production does not know are
 * skipped rather than failing the rest; the spine is untouched because it never reads scene
 * order (anchors order the spine).
 *
 * It is also the one authored write that leaves a legacy scene legacy (SPEC-029). `order` is
 * where a scene sits among its siblings, which R-19 keeps outside the scene graph entirely —
 * nothing about the scene's internal structure is touched here. Migrating anyway would take the
 * trade above apart: one drag rewrites `order` on every scene after the moved one, so the first
 * drag in a world would cut a version and a history snapshot for most of a production at once,
 * which is the eager migration D6 exists to avoid. The scene migrates on the first write that
 * is actually about its shots, and until then a schema-3 world simply holds it as it is (R-14).
 */
export async function reorderScenes(store: WorldStore, productionId: string, orderedIds: string[]): Promise<void> {
  const production = store.getBundle().productions.find((p) => p.meta.id === productionId);
  if (!production) return;
  const files: CommitFileInput[] = [];
  for (const [index, sceneId] of orderedIds.entries()) {
    const stem = production.sceneFiles[sceneId];
    if (stem === undefined) continue;
    const path = `productions/${productionId}/scenes/${stem}.json`;
    const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
    const doc = JsonFile.parse(live);
    if ((doc.value["order"] as number | undefined) === index + 1) continue;
    doc.set({ order: index + 1 });
    files.push({ path, action: "replace", content: doc.serialize(), baseHash: sha256(live), preserveVersion: true });
  }
  if (files.length === 0) return;
  // Reordering writes explicit `order` fields — a version-2 shape (SPEC-023 R-23).
  await store.commit({ kind: "scene-reorder", source: "form", files, raiseSchemaVersion: 2 });
}

// ---------------------------------------------------------------------------
// Scene drafting (R-7, D4): a complete graph proposal the agent fills; accepting
// creates shots and dispatches nothing
// ---------------------------------------------------------------------------

export interface SceneDraft {
  proposalId: string;
  path: string;
  /** The retrieval-scope statement the drafting agent is given. */
  scope: string;
  instruction: string;
  /**
   * The authoring skill this draft is being shaped under, or null when the target family has
   * none (SPEC-019 R-20). Null is an ordinary outcome and the scope line says so, because a
   * fallback nobody is told about is indistinguishable from a fallback that misfired.
   */
  skill: ProposalSkill | null;
}

export async function draftSceneSkeleton(
  store: WorldStore,
  gate: {
    stage(input: {
      kind: "scene-draft";
      summary: string;
      source: string;
      targets: Array<{ path: string; content: string }>;
      skill?: ProposalSkill;
    }): Promise<{ id: string }>;
  },
  input: {
    productionId: string;
    brief: string;
    /**
     * The skill resolved for the production's target model family, from the shipped registry.
     * Passed in rather than looked up here: the registry lives in the adapter package and the
     * dependency runs one way (SPEC-005 D5).
     */
    skill?: { id: string; version: number; family: string; models?: string[] } | null;
  },
): Promise<SceneDraft> {
  const bundle = store.getBundle();
  const production = bundle.productions.find((p) => p.meta.id === input.productionId);
  // Identity is stable at creation and independent of position (issue #387): the id comes from
  // the slug, the file stem IS the slug — no ordering prefix, ever — and both are deduplicated
  // against what exists rather than derived from a count. `number` stays as the scene's stable
  // birth name; explicit `order` places it.
  const takenIds = new Set(production?.scenes.map((s) => s.id) ?? []);
  const onDisk = new Set(Object.values(production?.sceneFiles ?? {}));
  const takenStems = new Set(onDisk);
  // A staged-but-unaccepted draft occupies its stem too: two identical briefs in a row must
  // not race to one file, with the second accept silently colliding into the first.
  const stagedStems = new Set<string>();
  for (const staged of bundle.proposals) {
    for (const target of staged.proposal.targets) {
      const m = new RegExp(`^productions/${input.productionId}/scenes/(.+)\\.json$`).exec(target.path);
      if (m && !onDisk.has(m[1]!)) stagedStems.add(m[1]!);
    }
  }
  for (const stem of stagedStems) takenStems.add(stem);
  /*
   * A staged draft has claimed its number as well as its stem (round 3, 2026-08-22). Counting
   * only what is on disk gave every draft staged before the first accept the same number and
   * the same order — three scenes all calling themselves Scene 1, in an order nothing decided.
   * Driven out by drafting two scenes back to back, which is how anybody would build an episode.
   */
  const highest = production?.scenes.reduce((a, s) => Math.max(a, s.number), 0) ?? 0;
  const number = highest + stagedStems.size + 1;
  const slug = slugify(input.brief.split(/[.!?\n]/)[0] ?? "scene").slice(0, 40) || `scene-${number}`;
  let id = `sc_${slug}`;
  let file = slug;
  for (let n = 2; takenIds.has(id) || takenStems.has(file); n++) {
    id = `sc_${slug}-${n}`;
    file = `${slug}-${n}`;
  }
  const path = `productions/${input.productionId}/scenes/${file}.json`;
  const skill = input.skill ?? null;
  const skeleton = migrateLegacyScene({
    id,
    number,
    order: number,
    slug,
    title: input.brief.split(/[.!?\n]/)[0]?.trim() ?? `Scene ${number}`,
    status: "draft",
    version: 1,
    // Written into the skeleton rather than stamped at accept, so it travels the ordinary
    // proposal path and lands with the scene (R-21). The proposal record (R-19) explains the
    // draft; this is what dispatch compares against months later, when the proposal is gone.
    ...(skill !== null
      ? {
          draftedWith: {
            skillId: skill.id,
            version: skill.version,
            family: skill.family,
            // Carried so dispatch can tell a narrowed document from a family-wide one months
            // later, when the proposal that explains the draft is long gone.
            ...(skill.models !== undefined ? { models: skill.models } : {}),
          },
        }
      : {}),
    shots: [],
  });
  const proposal = await gate.stage({
    kind: "scene-draft",
    summary: `Scene ${number}: ${skeleton.title}`,
    source: "chat:studio",
    targets: [{ path, content: JSON.stringify(skeleton, null, 2) + "\n" }],
    // Recorded on the proposal the skill shaped (R-19), the same discipline as provenance at
    // dispatch — two scenes drafted under different guidance differ for a recoverable reason.
    ...(skill !== null ? { skill } : {}),
  });
  // What this production can actually draw on (SPEC-020 R-7): the world's cast plus its own
  // guests. Counting another production's one-offs would tell the drafting agent a larger cast
  // is available than it may cite without a cross-production warning.
  const characters = pickableSheets(bundle.sheets, input.productionId).filter(
    (s) => s.type === "character" && s.retired !== true,
  ).length;
  // Whichever way it went, the scope line says it (R-20). A fallback nobody is told about looks
  // exactly like a fallback that misfired, and the difference matters when the shots read oddly.
  const guidance =
    skill !== null
      ? ` · drafting guidance: ${skill.id}@v${skill.version} (${skill.family})`
      : " · drafting guidance: general — no skill ships for this model family";
  const scope = `drafts with: ${bundle.meta.name} · canon v${bundle.meta.canonRevision}${
    bundle.meta.tone ? ` · tone: ${bundle.meta.tone}` : ""
  } · ${characters} character${characters === 1 ? "" : "s"} available${guidance}`;
  /*
   * The first free shot id in the whole production (round 3, 2026-08-22). Ids are unique per
   * production, never per scene — takes and selections key by bare shot id — and an agent that
   * numbers from one cannot see the other scenes. Told here so the ordinary path is right; the
   * gate refuses a collision either way, and the repair turn quotes the same rule.
   */
  const shotBase =
    (production?.scenes ?? []).flatMap((s) => orderedShots(s)).reduce((a, shot) => {
      const n = Number(shot.id.replace(/^sh_0*/, ""));
      return Number.isFinite(n) ? Math.max(a, n) : a;
    }, 0) + 1;
  const instruction = `${scope}${overviewSteer(production?.story)}\n\nDraft scene ${number} in ${path} from this brief: "${input.brief}". Populate \`flow\` as one complete Entry -> shot nodes -> Exit path. Keep the staged entry and exit nodes and their ids stable. Each shot node needs \`kind: "shot"\`, an id derived from its shot id (for example \`sh_40\` uses \`sfn_sh-40\`), and a \`shot\` with id, number, title, description with @mentions for every character and the location, camera, audio, durationSec. Replace the direct Entry -> Exit edge with sequence edges through every shot; each edge needs \`kind: "sequence"\`, \`out\` and \`in\` ports, and an id derived from its adjacent endpoints (for example \`sfe_entry-sh-40\`). Keep \`schemaVersion\`, \`entryNodeId\`, \`exitNodeId\`, and \`storyboardGroups\` intact. Shot ids are unique across the WHOLE production, not per scene: number this scene's shots sh_${shotBase}, sh_${shotBase + 1}, and so on upward, while each shot's own \`number\` field starts at 1 for this scene. Write camera as a complete value: name a fixture the location or the brief already supports and what the camera faces, then the shot size and movement — "at the kettle beside the fridge, facing the hallway; medium close-up, slow push-in". Never invent a fixture, and never write a relative correction such as "closer". Write audio as an object, never a sentence: {"kind": "vo" | "dialogue" | "sfx" | "silence"} with optional "speaker" (a sheet slug) and "line"; a texture like a hum is {"kind": "sfx", "line": "light click and focus hum"}. Propose an inherits block (location, timeOfDay, tone) where location is a lowercase-kebab slug such as "rehearsal-hall", never prose. The file must stay a valid scene record — the gate refuses anything else at accept. Check canon for anything the brief touches and keep every line consistent with it. Do not touch any other file.`;
  return { proposalId: proposal.id, path, scope, instruction, skill };
}

// ---------------------------------------------------------------------------
// Scene file operations
// ---------------------------------------------------------------------------

/**
 * A scene file stem, or a refusal (review 2026-08-22). The frame schema already constrains the
 * wire, but these functions are also called in-process, and a path decision this consequential
 * is checked where the path is built rather than trusted to every caller. `.` and `..` are
 * excluded by the pattern; separators of either slant never appear.
 */
function sceneStemOrThrow(sceneFile: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sceneFile) || sceneFile === "." || sceneFile === "..") {
    throw new Error(`"${sceneFile}" is not a scene file name`);
  }
  return sceneFile;
}

/**
 * One scene file, read through the R-1 union (SPEC-029).
 *
 * The projection supplies shared metadata while the shape-preserving caller writes the original
 * bytes, so reading a legacy scene here never migrates it.
 */
async function readScene(
  store: WorldStore,
  productionId: string,
  sceneFile: string,
): Promise<{ scene: Scene; raw: string; path: string }> {
  const path = `productions/${productionId}/scenes/${sceneStemOrThrow(sceneFile)}.json`;
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  return { scene: readSceneRecord(raw).scene, raw, path };
}

/**
 * A deletion that would take something with it, refused in the words of what stands in the way.
 *
 * The same discipline as the interactive export gate: the reasons are the answer, not a code —
 * a person told "cannot delete" learns nothing, and a person told "shot 3 has an accepted take"
 * knows exactly what to do next.
 */
export class SceneDeleteRefused extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join(" · "));
    this.name = "SceneDeleteRefused";
  }
}

/**
 * Delete a scene, and everything that was only bookkeeping about it (one commit).
 *
 * The file goes, the scene leaves every episode that listed it — a membership naming a scene
 * that does not exist is the exact defect round 3 found on the other side of this — and the
 * selections its shots carried go with it. History keeps the file, so the deletion is a version
 * away from being undone like any other write.
 */
export async function deleteScene(
  store: WorldStore,
  input: { productionId: string; sceneFile: string },
): Promise<void> {
  const stem = sceneStemOrThrow(input.sceneFile);
  const production = store.getBundle().productions.find((p) => p.meta.id === input.productionId);
  if (!production) throw new Error(`production ${input.productionId} is not in this world`);
  const path = `productions/${input.productionId}/scenes/${stem}.json`;
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  const { record, scene } = readSceneRecord(raw);

  const blockers = sceneDeleteBlockers(production, scene);
  if (blockers.length > 0) throw new SceneDeleteRefused(blockers);

  const files: CommitFileInput[] = [{ path, action: "delete", baseHash: sha256(raw) }];

  for (const episode of production.episodes) {
    if (!episode.scenes.includes(scene.id)) continue;
    const episodeStem = production.episodeFiles[episode.id];
    if (episodeStem === undefined) continue;
    const episodePath = `productions/${input.productionId}/episodes/${episodeStem}.json`;
    const live = await readFile(toExtendedLength(join(store.dir, fromPortable(episodePath))), "utf8");
    const doc = JsonFile.parse(live);
    doc.set({ scenes: episode.scenes.filter((id) => id !== scene.id) });
    files.push({ path: episodePath, action: "replace", content: doc.serialize(), baseHash: sha256(live) });
  }

  const shotIds = new Set(orderedShots(record).map((shot) => shot.id));
  const remaining = Object.fromEntries(
    Object.entries(production.selections).filter(([shotId]) => !shotIds.has(shotId)),
  );
  if (Object.keys(remaining).length !== Object.keys(production.selections).length) {
    const selectionsPath = `productions/${input.productionId}/selections.json`;
    const live = await readFile(toExtendedLength(join(store.dir, fromPortable(selectionsPath))), "utf8");
    files.push({
      path: selectionsPath,
      action: "replace",
      content: JSON.stringify(remaining, null, 2) + "\n",
      baseHash: sha256(live),
    });
  }

  await store.commit({ kind: "scene-delete", source: "editor", files });
}

/** Undo (turn 97): v<n> back as a new version; everything between it and now stays in history. */
export async function restoreScene(
  store: WorldStore,
  input: { productionId: string; sceneFile: string; version: number },
): Promise<void> {
  await store.restoreVersion(
    `productions/${input.productionId}/scenes/${sceneStemOrThrow(input.sceneFile)}.json`,
    input.version,
    "editor",
  );
}

// ---------------------------------------------------------------------------
// Boards (R-11..R-13, D8): local, deterministic; export files exactly one artifact
// ---------------------------------------------------------------------------

const BOARD_COLS = 4;
const BOARD_CELL = 320;
const BOARD_GAP = 12;

/** Compile the board image from selected/pinned frames — local, free, repeatable (R-11). */
export async function compileBoard(
  store: WorldStore,
  production: ProductionBundle,
  scene: SceneRecord,
  artifacts: readonly ArtifactSidecar[] = [],
): Promise<Uint8Array> {
  const shots = orderedShots(scene);
  const rows = Math.max(1, Math.ceil(shots.length / BOARD_COLS));
  const width = BOARD_COLS * BOARD_CELL + (BOARD_COLS + 1) * BOARD_GAP;
  const height = rows * BOARD_CELL + (rows + 1) * BOARD_GAP;
  const canvas: RgbaImage = solidImage(width, height, [24, 24, 26, 255]);
  for (const [i, shot] of shots.entries()) {
    const selection = production.selections[shot.id];
    const col = i % BOARD_COLS;
    const row = Math.floor(i / BOARD_COLS);
    const x = BOARD_GAP + col * (BOARD_CELL + BOARD_GAP);
    const y = BOARD_GAP + row * (BOARD_CELL + BOARD_GAP);
    // The durable boundary still first (issue 154): it IS a picture, cut for exactly this.
    const boundary = artifacts.find((candidate) => candidate.id === (selection?.startFrameArtifactId ?? null));
    // A take's cell never decodes its media blind: video media is decoded through the poster
    // convention (`frame.png` beside the clip) — handing an .mp4's bytes to the PNG decoder was
    // how every continuity-chained shot silently became a gap (issue 154).
    const takeId = selection?.startFrameTakeId ?? selection?.acceptedTakeId ?? null;
    const take = takeId !== null ? production.takes.find((t) => t.id === takeId) : undefined;
    const cell =
      boundary !== undefined
        ? join(store.dir, "artifacts", boundary.file)
        : take?.media !== undefined && takeId !== null
          ? join(store.dir, "productions", production.meta.id, "takes", takeId, posterNameFor(take.media))
          : null;
    if (cell === null) continue; // an empty slot stays a gap — same discipline as the grid
    try {
      const bytes = await readFile(toExtendedLength(cell));
      drawScaled(canvas, decodePng(Uint8Array.from(bytes)), x, y, BOARD_CELL, BOARD_CELL);
    } catch {
      /* an unreadable frame stays a gap rather than failing the board */
    }
  }
  return encodePng(canvas);
}

/**
 * Record the compiled board on the scene (R-12): lives in scene storage, not artifacts (D8).
 *
 * Shape-preserving, deliberately: a compiled board is production output, not authored change —
 * it rides `preserveVersion` for that reason — and SPEC-029 R-10 names board compilation among
 * the things that must not migrate a scene or raise the world. `JsonFile.set` therefore writes
 * `board` onto whichever shape the file already has and leaves the rest of it alone.
 */
export async function landBoard(
  store: WorldStore,
  productionId: string,
  sceneFile: string,
  png: Uint8Array,
  clock: () => string,
): Promise<void> {
  await store.gateOp(async () => {
    const { scene, raw, path } = await readScene(store, productionId, sceneFile);
    const image = `boards/scene-${scene.number}.png`;
    await atomicWriteFile(join(store.dir, "productions", productionId, fromPortable(image)), png);
    const doc = JsonFile.parse(raw);
    doc.set({ board: { version: scene.version, compiledAt: clock(), image } });
    await store.commitUnserialised({
      kind: "board-compile",
      source: "form",
      files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(raw), preserveVersion: true }],
    });
  });
}

/** Export files exactly one artifact per invocation (R-13): a kept snapshot, immutable. */
export async function exportBoard(
  store: WorldStore,
  productionId: string,
  scene: SceneRecord,
  png: Uint8Array,
  clock: () => string,
): Promise<string> {
  const stamp = clock().replace(/[-:TZ.]/g, "").slice(0, 14);
  const file = `board-${productionId}-scene-${scene.number}-v${scene.version}-${stamp}.png`;
  const sidecar: ArtifactSidecar = {
    id: `ar_${ulid()}`,
    kind: "board",
    file,
    hash: `sha256:${createHash("sha256").update(png).digest("hex").slice(0, 16)}`,
    origin: { by: "system", producedBy: `board-export:${productionId}/scene-${scene.number}@v${scene.version}` },
    links: [productionId, scene.id],
    created: clock(),
  };
  await store.gateOp(async () => {
    await atomicWriteFile(join(store.dir, "artifacts", file), png);
    await store.commitUnserialised({
      kind: "board-export",
      source: "form",
      files: [
        {
          path: `artifacts/${file}.json`,
          action: "create",
          content: JSON.stringify(sidecar, null, 2) + "\n",
          baseHash: null,
        },
      ],
    });
  });
  return file;
}

/**
 * Raw byte sizes for every reference a plan could carry (SPEC-019 R-43, T-24).
 *
 * Planning is pure and cannot stat a file, so the sizes are measured here and handed in. A file
 * that cannot be read counts as zero rather than failing the whole dialog: an unreadable
 * reference is a different problem, and it surfaces where references are resolved.
 */
export async function referenceByteSizes(store: WorldStore, files: readonly string[]): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const file of new Set(files)) {
    try {
      sizes[file] = (await stat(toExtendedLength(join(store.dir, fromPortable(file))))).size;
    } catch {
      sizes[file] = 0;
    }
  }
  return sizes;
}

export { productionAspect, DEFAULT_PRODUCTION_ASPECT } from "@arke-studio/contracts";

/**
 * Change the aspect a production delivers in (issue 389) — the one editable delivery-profile
 * field, through the same commit machinery everything else uses. Production meta is unversioned
 * (§2.4.1): the change history is the commit's change line, and `updated` moves so the record
 * says when. Validation is the same normalize-or-refuse the create path applies; there is no
 * silent fallback, because a stored shape no route can parse fails at the worst possible time.
 */
export async function setProductionAspect(
  store: WorldStore,
  productionId: string,
  aspect: string,
): Promise<string> {
  const canonical = normalizeAspect(aspect);
  if (canonical === null) {
    throw new Error(`"${aspect}" is not an aspect — two numbers around a colon, like 9:16`);
  }
  const path = `productions/${productionId}/production.json`;
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  const doc = JsonFile.parse(raw);
  doc.set({ aspect: canonical, updated: store.now() });
  await store.commit({
    kind: "production-edit",
    source: "form",
    files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(raw) }],
  });
  return canonical;
}

/**
 * Which model this production reaches for, for one capability (SPEC-033 R-74..R-76).
 *
 * The same commit machinery every other production field uses: no new authority, no second
 * gate, no bypass. This is the one write in SPEC-033 that reaches a world, and it takes the
 * ordinary path deliberately — the alternative was app settings keyed by production id, and
 * production ids are world-scoped, so two copies of a world would collide and a world moved to
 * another machine would lose the choice.
 *
 * `null` clears the choice rather than storing an absence: a production with no choice opens
 * the picker on whatever it would have opened on anyway, which is not the same as one pinned to
 * that model.
 */
export async function setProductionModel(
  store: WorldStore,
  productionId: string,
  capability: Capability,
  modelId: string | null,
): Promise<void> {
  const path = `productions/${productionId}/production.json`;
  const raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  const doc = JsonFile.parse(raw);
  // `doc.value` is the parsed object, and `JsonFile` preserves keys it does not know about.
  // Re-validating the whole strict schema to read one field would make this the only production
  // write that refuses because some unrelated part of the file failed to parse.
  const current = (doc.value["models"] ?? {}) as Record<string, string>;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(current)) if (key !== capability) next[key] = value;
  if (modelId !== null) next[capability] = modelId;
  // Clearing the last entry removes the key rather than leaving `{}` behind — `JSON.stringify`
  // omits an `undefined` value, and an empty object on disk reads as a choice that was made and
  // then emptied, which is a different thing from never having made one.
  doc.set({ models: Object.keys(next).length > 0 ? next : undefined, updated: store.now() });
  await store.commit({
    kind: "production-edit",
    source: "form",
    files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(raw) }],
    // No schema raise, and deliberately. `aspect` (issue 389) is the precedent this follows
    // exactly: an optional production field written only when somebody asks for it, on a
    // production they were looking at. Raising the boundary would make every world this build
    // touches unreadable by the previous release, which is a far larger promise than one
    // optional key is worth — and it is the reason the eager migration went, because *that*
    // would have written the field into every production of every world on open.
  });
}

// ---------------------------------------------------------------------------
// Dispatch composition (T-18): the plan becomes SPEC-009 requests, verbatim
// ---------------------------------------------------------------------------

/**
 * The plan's compiled passes, as queue requests (issue 398). Composition is a field mapping and
 * nothing else: the compiler owns the route, the prompt, the wire parameters, the estimate and
 * the refusals, so the object the dialog reviewed, the durable plan (#391) will persist, and the
 * job the queue runs are one object rather than three derivations that can drift.
 */
export function composeDispatches(
  worldId: string,
  productionId: string,
  scene: SceneRecord,
  plan: ScenePlan,
  model: ManifestModel,
  world: WorldBundle,
): EnqueueInput[] {
  return compilePasses({ productionId, scene, plan, model, world }).map((pass) => ({
    worldId,
    productionId,
    target: pass.target,
    capability: pass.model.capability,
    provider: pass.model.provider,
    model: pass.model.id,
    params: pass.params,
    estimatedMicroUsd: pass.estimatedMicroUsd,
    landing: pass.landing,
  }));
}

export { planScene };
