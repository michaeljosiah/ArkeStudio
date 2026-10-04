import { z } from "zod";
import { SceneRecordSchema, orderedShots } from "./scene-flow.js";
import type { SceneRecord } from "./scene-flow.js";
import type { ConversationActionRecord } from "./arke-actions.js";

/** Frozen review content is part of the approval digest (SPEC-051 R-50..R-55). */
export const PRODUCTION_CARD_PREVIEW_SCHEMA_VERSION = 62;
export const ProductionCardPreviewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("production"), title: z.string(), medium: z.string(), productionKind: z.string(),
    aspect: z.string().nullable(), frameRate: z.number().positive(), series: z.string().nullable(),
    season: z.string().nullable(), episodes: z.number().int().nonnegative(),
    style: z.string().nullable(), model: z.string().nullable(),
  }).strict(),
  z.object({ kind: z.literal("scene"), before: SceneRecordSchema.nullable(), after: SceneRecordSchema }).strict(),
]);
export type ProductionCardPreview = z.infer<typeof ProductionCardPreviewSchema>;

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
