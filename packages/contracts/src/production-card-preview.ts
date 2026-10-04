import { z } from "zod";
import { SceneRecordSchema, orderedShots } from "./scene-flow.js";
import type { SceneRecord } from "./scene-flow.js";
import type { ConversationActionRecord } from "./arke-actions.js";
import { ProductionTimelineSchema, type ProductionTimeline } from "./timeline.js";
import { SelectionsSchema, type ShotSelection } from "./scene.js";

/** Frozen review content is part of the approval digest (SPEC-051 R-50..R-55). */
export const PRODUCTION_CARD_PREVIEW_SCHEMA_VERSION = 62;
export const PRODUCTION_TIMELINE_CARD_SCHEMA_VERSION = 63;
// Spelled out and annotated (TS7056): inferred, this union carried the whole scene record into every
// schema that holds a card, and the engine's declaration bundle refused WorldChatLoadedSchema as too
// long to serialize, which stopped the desktop build.
export type ProductionCardPreview =
  | {
      kind: "production"; title: string; medium: string; productionKind: string;
      aspect: string | null; frameRate: number; series: string | null;
      season: string | null; episodes: number;
      style: string | null; model: string | null;
    }
  | { kind: "scene"; before: SceneRecord | null; after: SceneRecord }
  | { kind: "timeline"; before: ProductionTimeline; after: ProductionTimeline;
      beforeSelections: Record<string, ShotSelection>; afterSelections: Record<string, ShotSelection>;
      range: { startFrame: number; endFrame: number } | null }
  | { kind: "export"; preset: string; durationSec: number | null; subtitles: string;
      dimensions: string; frameRate: number; scope: string };
export const ProductionCardPreviewSchema: z.ZodType<ProductionCardPreview, z.ZodTypeDef, unknown> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("production"), title: z.string(), medium: z.string(), productionKind: z.string(),
    aspect: z.string().nullable(), frameRate: z.number().positive(), series: z.string().nullable(),
    season: z.string().nullable(), episodes: z.number().int().nonnegative(),
    style: z.string().nullable(), model: z.string().nullable(),
  }).strict(),
  z.object({ kind: z.literal("scene"), before: SceneRecordSchema.nullable(), after: SceneRecordSchema }).strict(),
  z.object({ kind: z.literal("timeline"), before: ProductionTimelineSchema, after: ProductionTimelineSchema,
    beforeSelections: SelectionsSchema, afterSelections: SelectionsSchema,
    range: z.object({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().nonnegative() }).strict().nullable(),
  }).strict(),
  z.object({ kind: z.literal("export"), preset: z.string(), durationSec: z.number().nonnegative().nullable(), subtitles: z.string(),
    dimensions: z.string(), frameRate: z.number().positive(), scope: z.string() }).strict(),
]);

export function shotChanges(before: SceneRecord | null, after: SceneRecord) {
  const old = before ? orderedShots(before) : [];
  const next = orderedShots(after);
  const byId = new Map(old.map((shot, index) => [shot.id, { shot, index }]));
  return {
    shots: next.map((shot, index) => {
      const previous = byId.get(shot.id);
      const { number: _oldNumber, ...oldContent } = previous?.shot ?? shot;
      const { number: _newNumber, ...content } = shot;
      return { shot, from: previous ? previous.index + 1 : null,
        inserted: !previous, moved: !!previous && previous.index !== index,
        changed: !!previous && JSON.stringify(oldContent) !== JSON.stringify(content) };
    }),
    removed: old.filter(shot => !next.some(current => current.id === shot.id)),
  };
}

/** Pure visual marks over the authority's frozen clip and selection records. */
export function timelineReviewMarks(preview: Extract<ProductionCardPreview, { kind: "timeline" }>) {
  const records = (timeline: ProductionTimeline) => new Map(timeline.tracks.flatMap(track => track.clips.map(clip => [clip.id, { track: track.id, clip }] as const)));
  const before = records(preview.before), after = records(preview.after);
  const oldMarks = new Map<string, string>(), newMarks = new Map<string, string>();
  for (const [id, value] of before) {
    if (!after.has(id)) oldMarks.set(id, "removed");
    else if (JSON.stringify(value) !== JSON.stringify(after.get(id))) { oldMarks.set(id, "changed"); newMarks.set(id, "changed"); }
  }
  for (const [id, value] of after) {
    if (!before.has(id)) newMarks.set(id, "inserted");
    const source = value.clip.source;
    if (before.has(id) && source.kind === "shot" && JSON.stringify(preview.beforeSelections[source.shotId]) !== JSON.stringify(preview.afterSelections[source.shotId])) {
      oldMarks.set(id, "changed"); newMarks.set(id, "changed");
    }
  }
  return { before: oldMarks, after: newMarks };
}

/** A family label alone cannot authorise a group gesture: commands can also export or delete. */
export function groupApprovalEligible(action: ConversationActionRecord): boolean {
  if (!["authored-diff", "command"].includes(action.cardFamily) || action.shown.body.family !== action.cardFamily ||
      action.shown.permissionReason !== "authored-change" || action.approvalBlockedReason) return false;
  const preview = action.shown.productionPreview;
  if (action.actionKind === "world-chat-production-create" || action.actionKind === "world-chat-production-metadata") {
    return preview?.kind === "production" && action.authority.kind === "production-store";
  }
  if (action.actionKind === "world-chat-production-scene-command" || action.actionKind === "world-chat-production-scene") {
    return preview?.kind === "scene" && action.authority.kind === (action.actionKind === "world-chat-production-scene" ? "proposal-manager" : "scene-store") && !shotChanges(preview.before, preview.after).removed.length;
  }
  // These registered authorities have no spend, host, export, privacy or deletion branch.
  return ["rename-world", "world-chat-bible-edit", "world-chat-scene-edit"].includes(action.actionKind);
}

export function dependencyOrder<T extends { actionId: string; dependencies: readonly string[] }>(actions: readonly T[]): T[] {
  const remaining = [...actions], result: T[] = [];
  const ids = new Set(actions.map(action => action.actionId));
  while (remaining.length) {
    const index = remaining.findIndex(action => action.dependencies.every(id => !ids.has(id) || result.some(one => one.actionId === id)));
    if (index < 0) throw new Error("The card group has a dependency cycle.");
    result.push(remaining.splice(index, 1)[0]!);
  }
  return result;
}
