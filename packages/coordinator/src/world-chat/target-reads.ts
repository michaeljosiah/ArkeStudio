import { createHmac, timingSafeEqual } from "node:crypto";
import {
  orderedShots,
  canonicalSceneFlow,
  isGraphScene,
  sortScenes,
  type ArkeReadRequirement,
  type ArkeReadTarget,
  type ArkeTargetReadPage,
  type ArkeTargetReadTool,
  type DispatchPlan,
  type Job,
  type ProductionBundle,
  type WorldBundle,
} from "@arke-studio/contracts";
import { conversationActionDigest } from "../arke-actions/digest.js";
import type { QueryLease } from "./lease.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const TEXT_CHUNK_CHARS = 4_000;

interface Row {
  readonly key: string;
  readonly value: unknown;
}

interface CursorPayload {
  readonly version: 1;
  readonly runId: string;
  readonly requirement: ArkeReadRequirement;
  readonly targetId: string;
  readonly fence: string;
  readonly after: string;
}

export interface ArkeExportReadRecord {
  readonly id: string;
  readonly worldId: string;
  readonly productionId?: string;
  readonly episodeId?: string;
  readonly status: "running" | "done" | "cancelled" | "failed";
  readonly percent?: number;
  readonly output?: string | null;
  readonly error?: string | null;
}

export interface TargetReadDeps {
  readonly getPlans?: (productionId: string) => Promise<readonly DispatchPlan[]>;
  readonly getJobs?: () => readonly Job[];
  readonly getExports?: () => readonly ArkeExportReadRecord[] | Promise<readonly ArkeExportReadRecord[]>;
  readonly getChapterBody?: (productionId: string, chapterFile: string) => Promise<string | null>;
}

export interface TargetReadOutcome {
  readonly result: ArkeTargetReadPage;
  readonly status: "complete" | "empty";
}

export class TargetReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetReadError";
  }
}

const padded = (value: number): string => String(value).padStart(10, "0");

function target(requirement: ArkeReadRequirement, id: string): ArkeReadTarget {
  return { requirement, id };
}

export const sceneTargetId = (productionId: string, sceneId: string): string =>
  `${productionId}:${sceneId}`;

export const sceneScriptTargetId = (productionId: string, sceneId: string): string =>
  `${sceneTargetId(productionId, sceneId)}:script`;

function fence(value: unknown, version?: string | number): string {
  const digest = conversationActionDigest(value);
  return version === undefined ? digest : `${typeof version === "number" ? `v${version}` : version}:${digest}`;
}

/** Shared with whole-target guards, so "current" means exactly what retrieval signed. */
export function sceneScriptFence(production: ProductionBundle | undefined, sceneId: string): string {
  const scene = production?.scenes.find((entry) => entry.id === sceneId);
  return fence(scene?.script?.blocks ?? [], scene ? scene.version : "absent");
}

export function artDirectionFence(bundle: WorldBundle): string {
  return fence(bundle.artDirection, bundle.artDirection.version);
}

export function bibleFence(bundle: WorldBundle): string {
  return fence(bundle.bible, bundle.bible.version);
}

export function storyFence(production: ProductionBundle | undefined): string {
  return fence(
    { story: production?.story ?? null, treatment: production?.treatment ?? null },
    production?.story?.version ?? "absent",
  );
}

export function seasonFence(production: ProductionBundle | undefined): string {
  return fence(production?.season ?? null, production?.season?.version ?? "absent");
}

export function episodesFence(production: ProductionBundle | undefined): string {
  return fence(production?.episodes ?? []);
}

export function timelineFence(production: ProductionBundle | undefined): string {
  const state = production?.timeline ?? { status: "absent" as const };
  const version = state.status === "ready" ? state.timeline.revision : state.status;
  return fence({ state, takes: production?.takes ?? [], media: production?.takeMediaInfo ?? {} }, version);
}

