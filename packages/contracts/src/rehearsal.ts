import { z } from "zod";
import { IsoDateTimeSchema, SceneIdSchema, prefixedIdSchema } from "./ids.js";
import { FullSha256Schema } from "./audio.js";
import { orderedShots, type SceneRecord } from "./scene-flow.js";
import { resolvePerformanceLine, performanceLineKey } from "./performance.js";
import type { Sheet } from "./world.js";

export const RehearsalIdSchema = prefixedIdSchema("rh");
export const RehearsalSessionSchema = z.object({ id: RehearsalIdSchema, sceneId: SceneIdSchema,
  sceneVersionAtStart: z.number().int().positive(), notes: z.record(z.string().min(1).max(300), z.object({
    authoredTextHash: FullSha256Schema, body: z.string().trim().min(1).max(4000),
  }).strict()).default({}), createdAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema }).strict();
export type RehearsalSession = z.infer<typeof RehearsalSessionSchema>;
export interface RehearsalLine { id: string; shotId: string; blockId?: string; speakerSheetId?: string; text: string; reason?: string }
/** Authored shot order, then covered script order. A block covered by multiple shots is read once. */
export function deriveRehearsalLines(scene: SceneRecord, sheets: readonly Pick<Sheet, "id" | "type" | "retired">[]): RehearsalLine[] {
  const lines: RehearsalLine[] = [], seen = new Set<string>();
  for (const shot of orderedShots(scene)) {
    const blocks = shot.covers?.length ? scene.script?.blocks.filter(b => b.kind === "dialogue" && shot.covers?.some(c => c.blockId === b.id)) ?? [] : [];
    const missingCoverage = shot.covers?.some(c => !scene.script?.blocks.some(b => b.id === c.blockId));
    if (!shot.covers?.length && !["vo", "dialogue"].includes(shot.audio?.kind ?? "")) continue;
    if (shot.covers?.length && !blocks.length && !missingCoverage) continue;
    for (const blockId of blocks.length ? blocks.map(b => b.id) : [undefined]) {
      if (blockId && seen.has(blockId)) continue;
      if (blockId) seen.add(blockId);
      const result = resolvePerformanceLine(scene, shot.id, blockId);
      const id = performanceLineKey({ sceneId: scene.id, shotId: shot.id, ...(blockId ? { blockId } : {}) });
      if (!result.ok) { lines.push({ id, shotId: shot.id, ...(blockId ? { blockId } : {}), text: "", reason: result.reason }); continue; }
      const speaker = sheets.find(s => s.id === result.speakerSheetId && s.type === "character" && !s.retired);
      lines.push({ id, shotId: shot.id, ...(blockId ? { blockId } : {}), speakerSheetId: result.speakerSheetId, text: result.text,
        ...(!speaker ? { reason: "This line has no available character speaker." } : {}) });
    }
  }
  return lines;
}

export const TableReadPlanSchema = z.object({ productionId: z.string().min(1), sceneId: SceneIdSchema, sceneVersion: z.number().int().positive(),
  confirmationToken: FullSha256Schema, totalEstimatedMicroUsd: z.number().int().nonnegative(),
  items: z.array(z.object({ lineId: z.string().min(1), shotId: z.string().min(1), blockId: z.string().optional(), speakerSheetId: z.string().optional(),
    route: z.enum(["existing", "cached", "local", "cloud", "generating", "unavailable"]), file: z.string().optional(),
    textHash: FullSha256Schema.optional(), performanceId: z.string().optional(), sourceHash: FullSha256Schema.optional(), provider: z.string().optional(), model: z.string().optional(),
    voiceId: z.string().optional(), estimatedMicroUsd: z.number().int().nonnegative(), reason: z.string().optional() }).strict()),
}).strict();
export type TableReadPlan = z.infer<typeof TableReadPlanSchema>;