function boundedLimit(raw: unknown): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_LIMIT;
  return Math.min(Math.max(1, value), MAX_LIMIT);
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") throw new TargetReadError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new TargetReadError(`${name} must be a non-empty string`);
  return value;
}

function assertArgs(args: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set([...allowed, "cursor", "limit"]);
  const unexpected = Object.keys(args).find((key) => !allowedSet.has(key));
  if (unexpected) throw new TargetReadError(`unexpected argument: ${unexpected}`);
  if (args["cursor"] !== undefined && typeof args["cursor"] !== "string") {
    throw new TargetReadError("cursor must be a string");
  }
  if (
    args["limit"] !== undefined &&
    (typeof args["limit"] !== "number" || !Number.isFinite(args["limit"]) || !Number.isInteger(args["limit"]))
  ) throw new TargetReadError("limit must be a finite integer");
}

function chunks(text: string): Row[] {
  const rows: Row[] = [];
  for (let offset = 0; offset < text.length; offset += TEXT_CHUNK_CHARS) {
    rows.push({ key: `text:${padded(offset)}`, value: { offset, text: text.slice(offset, offset + TEXT_CHUNK_CHARS) } });
  }
  return rows;
}

function productionOf(bundle: WorldBundle, productionId: string): ProductionBundle | undefined {
  return bundle.productions.find((production) => production.meta.id === productionId);
}

function sceneOf(production: ProductionBundle | undefined, sceneId: string) {
  return production?.scenes.find((scene) => scene.id === sceneId);
}

function safeJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    worldId: job.worldId,
    ...(job.productionId !== undefined ? { productionId: job.productionId } : {}),
    target: job.target,
    capability: job.capability,
    provider: job.provider,
    model: job.model,
    estimatedMicroUsd: job.estimatedMicroUsd,
    status: job.status,
    step: job.step ?? null,
    attempt: job.attempt,
    finalization: job.finalization,
    error: job.error === null || job.error === undefined ? job.error : "job failed",
    failureClass: job.failureClass,
    providerCostMicroUsd: job.providerCostMicroUsd,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function safeExportOutput(output: string | null | undefined): string | null | undefined {
  if (output === null || output === undefined) return output;
  const normalized = output.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[0] === "exports" && parts.length > 1 && parts.every((part) => part !== "" && part !== "." && part !== "..")
    ? normalized
    : null;
}

export class WorldChatTargetReads {
  constructor(private readonly deps: TargetReadDeps = {}) {}

  async call(
    lease: QueryLease,
    bundle: WorldBundle,
    tool: ArkeTargetReadTool,
    args: Record<string, unknown>,
  ): Promise<TargetReadOutcome> {
    let readTarget: ArkeReadTarget;
    let revisionOrDigest: string;
    let rows: Row[];

    switch (tool) {
      case "get_world_metadata":
        assertArgs(args, []);
        readTarget = target("world-metadata", bundle.meta.worldId);
        rows = [{ key: "metadata", value: bundle.meta }];
        revisionOrDigest = fence(bundle.meta, bundle.meta.updated);
        break;
      case "list_world_index": {
        assertArgs(args, []);
        readTarget = target("world-metadata", bundle.meta.worldId);
        rows = [
          ...bundle.canon.map((entry) => ({ key: `canon:${entry.id}`, value: { kind: "canon", id: entry.id, title: entry.title } })),
          ...bundle.sheets.map((sheet) => ({ key: `sheet:${sheet.id}`, value: { kind: "sheet", id: sheet.id, type: sheet.type, name: sheet.name } })),
          ...bundle.productions.map((production) => ({ key: `production:${production.meta.id}`, value: { kind: "production", id: production.meta.id, title: production.meta.title } })),
          ...bundle.series.map((series) => ({ key: `series:${series.id}`, value: { kind: "series", id: series.id, title: series.title } })),
        ];
        revisionOrDigest = fence(rows.map((row) => row.value));
        break;
      }
      case "list_canon":
        assertArgs(args, []);
        readTarget = target("canon", bundle.meta.worldId);
        rows = [...bundle.canon].sort((a, b) => a.id.localeCompare(b.id)).map((entry) => ({ key: entry.id, value: entry }));
        revisionOrDigest = fence(bundle.canon, bundle.meta.canonRevision);
        break;
      case "list_sheets":
        assertArgs(args, []);
        readTarget = target("sheets", bundle.meta.worldId);
        rows = [...bundle.sheets].sort((a, b) => a.id.localeCompare(b.id)).map((sheet) => ({ key: sheet.id, value: sheet }));
        revisionOrDigest = fence(bundle.sheets);
        break;
      case "get_bible":
        assertArgs(args, []);
        readTarget = target("bible", "bible");
        rows = [{ key: "metadata", value: { present: bundle.bible.present, version: bundle.bible.version } }, ...chunks(bundle.bible.text)];
        revisionOrDigest = bibleFence(bundle);
        break;
      case "get_art_direction":
        assertArgs(args, []);
        readTarget = target("art-direction", "art-direction");
        rows = [{ key: "art-direction", value: bundle.artDirection }];
        revisionOrDigest = artDirectionFence(bundle);
        break;
      case "list_references":
        assertArgs(args, []);
        readTarget = target("references", bundle.meta.worldId);
        rows = [...bundle.referenceKits].sort((a, b) => a.sheetId.localeCompare(b.sheetId)).map((kit) => ({ key: kit.sheetId, value: kit }));
        revisionOrDigest = fence(bundle.referenceKits);
        break;
      case "list_artifacts":
        assertArgs(args, []);
        readTarget = target("artifacts", bundle.meta.worldId);
        rows = [...bundle.artifacts].sort((a, b) => a.id.localeCompare(b.id)).map((artifact) => ({ key: artifact.id, value: artifact }));
        revisionOrDigest = fence(bundle.artifacts);
        break;
      case "list_voices": {
        assertArgs(args, []);
        readTarget = target("voices", bundle.meta.worldId);
        rows = [
          ...bundle.clonedVoices.map((voice) => ({ key: `cloned:${voice.id}`, value: { kind: "cloned", voice } })),
          ...bundle.sheets.filter((sheet) => sheet.voice !== undefined).map((sheet) => ({ key: `sheet:${sheet.id}`, value: { kind: "assignment", sheetId: sheet.id, version: sheet.version, voice: sheet.voice } })),
        ].sort((a, b) => a.key.localeCompare(b.key));
        revisionOrDigest = fence(rows.map((row) => row.value));
        break;
      }
      case "list_productions":
        assertArgs(args, []);
        readTarget = target("production-metadata", bundle.meta.worldId);
        rows = [...bundle.productions].sort((a, b) => a.meta.id.localeCompare(b.meta.id)).map((production) => ({ key: production.meta.id, value: production.meta }));
        revisionOrDigest = fence(rows.map((row) => row.value));
        break;
      case "list_series":
        assertArgs(args, []);
        readTarget = target("series", bundle.meta.worldId);
        rows = [...bundle.series].sort((a, b) => a.id.localeCompare(b.id)).map((series) => ({ key: series.id, value: series }));
        revisionOrDigest = fence(bundle.series);
        break;
      case "get_production_metadata": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const production = productionOf(bundle, productionId);
        readTarget = target("production-metadata", productionId);
        rows = production ? [{ key: "metadata", value: production.meta }] : [];
        revisionOrDigest = fence(production?.meta ?? null, production?.meta.updated ?? "absent");
        break;
      }
      case "get_story": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const production = productionOf(bundle, productionId);
        readTarget = target("story", productionId);
        rows = [
          ...(production?.story ? [{ key: "overview", value: production.story }] : []),
          ...chunks(production?.treatment ?? ""),
        ];
        revisionOrDigest = storyFence(production);
        break;
      }
      case "get_season": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const season = productionOf(bundle, productionId)?.season;
        readTarget = target("seasons", productionId);
        rows = season
          ? [
              { key: "metadata", value: { ...season, arcs: undefined } },
              ...(season.arcs ?? []).map((arc, index) => ({ key: `arc:${padded(index)}:${arc.id}`, value: arc })),
            ]
          : [];
        revisionOrDigest = seasonFence(productionOf(bundle, productionId));
        break;
      }
      case "list_episodes": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const episodes = productionOf(bundle, productionId)?.episodes ?? [];
        readTarget = target("episodes", productionId);
        rows = [...episodes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((episode) => ({ key: `${padded(episode.order)}:${episode.id}`, value: episode }));
        revisionOrDigest = episodesFence(productionOf(bundle, productionId));
        break;
      }
      case "list_chapters": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const chapters = productionOf(bundle, productionId)?.chapters ?? [];
        readTarget = target("chapters", productionId);
        rows = [...chapters].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map((chapter) => ({ key: `${padded(chapter.order)}:${chapter.id}`, value: chapter }));
        revisionOrDigest = fence(chapters);
        break;
      }
      case "get_chapter": {
        assertArgs(args, ["productionId", "chapterId"]);
        const productionId = requireString(args, "productionId");
        const chapterId = requireString(args, "chapterId");
        const chapter = productionOf(bundle, productionId)?.chapters.find((entry) => entry.id === chapterId || entry.file === chapterId);
        const body = chapter && this.deps.getChapterBody ? await this.deps.getChapterBody(productionId, chapter.file) : null;
        readTarget = target("chapters", `${productionId}:${chapterId}`);
        rows = chapter ? [{ key: "metadata", value: chapter }, ...chunks(body ?? "")] : [];
        revisionOrDigest = fence({ chapter: chapter ?? null, body }, chapter?.version ?? "absent");
        break;
      }
      case "list_scenes": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const scenes = sortScenes(productionOf(bundle, productionId)?.scenes ?? []);
        readTarget = target("scenes", productionId);
        rows = scenes.map((scene, index) => ({
          key: `${padded(index)}:${scene.id}`,
          value: {
            id: scene.id,
            number: scene.number,
            order: scene.order,
            slug: scene.slug,
            title: scene.title,
            synopsis: scene.synopsis,
            status: scene.status,
            version: scene.version,
            scriptBlocks: scene.script?.blocks.length ?? 0,
            shots: orderedShots(scene).length,
            structure: "flow" in scene ? "graph" : "linear",
          },
        }));
        revisionOrDigest = fence(scenes);
        break;
      }
      case "get_scene": {
        assertArgs(args, ["productionId", "sceneId"]);
        const productionId = requireString(args, "productionId");
        const sceneId = requireString(args, "sceneId");
        const scene = sceneOf(productionOf(bundle, productionId), sceneId);
        readTarget = target("scenes", sceneTargetId(productionId, sceneId));
        rows = scene
          ? [
               { key: "metadata", value: Object.fromEntries(Object.entries(scene).filter(([key]) => !["script", "shots", "flow"].includes(key))) },
               ...(isGraphScene(scene)
                 ? [{ key: "structure", value: { kind: "scene-flow", flow: canonicalSceneFlow(scene.flow) } }]
                 : []),
               ...(scene.script?.blocks ?? []).map((block, index) => ({ key: `script:${padded(index)}:${block.id}`, value: { kind: "script-block", block } })),
              ...orderedShots(scene).map((shot, index) => ({ key: `shot:${padded(index)}:${shot.id}`, value: { kind: "shot", shot } })),
            ]
          : [];
        revisionOrDigest = fence(scene ?? null, scene?.version ?? "absent");
        break;
      }
      case "get_scene_script": {
        assertArgs(args, ["productionId", "sceneId"]);
        const productionId = requireString(args, "productionId");
        const sceneId = requireString(args, "sceneId");
        const production = productionOf(bundle, productionId);
        const scene = sceneOf(production, sceneId);
        readTarget = target("scenes", sceneScriptTargetId(productionId, sceneId));
        rows = (scene?.script?.blocks ?? []).map((block, index) => ({ key: `${padded(index)}:${block.id}`, value: block }));
        revisionOrDigest = sceneScriptFence(production, sceneId);
        break;
      }
      case "get_scene_shots": {
        assertArgs(args, ["productionId", "sceneId"]);
        const productionId = requireString(args, "productionId");
        const sceneId = requireString(args, "sceneId");
        const scene = sceneOf(productionOf(bundle, productionId), sceneId);
        const shots = scene ? orderedShots(scene) : [];
        readTarget = target("shots", `${sceneTargetId(productionId, sceneId)}:shots`);
        rows = shots.map((shot, index) => ({ key: `${padded(index)}:${shot.id}`, value: shot }));
        revisionOrDigest = fence(shots, scene?.version ?? "absent");
        break;
      }
      case "get_scene_stage": {
        assertArgs(args, ["productionId", "sceneId"]);
        const productionId = requireString(args, "productionId");
        const sceneId = requireString(args, "sceneId");
        const scene = sceneOf(productionOf(bundle, productionId), sceneId);
        readTarget = target("stage", `${sceneTargetId(productionId, sceneId)}:stage`);
        rows = scene
          ? [
              { key: "blocking", value: { kind: "scene-blocking", blocking: scene.blocking ?? null } },
              ...orderedShots(scene).map((shot, index) => ({ key: `shot:${padded(index)}:${shot.id}`, value: { kind: "shot-staging", shotId: shot.id, staging: shot.staging ?? null } })),
            ]
          : [];
        revisionOrDigest = fence(rows.map((row) => row.value), scene?.version ?? "absent");
        break;
      }
      case "get_scene_boards": {
        assertArgs(args, ["productionId", "sceneId"]);
        const productionId = requireString(args, "productionId");
        const sceneId = requireString(args, "sceneId");
        const scene = sceneOf(productionOf(bundle, productionId), sceneId);
        readTarget = target("boards", `${sceneTargetId(productionId, sceneId)}:boards`);
        rows = scene ? [{ key: "boards", value: { controls: scene.boards ?? null, board: scene.board ?? null, storyboard: scene.storyboard ?? null } }] : [];
        revisionOrDigest = fence(rows.map((row) => row.value), scene?.version ?? "absent");
        break;
      }
      case "list_takes": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const production = productionOf(bundle, productionId);
        readTarget = target("takes", productionId);
        rows = [
          ...(production?.takes ?? []).map((take) => ({ key: `take:${take.id}`, value: { kind: "take", take, mediaInfo: production?.takeMediaInfo[take.id] ?? null } })),
          ...(production?.reviews ?? []).map((review, index) => ({ key: `review:${review.ts}:${padded(index)}`, value: { kind: "review", review } })),
          ...Object.entries(production?.selections ?? {}).map(([shotId, selection]) => ({ key: `selection:${shotId}`, value: { kind: "selection", shotId, selection } })),
        ].sort((a, b) => a.key.localeCompare(b.key));
        revisionOrDigest = fence(rows.map((row) => row.value));
        break;
      }
      case "get_timeline": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const production = productionOf(bundle, productionId);
        readTarget = target("timeline", productionId);
        const state = production?.timeline ?? { status: "absent" as const };
        if (state.status !== "ready") {
          rows = [{ key: "state", value: state }];
        } else {
          const timeline = state.timeline;
          const tracks = [...timeline.tracks].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
          rows = [
            { key: "00:timeline", value: { kind: "timeline", revision: timeline.revision, frameRate: timeline.frameRate, mix: timeline.mix, migratedCut: timeline.migratedCut ?? false } },
            ...timeline.library.map((item, index) => ({ key: `10:library:${padded(index)}:${item.kind}:${item.kind === "shot" ? item.shotId : item.artifactId}`, value: { kind: "library-item", item } })),
            ...tracks.flatMap((track, trackIndex) => [
              { key: `20:track:${padded(trackIndex)}:${track.id}`, value: { kind: "track", track: { ...track, clips: undefined, cues: undefined } } },
              ...[...track.clips].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id)).map((clip, clipIndex) => ({ key: `30:clip:${padded(trackIndex)}:${padded(clipIndex)}:${clip.id}`, value: { kind: "clip", trackId: track.id, clip } })),
              ...(track.cues ?? []).map((cue, cueIndex) => ({ key: `40:cue:${padded(trackIndex)}:${padded(cueIndex)}:${cue.id}`, value: { kind: "cue", trackId: track.id, cue } })),
            ]),
            ...(production?.takes ?? []).map((take) => ({ key: `50:take:${take.id}`, value: { kind: "available-take", take, mediaInfo: production?.takeMediaInfo[take.id] ?? null } })),
          ];
        }
        revisionOrDigest = timelineFence(production);
        break;
      }
      case "get_spine": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const spine = productionOf(bundle, productionId)?.spine;
        readTarget = target("spine", productionId);
        rows = spine
          ? [
              { key: "metadata", value: { schemaVersion: spine.schemaVersion, revision: spine.revision, trackArtifactId: spine.trackArtifactId, updatedAt: spine.updatedAt } },
              ...spine.markers.map((marker, index) => ({ key: `marker:${padded(index)}:${marker.id}`, value: marker })),
              ...Object.entries(spine.anchors).sort(([a], [b]) => a.localeCompare(b)).map(([shotId, anchor]) => ({ key: `anchor:${shotId}`, value: { shotId, anchor } })),
            ]
          : [];
        revisionOrDigest = fence(spine ?? null, spine?.revision ?? "absent");
        break;
      }
      case "get_routing": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const routing = productionOf(bundle, productionId)?.routing;
        readTarget = target("routing", productionId);
        rows = routing
          ? [
              { key: "metadata", value: { version: routing.version, start: routing.start } },
              ...routing.choices.map((choice, index) => ({ key: `choice:${padded(index)}:${choice.id}`, value: { kind: "choice", choice } })),
              ...routing.endings.map((ending, index) => ({ key: `ending:${padded(index)}:${ending.sceneId}`, value: { kind: "ending", ending } })),
              ...routing.excluded.map((excluded, index) => ({ key: `excluded:${padded(index)}:${excluded.sceneId}`, value: { kind: "excluded", excluded } })),
              ...routing.groups.map((group, index) => ({ key: `group:${padded(index)}:${group.id}`, value: { kind: "group", group } })),
            ]
          : [];
        revisionOrDigest = fence(routing ?? null, routing?.version ?? "absent");
        break;
      }
      case "list_plans": {
        assertArgs(args, ["productionId"]);
        const productionId = requireString(args, "productionId");
        const plans = this.deps.getPlans ? await this.deps.getPlans(productionId) : [];
        readTarget = target("plans", productionId);
        rows = [...plans].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.planId.localeCompare(b.planId)).map((plan) => ({ key: `${plan.createdAt}:${plan.planId}`, value: plan }));
        revisionOrDigest = fence(plans);
        break;
      }
      case "list_jobs": {
        assertArgs(args, ["productionId"]);
        const productionId = optionalString(args, "productionId");
        const jobs = (this.deps.getJobs?.() ?? []).filter((job) =>
          job.worldId === lease.worldId && (productionId === undefined || job.productionId === productionId));
        readTarget = target("jobs", productionId ?? lease.worldId);
        rows = [...jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((job) => ({ key: `${job.createdAt}:${job.id}`, value: safeJob(job) }));
        revisionOrDigest = fence(rows.map((row) => row.value));
        break;
      }
      case "list_exports": {
        assertArgs(args, ["productionId"]);
        const productionId = optionalString(args, "productionId");
        const exports = (await this.deps.getExports?.() ?? []).filter((entry) =>
          entry.worldId === lease.worldId && (productionId === undefined || entry.productionId === productionId));
        readTarget = target("exports", productionId ?? lease.worldId);
        rows = [...exports].sort((a, b) => a.id.localeCompare(b.id)).map((entry) => ({
          key: entry.id,
          value: {
            id: entry.id,
            worldId: entry.worldId,
            ...(entry.productionId !== undefined ? { productionId: entry.productionId } : {}),
            ...(entry.episodeId !== undefined ? { episodeId: entry.episodeId } : {}),
            status: entry.status,
            ...(entry.percent !== undefined ? { percent: entry.percent } : {}),
            ...(entry.output !== undefined ? { output: safeExportOutput(entry.output) } : {}),
            ...(entry.error !== undefined ? { error: entry.error === null ? null : "export failed" } : {}),
          },
        }));
        revisionOrDigest = fence(rows.map((row) => row.value));
        break;
      }
    }

    return this.page(lease, args, readTarget, revisionOrDigest, rows);
  }

  private page(
    lease: QueryLease,
    args: Record<string, unknown>,
    readTarget: ArkeReadTarget,
    revisionOrDigest: string,
    rows: readonly Row[],
  ): TargetReadOutcome {
    const cursor = args["cursor"] as string | undefined;
    let start = 0;
    if (cursor !== undefined) {
      const decoded = this.decodeCursor(lease, cursor);
      if (
        decoded.runId !== lease.runId ||
        decoded.requirement !== readTarget.requirement ||
        decoded.targetId !== readTarget.id
      ) {
        throw new TargetReadError("that cursor belongs to a different target");
      }
      if (decoded.fence !== revisionOrDigest) {
        throw new TargetReadError("that target changed while it was being read; start again without a cursor");
      }
      const found = rows.findIndex((row) => row.key === decoded.after);
      if (found < 0) throw new TargetReadError("that cursor no longer identifies a row in this target");
      start = found + 1;
    }

    const limit = boundedLimit(args["limit"]);
    const selected = rows.slice(start, start + limit);
    const hasMore = start + selected.length < rows.length;
    const nextCursor = hasMore
      ? this.encodeCursor(lease, {
          version: 1,
          runId: lease.runId,
          requirement: readTarget.requirement,
          targetId: readTarget.id,
          fence: revisionOrDigest,
          after: selected.at(-1)!.key,
        })
      : null;
    const result: ArkeTargetReadPage = {
      target: readTarget,
      observedRevisionOrDigest: revisionOrDigest,
      items: selected.map((row) => row.value),
      total: rows.length,
      nextCursor,
      complete: nextCursor === null,
    };
    return { result, status: rows.length === 0 ? "empty" : "complete" };
  }

  private encodeCursor(lease: QueryLease, payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", lease.token).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private decodeCursor(lease: QueryLease, cursor: string): CursorPayload {
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra !== undefined) throw new TargetReadError("that cursor is not valid");
    const expected = createHmac("sha256", lease.token).update(body).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      throw new TargetReadError("that cursor is not valid");
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new TargetReadError("that cursor is not valid");
    }
    try {
      const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
      if (
        parsed.version !== 1 ||
        typeof parsed.runId !== "string" ||
        typeof parsed.requirement !== "string" ||
        typeof parsed.targetId !== "string" ||
        typeof parsed.fence !== "string" ||
        typeof parsed.after !== "string"
      ) {
        throw new Error("invalid cursor fields");
      }
      return parsed;
    } catch {
      throw new TargetReadError("that cursor is not valid");
    }
  }
}
